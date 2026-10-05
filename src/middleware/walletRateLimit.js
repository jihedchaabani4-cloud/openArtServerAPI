import { rateLimitRedisConnection } from "../queue/redis.js";
import { createLogger } from "../infrastructure/logging/index.js";

const systemLogger = createLogger("ratelimit");

/**
 * walletRateLimit — Redis sliding-window rate limiter
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses ioredis INCR + EXPIRE (uses dedicated fail-fast rateLimitRedisConnection).
 * Each counter key is per-user and auto-expires.
 *
 * Outage Policy:
 *   Wallet read routes fail-open on Redis error/timeout, logging at error level.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function walletRateLimit({
  max = 30,
  windowSec = 60,
  keyPrefix = "rate:wallet",
  storeClient = rateLimitRedisConnection,
} = {}) {
  return async (req, res, next) => {
    const userId = req.user?.id;
    if (!userId) {
      // No user ID means requireAuth hasn't run — pass through and let auth handle it
      return next();
    }

    const key = `${keyPrefix}:${userId}`;

    const WALLET_RATE_LIMIT_TIMEOUT_MS = Number(process.env.WALLET_RATE_LIMIT_TIMEOUT_MS) || 1500;
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Wallet rate limiter command timeout")), WALLET_RATE_LIMIT_TIMEOUT_MS);
    });

    try {
      const count = await Promise.race([storeClient.incr(key), timeoutPromise]);

      // Only set TTL on the first request to avoid resetting the window on every call
      if (count === 1) {
        await storeClient.expire(key, windowSec);
      }

      if (count > max) {
        // Compute remaining TTL to tell client when to retry
        const ttl = await storeClient.ttl(key);
        return res.status(429).json({
          ok: false,
          code: "RATE_LIMIT_EXCEEDED",
          error: "RATE_LIMIT_EXCEEDED",
          message: `Rate limit exceeded. Maximum ${max} requests per ${windowSec} seconds.`,
          retryAfter: ttl > 0 ? ttl : windowSec,
        });
      }

      next();
    } catch (err) {
      // If Redis is temporarily unavailable, fail open with error-level log
      systemLogger.error({
        event: "wallet.ratelimit.error",
        err: err?.message,
      }, "[walletRateLimit] Redis error — failing open for wallet reads");
      next();
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };
}
