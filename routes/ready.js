import express from "express";
import { rateLimitRedisConnection, redisConnection } from "../src/queue/redis.js";
import { createLogger } from "../src/infrastructure/logging/index.js";

const router = express.Router();
const readyLogger = createLogger("ready");

/**
 * GET /ready and /api/ready
 * Readiness probe for Kubernetes / Cloud Run / Load Balancers.
 * Returns 200 { ready: true } when rate-limit Redis and queue Redis are connected and ready.
 * Returns 503 { ready: false } when either Redis is not ready.
 * No internal details or error traces are exposed to unauthenticated callers.
 */
router.get("/", async (req, res) => {
    try {
        const rateLimitStatus = rateLimitRedisConnection?.status;
        const queueStatus = redisConnection?.status;

        const rateLimitReady = rateLimitStatus === "ready";
        const queueReady = queueStatus === "ready";

        let isReady = Boolean(rateLimitReady && queueReady);

        if (isReady) {
            if (typeof rateLimitRedisConnection?.ping === "function") {
                await Promise.race([
                    rateLimitRedisConnection.ping(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("RateLimit Redis ping timeout")), 1500))
                ]);
            }
            if (typeof redisConnection?.ping === "function") {
                await Promise.race([
                    redisConnection.ping(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Queue Redis ping timeout")), 1500))
                ]);
            }
        }

        if (isReady) {
            return res.status(200).json({ ready: true });
        }

        readyLogger.warn({ event: "ready.check_failed", rateLimitReady, queueReady }, "Readiness check failed");
        return res.status(503).json({ ready: false });
    } catch (err) {
        readyLogger.warn({ event: "ready.check_error", err: err.message }, "Readiness check error");
        return res.status(503).json({ ready: false });
    }
});

export default router;
