import { supabase } from "../../lib/supabase.js";
import { AppError } from "../utils/AppError.js";
import { setContext, createLogger } from "../infrastructure/logging/index.js";
import { safeCompareSecret } from "../platform/security/secretComparison.js";

const authLogger = createLogger("auth");

/**
 * Exact allowed method + path pairs for internal secret S2S caller (ElementVisionService).
 * Strictly requires INTERNAL_AUTH_ENABLED === "true".
 * Never allows generation, billing, characters or element-write routes.
 */
const INTERNAL_SECRET_ALLOWED_METHOD_PATH_PAIRS = [
    { method: "GET", pattern: /^\/api\/workflows\/project-data\/[A-Za-z0-9_-]+$/, route: "/api/workflows/project-data/:projectId" },
    { method: "PATCH", pattern: /^\/api\/workflows\/workflows\/[A-Za-z0-9_-]+$/, route: "/api/workflows/workflows/:id" },
];

export function isInternalSecretAllowedRequest(req) {
    if (process.env.INTERNAL_AUTH_ENABLED !== "true") {
        return false;
    }
    const method = req?.method?.toUpperCase();
    const rawPath = (req?.originalUrl || req?.url || req?.path || "").split("?")[0];
    if (!rawPath || typeof rawPath !== "string") return false;

    // Strict regex disallows trailing slash, traversal segments (.. or %2e)
    if (rawPath.length > 1 && rawPath.endsWith("/")) return false;
    if (rawPath.includes("..") || rawPath.toLowerCase().includes("%2e") || rawPath.toLowerCase().includes("%2f")) return false;

    return INTERNAL_SECRET_ALLOWED_METHOD_PATH_PAIRS.some(
        (pair) => pair.method === method && pair.pattern.test(rawPath)
    );
}

export function isInternalSecretAllowedRoute(rawPath, method = "GET") {
    return isInternalSecretAllowedRequest({ method, path: rawPath, originalUrl: rawPath });
}

/**
 * Middleware to strictly authenticate users using Supabase Auth.
 * Blocks the request with 401 Unauthorized if token is missing or invalid.
 */
export const requireAuth = async (req, res, next) => {
    // If request has already been authenticated (e.g. by index.js pre-parser), short-circuit
    if (req.user?.id) {
        setContext({ userId: req.user.id });
        return next();
    }

    // S2S internal secret check:
    // Only processed if INTERNAL_AUTH_ENABLED === "true" and secret header is provided.
    const internalSecret = req.headers?.["x-internal-secret"];
    if (process.env.INTERNAL_AUTH_ENABLED === "true" && internalSecret) {
        const method = req?.method?.toUpperCase();
        const rawPath = (req?.originalUrl || req?.url || req?.path || "").split("?")[0];
        const isPathClean = !(
            (rawPath.length > 1 && rawPath.endsWith("/")) ||
            rawPath.includes("..") ||
            rawPath.toLowerCase().includes("%2e") ||
            rawPath.toLowerCase().includes("%2f")
        );

        const matchedPair = isPathClean
            ? INTERNAL_SECRET_ALLOWED_METHOD_PATH_PAIRS.find(
                  (pair) => pair.method === method && pair.pattern.test(rawPath)
              )
            : null;

        if (!matchedPair) {
            authLogger.warn(
                { event: "auth.internal_secret_rejected", reason: "not_allowed", method, route: rawPath },
                "Internal secret rejected: method or path not allowed"
            );
        } else if (!safeCompareSecret(internalSecret, process.env.INTERNAL_SECRET)) {
            authLogger.warn(
                { event: "auth.internal_secret_rejected", reason: "bad_secret", method, route: matchedPair.route },
                "Internal secret rejected: invalid secret"
            );
        } else {
            const headerUserId = req.headers?.["x-user-id"];
            if (typeof headerUserId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(headerUserId)) {
                req.user = { id: headerUserId };
                setContext({ userId: headerUserId });
                authLogger.info(
                    { event: "auth.internal_secret_used", route: matchedPair.route, method, userId: headerUserId },
                    "Internal secret authentication accepted"
                );
                return next();
            } else {
                authLogger.warn(
                    { event: "auth.internal_secret_rejected", reason: "invalid_user_id", method, route: matchedPair.route },
                    "Internal secret rejected: invalid user id format"
                );
            }
        }
    }

    try {
        let token = req.cookies?.access_token;
        const refreshToken = req.cookies?.refresh_token;

        // Allow Authorization: Bearer <token> header for API clients (preferred)
        const authHeader = req.headers?.authorization || req.headers?.Authorization;
        if (!token && authHeader && typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
            token = authHeader.split(" ")[1].trim();
        }

        if (!token && !refreshToken) {
            authLogger.debug({ event: "auth.failed", path: req.path }, "Rejecting because no tokens found in cookies or headers");
            return next(new AppError("Authentication required. Please log in.", 401));
        }

        let user = null;

        // Try using the access token first
        if (token) {
            const { data, error } = await supabase.auth.getUser(token);
            if (!error && data?.user) {
                user = data.user;
            }
        }

        // If access token is missing or expired, try to refresh
        if (!user && refreshToken) {
            const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession({ 
                refresh_token: refreshToken 
            });

            if (refreshError || !refreshData?.session) {
                // Clear invalid cookies
                res.clearCookie("access_token");
                res.clearCookie("refresh_token");
                return next(new AppError("Session expired. Please log in again.", 401));
            }

            user = refreshData.user;
            
            // Set new cookies in the response
            res.cookie("access_token", refreshData.session.access_token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "Lax",
                maxAge: 3600 * 1000, // 1 hour
            });

            res.cookie("refresh_token", refreshData.session.refresh_token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "Lax",
                maxAge: 30 * 24 * 3600 * 1000, // 30 days
            });
        }

        if (!user) {
            authLogger.warn({ event: "auth.failed", path: req.path }, "Invalid or expired authentication token");
            return next(new AppError("Invalid or expired authentication token.", 401));
        }

        // Pass user ID in the request and bind to LogContext
        req.user = { id: user.id };
        setContext({ userId: user.id });
        authLogger.debug({ event: "auth.verified", userId: user.id }, `User ${user.id} authenticated`);
        next();
    } catch (err) {
        authLogger.error({ event: "auth.failed", err }, `Authentication process failed: ${err.message}`);
        next(new AppError("Authentication process failed", 500));
    }
};
