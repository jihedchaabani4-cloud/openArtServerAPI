import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";

import apiRouter from "./src/api/routes.js";
import { walletService } from "./src/container.js";
import "./src/workers/worker.js";

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
app.use(morgan("dev"));

// ── Routes ──────────────────────────────────────────────────
app.use("/api", apiRouter);

// ── 404 handler ─────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ ok: false, message: "Route not found" });
});

// ── Global error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    
    // Only log the full stack trace for actual server crashes (500), not for normal 401/404 errors
    if (statusCode === 500) {
        console.error(err.stack);
    } else {
        console.warn(`[${statusCode}] ${err.message}`);
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
    console.log(`\n🚀 ${appName} API running on http://localhost:${PORT}\n`);
    
    // ── Start Cron Jobs ──────────────────────────────────────────
    if (walletService) {
        setInterval(() => {
            walletService.expireStaleHolds().catch(err => {
                console.error("[Cron] Failed to expire stale holds:", err.message);
            });
        }, 10 * 60 * 1000); // Every 10 minutes
        console.log("🕒 [Cron] Started Stale Holds expiration cron job (runs every 10m).");
    }
});

export default app;
