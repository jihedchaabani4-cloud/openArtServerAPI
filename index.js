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

bootstrapV2();

const app = express();
const PORT = process.env.PORT || 3001;

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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());
app.use(requestLogger());

// ── Routes ──────────────────────────────────────────────────
app.use("/api", apiRouter);

// ── 404 handler ─────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ ok: false, message: "Route not found" });
});

// ── Global error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
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

export default app;
