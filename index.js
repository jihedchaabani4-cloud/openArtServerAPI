import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { createServer } from "http";
import { initSocket } from "./websocket/socket.js";
import apiRouter from "./src/api/routes.js";

const app = express();
const httpServer = createServer(app);

// ── Initialize Services ──────────────────────────────────────
initSocket(httpServer);

// ── Graceful Shutdown ────────────────────────────────────────
async function shutdown(signal) {
    console.log(`\n[Server] ${signal} received. Shutting down gracefully...`);
    try {
        httpServer.close(() => {
            console.log("[Server] HTTP server closed.");
            process.exit(0);
        });
    } catch (err) {
        console.error("[Server] Error during shutdown:", err);
        process.exit(1);
    }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

const PORT = process.env.PORT || 3001;

// ── Middleware ──────────────────────────────────────────────
const allowedOrigins = [
    process.env.FRONTEND_URL,
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
app.use(morgan("dev"));

// ── Routes ──────────────────────────────────────────────────
app.use("/api", apiRouter);

// ── 404 handler ─────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ ok: false, message: "Route not found" });
});

// ── Global error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(err.status || 500).json({
        ok: false,
        message: err.message || "Internal Server Error",
    });
});

// ── Start server ─────────────────────────────────────────────
httpServer.listen(PORT, () => {
    console.log(`\n🚀 Open Art API running on http://localhost:${PORT}\n`);
});

export default app;
