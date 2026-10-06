import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { requestLogger } from "./src/infrastructure/logging/requestLogger.js";
import { createLogger, LogErrorCodes } from "./src/infrastructure/logging/index.js";

const systemLogger = createLogger("system");

import apiRouter from "./src/api/routes.js";
import { walletService } from "./src/container.js";
import { bootstrapV2 } from "./src/v2/bootstrap.js";
import { requireAuth } from "./src/middleware/auth.js";
import { rateLimit } from "./src/middleware/rateLimit.js";
import { waitForRateLimitRedis } from "./src/queue/redis.js";

bootstrapV2();

const app = express();
const PORT = process.env.PORT || 3001;

// ── Proxy Trust Configuration ────────────────────────────────
// Configurable via TRUST_PROXY env var; defaults safe to false (direct connection).
// When behind a reverse proxy (e.g. AWS ALB, Nginx, Cloudflare), set TRUST_PROXY=1.
const isProd = process.env.NODE_ENV === "production";
const isStagingOrProd = isProd || process.env.NODE_ENV === "staging";

if (process.env.TRUST_PROXY !== undefined && process.env.TRUST_PROXY !== "") {
    const rawTrust = process.env.TRUST_PROXY;
    if (rawTrust === "true") app.set("trust proxy", true);
    else if (rawTrust === "false") app.set("trust proxy", false);
    else if (!isNaN(Number(rawTrust))) app.set("trust proxy", Number(rawTrust));
    else app.set("trust proxy", rawTrust);
} else {
    app.set("trust proxy", false);
    if (isProd) {
        systemLogger.warn({
            event: "boot.warning",
            trustProxy: false,
        }, "TRUST_PROXY is unset in production: all clients will share one rate-limit bucket if behind a proxy");
    }
}

if (isStagingOrProd) {
    systemLogger.info({
        event: "boot.config",
        effectiveTrustProxy: app.get("trust proxy"),
    }, `Server proxy trust configured: ${app.get("trust proxy")}`);
}

// ── Middleware ──────────────────────────────────────────────
const allowedOrigins = [
    process.env.FRONTEND_URL ? process.env.FRONTEND_URL.replace(/\/$/, '') : null,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001", // In case Next.js moved to 3001
    "http://127.0.0.1:3001"
].filter(Boolean);

app.use(
    cors({
        origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        credentials: true,
    })
);
// Payments webhook raw body parser MUST be mounted before any JSON parser
app.use("/api/payments/webhook", express.raw({ type: "application/json" }));

// Cookie parser (lightweight header parsing only, zero body buffering, needed for JWT auth)
app.use(cookieParser());
app.use(requestLogger());

// Defense-in-depth: Ensure all responses have nosniff to prevent MIME type sniffing attacks
app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
});

// ── Body Size Parsers: Scoped 30MB for base64/media ingestion, Global 1MB for all others ──
const scopedJsonParser = express.json({ limit: "30mb" });
const scopedUrlencodedParser = express.urlencoded({ extended: true, limit: "30mb" });
const globalJsonParser = express.json({ limit: "1mb" });
const globalUrlencodedParser = express.urlencoded({ extended: true, limit: "1mb" });
const scopedLargeBodyLimiter = rateLimit("scopedLargeBodyIp");

export function normalizeRoutePath(rawPath) {
    if (!rawPath || typeof rawPath !== "string") return "/";
    let p = rawPath.split("?")[0].split("#")[0];
    try {
        p = decodeURIComponent(p);
    } catch {
        // Fallback to raw if decodeURIComponent fails
    }
    // Collapse consecutive slashes
    p = p.replace(/\/+/g, "/");
    // Lowercase
    p = p.toLowerCase();
    // Strip trailing slash if path is longer than 1 char
    if (p.length > 1 && p.endsWith("/")) {
        p = p.replace(/\/+$/, "");
    }
    return p;
}

const EXACT_LARGE_BODY_ROUTES = new Set([
    "/api/assets/upload",
    "/api/media/ingest",
    "/api/characters",
    "/api/characters/create",
    "/api/characters/character",
    "/api/v2/elements",
]);

