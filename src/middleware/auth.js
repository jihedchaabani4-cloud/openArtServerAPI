import { supabase } from "../../lib/supabase.js";
import { AppError } from "../utils/AppError.js";
import { setContext, createLogger } from "../infrastructure/logging/index.js";

const authLogger = createLogger("auth");

/**
 * Middleware to strictly authenticate users using Supabase Auth.
 * Blocks the request with 401 Unauthorized if token is missing or invalid.
 */
export const requireAuth = async (req, res, next) => {
    // S2S internal secret check (requires explicit x-user-id header, no hardcoded defaults)
    const internalSecret = req.headers?.["x-internal-secret"];
    if (internalSecret && internalSecret === process.env.INTERNAL_SECRET) {
        const headerUserId = req.headers?.["x-user-id"];
        if (headerUserId) {
            req.user = { id: headerUserId };
            setContext({ userId: headerUserId });
            return next();
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
