import express from "express";
import { rateLimitRedisConnection, redisConnection } from "../src/queue/redis.js";
import { createLogger } from "../src/infrastructure/logging/index.js";

const router = express.Router();
const readyLogger = createLogger("ready");

let cachedStatus = null;

function getReadinessTimeoutMs() {
    return parseInt(process.env.READINESS_TIMEOUT_MS, 10) || 1500;
}

function getReadinessCacheTtlMs() {
    return parseInt(process.env.READINESS_CACHE_TTL_MS, 10) || 1500;
}

export function _resetReadinessCacheForTest() {
    cachedStatus = null;
}

/**
 * GET /ready and /api/ready
 * Readiness probe for Kubernetes / Cloud Run / Load Balancers.
 * Returns 200 { ready: true } when rate-limit Redis and queue Redis are connected and ready.
 * Returns 503 { ready: false } when either Redis is not ready.
 * Short timeout (1000-2000 ms via READINESS_TIMEOUT_MS) and 1 to 2 second cache (READINESS_CACHE_TTL_MS)
 * prevent frequent load-balancer probes from hammering Redis connections.
 * No internal details or error traces are exposed to unauthenticated callers.
 */
router.get("/", async (req, res) => {
    try {
        const now = Date.now();
        const cacheTtlMs = getReadinessCacheTtlMs();
        if (cachedStatus && (now - cachedStatus.timestamp) < cacheTtlMs) {
            if (cachedStatus.ready) {
                return res.status(200).json({ ready: true });
            }
            return res.status(503).json({ ready: false });
        }

        const rateLimitStatus = rateLimitRedisConnection?.status;
        const queueStatus = redisConnection?.status;

        const rateLimitReady = rateLimitStatus === "ready";
        const queueReady = queueStatus === "ready";

        let isReady = Boolean(rateLimitReady && queueReady);
        const timeoutMs = getReadinessTimeoutMs();

        if (isReady) {
            if (typeof rateLimitRedisConnection?.ping === "function") {
                await Promise.race([
                    rateLimitRedisConnection.ping(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("RateLimit Redis ping timeout")), timeoutMs))
                ]);
            }
            if (typeof redisConnection?.ping === "function") {
                await Promise.race([
                    redisConnection.ping(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Queue Redis ping timeout")), timeoutMs))
                ]);
            }
        }

        cachedStatus = { ready: isReady, timestamp: Date.now() };

        if (isReady) {
            return res.status(200).json({ ready: true });
        }

        readyLogger.warn({ event: "ready.check_failed", rateLimitReady, queueReady }, "Readiness check failed");
        return res.status(503).json({ ready: false });
    } catch (err) {
        cachedStatus = { ready: false, timestamp: Date.now() };
        readyLogger.warn({ event: "ready.check_error", err: err.message }, "Readiness check error");
        return res.status(503).json({ ready: false });
    }
});

export default router;
