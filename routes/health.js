import express from "express";
import { rateLimitRedisConnection, redisConnection } from "../src/queue/redis.js";

const router = express.Router();

// GET /api/health and /health
router.get("/", (req, res) => {
    const appName = process.env.APP_NAME || "Labveil";
    const rateLimitStatus = rateLimitRedisConnection?.status || "disconnected";
    const queueStatus = redisConnection?.status || "disconnected";
    const isTest = process.env.NODE_ENV === "test";

    const rateLimitReady = isTest || rateLimitStatus === "ready";
    const queueReady = isTest || queueStatus === "ready";

    res.json({
        ok: true,
        status: (rateLimitReady && queueReady) ? "healthy" : "degraded",
        message: `${appName} API is running 🎨`,
        redis: {
            rateLimit: {
                status: rateLimitStatus,
                ready: rateLimitReady,
            },
            queue: {
                status: queueStatus,
                ready: queueReady,
            },
        },
    });
});

export default router;
