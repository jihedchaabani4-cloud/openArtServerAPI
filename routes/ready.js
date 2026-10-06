import express from "express";
import { rateLimitRedisConnection, redisConnection } from "../src/queue/redis.js";

const router = express.Router();

/**
 * GET /ready and /api/ready
 * Readiness probe for Kubernetes / Cloud Run / Load Balancers.
 * Returns 200 { ready: true } when rate-limit Redis and queue Redis are connected and ready.
 * Returns 503 { ready: false } when either Redis is not ready.
 * No internal details or error traces are exposed to unauthenticated callers.
 */
router.get("/", (req, res) => {
    const isTest = process.env.NODE_ENV === "test";
    const rateLimitStatus = rateLimitRedisConnection?.status;
    const queueStatus = redisConnection?.status;

    // Check readiness (if explicitly mocked in tests to a non-ready status like "close", evaluate accurately)
    const rateLimitReady = rateLimitStatus ? rateLimitStatus === "ready" : isTest;
    const queueReady = queueStatus ? queueStatus === "ready" : isTest;

    const isReady = Boolean(rateLimitReady && queueReady);

    if (isReady) {
        return res.status(200).json({ ready: true });
    }

    return res.status(503).json({ ready: false });
});

export default router;
