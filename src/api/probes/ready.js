import express from "express";
import { rateLimitRedisConnection, redisConnection, createLogger, envConfig } from "#shared";

const router = express.Router();
const readyLogger = createLogger("ready");

let cachedStatus = null;

function getReadinessTimeoutMs() {
    return envConfig.readinessTimeoutMs;
}

function getReadinessCacheTtlMs() {
    return envConfig.readinessCacheTtlMs;
}

export function _resetReadinessCacheForTest() {
    cachedStatus = null;
}

/**
 * GET /ready and /api/ready
 * Readiness probe for Kubernetes / Cloud Run / Load Balancers.
 * Returns 200 { ready: true } when rate-limit Redis and queue Redis are connected and ready.
 * Returns 503 { ready: false } when either Redis is not ready.
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
