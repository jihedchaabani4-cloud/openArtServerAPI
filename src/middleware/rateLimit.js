import { RateLimiterMemory } from "rate-limiter-flexible";
import { RATE_LIMIT_POLICIES } from "../config/rateLimitPolicies.js";

/**
 * Generic Rate Limit Middleware
 * ─────────────────────────────────────────────────────────────────────────────
 * Usage:
 *   router.post("/images/generated", requireAuth, rateLimit("imageGeneration"), controller)
 *
 * The middleware:
 *   1. Resolves the identity key (userId or IP) from the policy config
 *   2. Applies the configured policy limits
 *   3. Returns HTTP 429 + Retry-After on limit exceeded
 *   4. On infrastructure error: fails open (request passes through)
 *
 * Store (V1 = Memory):
 *   Controlled by RATE_LIMIT_STORE env var.
 *   Memory: per-process, counters reset on restart.
 *   Redis:  set RATE_LIMIT_STORE=redis to enable cross-process sharing.
 *           Requires REDIS_URL env var. No route/policy code changes needed.
 *
 * ⚠️  MULTI-PROCESS NOTE:
 *   With Memory store, each process tracks its own counter.
 *   To enforce global limits across PM2 / Docker / k8s replicas, switch to Redis.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Limiter instance cache (one per policy, created on first use) ─────────────
const _limiters = new Map();

async function getLimiter(policy) {
  if (_limiters.has(policy.cacheKey)) {
    return _limiters.get(policy.cacheKey);
  }

  const store = process.env.RATE_LIMIT_STORE || "memory";

  let limiter;

  if (store === "redis") {
    // ── Redis store (V2 / multi-process) ──────────────────────────────────────
    // Lazy import so the module works without Redis configured in V1 memory mode
    const { RateLimiterRedis } = await import("rate-limiter-flexible");
    const { redisConnection } = await import("../queue/redis.js");

    limiter = new RateLimiterRedis({
      storeClient: redisConnection,
      points:      policy.points,
      duration:    policy.duration,
      keyPrefix:   `rl:${policy.cacheKey}`,
    });
  } else {
    // ── Memory store (V1 default) ─────────────────────────────────────────────
    limiter = new RateLimiterMemory({
      points:   policy.points,
      duration: policy.duration,
    });
  }

  _limiters.set(policy.cacheKey, limiter);
  return limiter;
}

/**
 * rateLimit(policyName) → Express middleware
 *
 * @param {string} policyName - key from RATE_LIMIT_POLICIES
 * @returns Express middleware function
 */
export function rateLimit(policyName) {
  const policyConfig = RATE_LIMIT_POLICIES[policyName];

  if (!policyConfig) {
    throw new Error(
      `[rateLimit] Unknown policy "${policyName}". ` +
      `Add it to src/config/rateLimitPolicies.js`
    );
  }

  const policy = { ...policyConfig, cacheKey: policyName };

  return async (req, res, next) => {
    // ── Resolve identity key ──────────────────────────────────────────────────
    let key;
    if (policy.keyBy === "user") {
      key = req.user?.id;
      if (!key) {
        // Auth middleware hasn't run or failed — pass through, let auth handle it
        return next();
      }
    } else {
      // keyBy === "ip"
      key = req.ip || req.socket?.remoteAddress || "unknown";
    }

    // ── Apply policy ──────────────────────────────────────────────────────────
    try {
      const limiter = await getLimiter(policy);
      await limiter.consume(key);
      return next();
    } catch (err) {
      // RateLimiterRes thrown when limit exceeded
      if (err?.msBeforeNext !== undefined) {
        const retryAfterSec = Math.ceil(err.msBeforeNext / 1000);
        res.setHeader("Retry-After", retryAfterSec);
        return res.status(429).json({
          ok:      false,
          code:    "RATE_LIMIT_EXCEEDED",
          message: "Too many generation requests. Please wait a moment.",
        });
      }

      // Infrastructure failure (Redis down, etc.) — fail open, do not block
      console.warn(
        `[rateLimit:${policyName}] Infrastructure error — failing open:`,
        err?.message
      );
      return next();
    }
  };
}
