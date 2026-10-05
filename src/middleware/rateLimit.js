import crypto from "crypto";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { RATE_LIMIT_POLICIES } from "../config/rateLimitPolicies.js";
import { createLogger } from "../infrastructure/logging/index.js";

const systemLogger = createLogger("ratelimit");
let lastAuthOutageLog = 0;

/**
 * Generic Rate Limit Middleware
 * ─────────────────────────────────────────────────────────────────────────────
 * Usage:
 *   router.post("/images/generated", requireAuth, rateLimit("imageGeneration"), controller)
 *
 * Outage Policies:
 *   - failPolicy: "insurance" (Auth routes): Uses in-memory insuranceLimiter per instance.
 *     Degrades safely when Redis is down; logs error once per 60s window.
 *   - failPolicy: "close" (Expensive AI routes): Fails closed with 503 SERVICE_UNAVAILABLE + Retry-After.
 *   - Default (Wallet / Read): Fails open.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Limiter instance cache (one per policy, created on first use) ─────────────
const _limiters = new Map();

export function resetLimitersForTest() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("[rateLimit] resetLimitersForTest is only permitted when NODE_ENV === 'test'");
  }
  _limiters.clear();
}

export function setLimiterForTest(key, limiter) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("[rateLimit] setLimiterForTest is only permitted when NODE_ENV === 'test'");
  }
  _limiters.set(key, limiter);
}

async function getLimiter(policy) {
  if (_limiters.has(policy.cacheKey)) {
    return _limiters.get(policy.cacheKey);
  }

  const store = process.env.RATE_LIMIT_STORE || "memory";

  let limiter;

  if (store === "redis") {
    // ── Redis store (V2 / multi-process) ──────────────────────────────────────
    const { RateLimiterRedis } = await import("rate-limiter-flexible");
    const { rateLimitRedisConnection } = await import("../queue/redis.js");

    const opts = {
      storeClient: rateLimitRedisConnection,
      points:      policy.points,
      duration:    policy.duration,
      keyPrefix:   `rl:${policy.cacheKey}`,
    };

    if (policy.failPolicy === "insurance") {
      const baseInsurance = new RateLimiterMemory({
        points:   policy.points,
        duration: policy.duration,
      });
      const origConsume = baseInsurance.consume.bind(baseInsurance);
      baseInsurance.consume = async (...args) => {
        const now = Date.now();
        if (now - lastAuthOutageLog > 60_000) {
          lastAuthOutageLog = now;
          systemLogger.error({
            event: "ratelimit.auth_degraded",
            policy: policy.cacheKey,
          }, `[rateLimit:auth] Redis outage detected — operating with in-memory insurance limiter`);
        }
        return origConsume(...args);
      };
      opts.insuranceLimiter = baseInsurance;
    }

    limiter = new RateLimiterRedis(opts);
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
    } else if (policy.keyBy === "email") {
      const rawEmail = req.body?.email;
      if (typeof rawEmail !== "string" || !rawEmail.trim()) {
        // Missing or non-string email skips email limiter without sharing a bucket;
        // downstream validation and IP-based rate limiting still apply.
        return next();
      }

      if (rawEmail.length > 254) {
        return res.status(400).json({
          ok: false,
          error: "Email exceeds maximum length of 254 characters",
          message: "Email exceeds maximum length of 254 characters",
        });
      }

      const normalizedEmail = rawEmail.trim().toLowerCase();
      const hashedEmail = crypto.createHash("sha256").update(normalizedEmail).digest("hex");
      const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
      // Key includes both hashed email and client IP to prevent an attacker from locking
      // a victim's account from another IP, while preventing brute force from this IP.
      key = `email_ip:${crypto.createHash("sha256").update(`${hashedEmail}:${clientIp}`).digest("hex")}`;
    } else {
      // keyBy === "ip"
      key = req.ip || req.socket?.remoteAddress || "unknown";
    }

    // ── Apply policy ──────────────────────────────────────────────────────────
    const RATE_LIMIT_TIMEOUT_MS = Number(process.env.RATE_LIMIT_TIMEOUT_MS) || 1500;
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Rate limiter command timeout")), RATE_LIMIT_TIMEOUT_MS);
    });

    try {
      const limiter = await getLimiter(policy);
      await Promise.race([limiter.consume(key), timeoutPromise]);
      return next();
    } catch (err) {
      // RateLimiterRes thrown when limit exceeded
      if (err?.msBeforeNext !== undefined) {
        const retryAfterSec = Math.ceil(err.msBeforeNext / 1000);
        res.setHeader("Retry-After", retryAfterSec);
        return res.status(429).json({
          ok:      false,
          code:    "RATE_LIMIT_EXCEEDED",
          error:   "RATE_LIMIT_EXCEEDED",
          message: "Too many requests. Please try again later.",
        });
      }

      // Infrastructure failure (Redis down, command timeout, connection refused, etc.)
      if (policy.failPolicy === "close") {
        systemLogger.error({
          event: "ratelimit.fail_closed",
          policy: policyName,
          err: err?.message,
        }, `[rateLimit:${policyName}] Redis infrastructure failure on AI route — failing closed (503)`);

        res.setHeader("Retry-After", 30);
        return res.status(503).json({
          ok:      false,
          code:    "SERVICE_UNAVAILABLE",
          message: "Service temporarily unavailable. Please try again shortly.",
        });
      }

      if (policy.failPolicy === "insurance") {
        const now = Date.now();
        if (now - lastAuthOutageLog > 60_000) {
          lastAuthOutageLog = now;
          systemLogger.error({
            event: "ratelimit.auth_degraded",
            policy: policyName,
            err: err?.message,
          }, `[rateLimit:auth] Redis outage detected — operating with in-memory insurance limiter`);
        }
        return next();
      }

      // Default fallback (e.g. read routes): log warning and fail open
      console.warn(
        `[rateLimit:${policyName}] Infrastructure error — failing open:`,
        err?.message
      );
      return next();
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };
}
