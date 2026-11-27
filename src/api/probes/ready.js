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

function isRedisRateLimitStore() {
    return (envConfig.rateLimitStore || "").trim().toLowerCase() === "redis";
}

async function pingWithTimeout(connection, label, timeoutMs) {
    let timer = null;
    try {
        await Promise.race([
            connection.ping(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} ping timeout`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export function _resetReadinessCacheForTest() {
    if (!envConfig.isTest) {
        throw new Error("_resetReadinessCacheForTest is only allowed in test environments.");
    }
    cachedStatus = null;
}

/**
 * GET /ready and /api/ready
 * Readiness probe for Kubernetes / Cloud Run / Load Balancers.
 * Returns 200 { ready: true } when required Redis connections are connected and ready
 * (queue Redis always; rate-limit Redis only when RATE_LIMIT_STORE="redis").
 * Returns 503 { ready: false } when a required Redis connection is not ready.
 */
router.get("/", async (req, res) => {
    try {
        const now = Date.now();
        const cacheTtlMs = getReadinessCacheTtlMs();
        const requireRateLimitRedis = isRedisRateLimitStore();

        if (
            cachedStatus &&
            cachedStatus.requireRateLimitRedis === requireRateLimitRedis &&
            (now - cachedStatus.timestamp) < cacheTtlMs
        ) {
            if (cachedStatus.ready) {
                return res.status(200).json({ ready: true });
            }
            return res.status(503).json({ ready: false });
        }

        const queueReady = redisConnection?.status === "ready";
        const rateLimitReady = requireRateLimitRedis
            ? rateLimitRedisConnection?.status === "ready"
            : null;

        const isReady = requireRateLimitRedis
            ? Boolean(rateLimitReady && queueReady)
            : Boolean(queueReady);
        const timeoutMs = getReadinessTimeoutMs();

        if (isReady) {
            if (requireRateLimitRedis && typeof rateLimitRedisConnection?.ping === "function") {
                await pingWithTimeout(rateLimitRedisConnection, "RateLimit Redis", timeoutMs);
            }
            if (typeof redisConnection?.ping === "function") {
                await pingWithTimeout(redisConnection, "Queue Redis", timeoutMs);
            }
        }

        cachedStatus = { ready: isReady, requireRateLimitRedis, timestamp: Date.now() };

        if (isReady) {
            return res.status(200).json({ ready: true });
        }

        const warnPayload = requireRateLimitRedis
            ? { event: "ready.check_failed", rateLimitReady, queueReady }
            : { event: "ready.check_failed", queueReady };
        readyLogger.warn(warnPayload, "Readiness check failed");
        return res.status(503).json({ ready: false });
    } catch (err) {
        cachedStatus = { ready: false, requireRateLimitRedis: isRedisRateLimitStore(), timestamp: Date.now() };
        readyLogger.warn({ event: "ready.check_error", err: err.message }, "Readiness check error");
        return res.status(503).json({ ready: false });
    }
});

export default router;