const PARAM_LARGE_BODY_ROUTES = [
    /^\/api\/characters\/[^/]+\/media$/,
    /^\/api\/characters\/[^/]+\/sheet-media$/,
    /^\/api\/characters\/[^/]+\/upload$/,
    /^\/api\/v2\/elements\/[^/]+\/images$/,
];

export function isScopedLargeBodyRoute(path) {
    if (!path) return false;
    const normalized = normalizeRoutePath(path);
    if (EXACT_LARGE_BODY_ROUTES.has(normalized)) return true;
    for (const pattern of PARAM_LARGE_BODY_ROUTES) {
        if (pattern.test(normalized)) return true;
    }
    return false;
}

app.use((req, res, next) => {
    const rawPath = req.originalUrl?.split("?")[0] || req.path;
    const normalized = normalizeRoutePath(rawPath);
    if (normalized === "/api/payments/webhook") {
        return next();
    }
    if (isScopedLargeBodyRoute(rawPath)) {
        // Enforce IP rate limiting and authentication BEFORE buffering/parsing 30MB payload
        return scopedLargeBodyLimiter(req, res, (limiterErr) => {
            if (limiterErr) return next(limiterErr);
            requireAuth(req, res, (authErr) => {
                if (authErr) return next(authErr);
                scopedJsonParser(req, res, (jsonErr) => {
                    if (jsonErr) return next(jsonErr);
                    scopedUrlencodedParser(req, res, next);
                });
            });
        });
    }

    // Global 1MB parser for standard routes
    globalJsonParser(req, res, (err) => {
        if (err) return next(err);
        globalUrlencodedParser(req, res, next);
    });
});

// ── Routes ──────────────────────────────────────────────────
app.use("/api", apiRouter);

// ── 404 handler ─────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ ok: false, message: "Route not found" });
});

// ── Global error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
    // 413 Payload Too Large / Multer LIMIT_FILE_SIZE handling
    if (err.type === "entity.too.large" || err.statusCode === 413 || err.status === 413 || err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
            ok: false,
            code: "PAYLOAD_TOO_LARGE",
            message: err.code === "LIMIT_FILE_SIZE" ? "Uploaded file exceeds maximum allowed size" : "Request payload exceeds allowed limit",
        });
    }

    const statusCode = err.statusCode || 500;
    const errorCode = err.code || (statusCode >= 500 ? LogErrorCodes.INTERNAL_UNEXPECTED_ERROR : "REQUEST_ERROR");

    if (statusCode >= 500) {
        systemLogger.error({
            event: "http.error",
            errorCode,
            statusCode,
            err,
        }, `${statusCode} - ${err.message}`);
    } else {
        systemLogger.warn({
            event: "http.warning",
            errorCode,
            statusCode,
            err: { message: err.message, code: errorCode },
        }, `${statusCode} - ${err.message}`);
    }

    res.status(statusCode).json({
        ok: false,
        status: err.status || 'error',
        message: err.message || "Internal Server Error",
    });
});

// ── Start server ─────────────────────────────────────────────
if (process.env.NODE_ENV !== "test") {
    const isRedisLimiter = (process.env.RATE_LIMIT_STORE || "").trim().toLowerCase() === "redis";
    if (isRedisLimiter) {
        systemLogger.info({ event: "boot.redis_wait" }, "Waiting for rate-limit Redis connection to become ready...");
        await waitForRateLimitRedis(5000);
    }

    app.listen(PORT, () => {
    const appName = process.env.APP_NAME || "Labveil";
    systemLogger.info({ port: PORT, appName }, `${appName} API running on http://localhost:${PORT}`);

    // ── Start Cron Jobs ──────────────────────────────────────────
        if (walletService) {
            setInterval(() => {
                walletService.expireStaleHolds().catch(err => {
                    systemLogger.error({ err, event: "cron.error" }, `Failed to expire stale holds: ${err.message}`);
                });
            }, 10 * 60 * 1000); // Every 10 minutes
            systemLogger.info({ intervalMinutes: 10 }, "Started Stale Holds expiration cron job (runs every 10m)");
        }
    });
}

export default app;
