import { redisConnection } from "../queue/redis.js";

/**
 * walletRateLimit — Redis sliding-window rate limiter
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses ioredis INCR + EXPIRE (reuses the existing BullMQ redisConnection,
 * zero new dependencies). Each counter key is per-user and auto-expires.
 *
 * Rate-limit commands (INCR, EXPIRE) are non-blocking — safe to share the
 * BullMQ connection without affecting queue performance.
 *
 * Usage:
 *   // Default: 30 requests / 60 seconds per user on wallet routes
 *   router.use(walletRateLimit())
 *
 *   // Custom limit for admin routes with separate key namespace
 *   router.post('/credit', walletRateLimit({ max: 10, windowSec: 60, keyPrefix: 'rate:admin' }))
 *
 * Response on limit exceeded (HTTP 429):
 *   { error: 'TOO_MANY_REQUESTS', message: '...', retryAfter: 60 }
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function walletRateLimit({
  max = 30,
  windowSec = 60,
  keyPrefix = "rate:wallet",
} = {}) {
  return async (req, res, next) => {
    const userId = req.user?.id;
    if (!userId) {
      // No user ID means requireAuth hasn't run — pass through and let auth handle it
      return next();
    }

    const key = `${keyPrefix}:${userId}`;

    try {
      const count = await redisConnection.incr(key);

      // Only set TTL on the first request to avoid resetting the window on every call
      if (count === 1) {
        await redisConnection.expire(key, windowSec);
      }

      if (count > max) {
        // Compute remaining TTL to tell client when to retry
        const ttl = await redisConnection.ttl(key);
        return res.status(429).json({
          error: "TOO_MANY_REQUESTS",
          message: `Rate limit exceeded. Maximum ${max} requests per ${windowSec} seconds.`,
          retryAfter: ttl > 0 ? ttl : windowSec,
        });
      }

      next();
    } catch (err) {
      // If Redis is temporarily unavailable, fail open (do not block the request)
      console.warn("[walletRateLimit] Redis error — failing open:", err?.message);
      next();
    }
  };
}
