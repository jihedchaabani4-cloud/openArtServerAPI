import Redis from "ioredis";
import { createLogger } from "../logger/index.js";
import { redisConfig } from "../config/index.js";

const redisLogger = createLogger("redis");

const redisUrl = redisConfig.url;
const redisHost = redisConfig.host;
const redisPort = redisConfig.port;
const redisPassword = redisConfig.password;

const isTLS = redisUrl?.startsWith("rediss://") || redisUrl?.includes("upstash.io");

// ── Base options for Upstash Serverless Redis & BullMQ ───────────────────────
const MAX_RECONNECT_ATTEMPTS = 20; // Stop retrying after 20 attempts (~60s total)

const isTestEnv = redisConfig.isTestEnv;

const BASE_OPTIONS = {
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,
  lazyConnect: isTestEnv,
  enableOfflineQueue: true, // Allows ioredis to buffer commands during Upstash TCP reconnect
  keepAlive: 10_000, // Send TCP keep-alive packets to prevent Upstash idle disconnect
  pingInterval: 15_000, // Heartbeat PING every 15s to keep socket warm
  connectTimeout: 10_000,
  retryStrategy(times) {
    if (times > MAX_RECONNECT_ATTEMPTS) {
      redisLogger.error({ event: "redis.reconnect_exhausted", maxAttempts: MAX_RECONNECT_ATTEMPTS }, `[Redis] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
      return null;
    }
    return Math.min(times * 200, 3000);
  },
  tls: isTLS ? { rejectUnauthorized: false } : undefined,
};

// ── Regular connection (used by Queue + non-blocking calls) ─────────────────
export const redisConnection = redisUrl
  ? new Redis(redisUrl, BASE_OPTIONS)
  : new Redis({ host: redisHost, port: Number(redisPort), password: redisPassword || undefined, ...BASE_OPTIONS });

// ── Worker connection (used by BullMQ Worker only) ───────────────────────────
export const workerRedisConnection = redisUrl
  ? new Redis(redisUrl, BASE_OPTIONS)
  : new Redis({ host: redisHost, port: Number(redisPort), password: redisPassword || undefined, ...BASE_OPTIONS });

// ── Rate limiter connection (fail fast: no offline queue, strict command timeout) ─
const RATE_LIMIT_BASE_OPTIONS = {
  ...BASE_OPTIONS,
  enableOfflineQueue: false,
  commandTimeout: redisConfig.rateLimitCommandTimeoutMs,
  connectTimeout: 2000,
  maxRetriesPerRequest: 1,
  lazyConnect: isTestEnv,
};

export const rateLimitRedisConnection = redisUrl
  ? new Redis(redisUrl, RATE_LIMIT_BASE_OPTIONS)
  : new Redis({ host: redisHost, port: Number(redisPort), password: redisPassword || undefined, ...RATE_LIMIT_BASE_OPTIONS });

// Eagerly connect outside test environment to prevent 503 on boot
if (!isTestEnv && rateLimitRedisConnection.status === "wait") {
  rateLimitRedisConnection.connect().catch((err) => {
    redisLogger.warn({ event: "redis.eager_connect_warning", err: err.message }, "[RateLimit Redis] Eager connection warning");
  });
}

// Error handlers to prevent unhandled log floods
redisConnection.on("error", (err) => {
  if (!err.message?.includes("enableOfflineQueue")) {
    redisLogger.warn({ event: "redis.connection_warning", err: err.message }, "[Redis] Connection warning");
  }
});

workerRedisConnection.on("error", (err) => {
  if (!err.message?.includes("enableOfflineQueue")) {
    redisLogger.warn({ event: "redis.worker_connection_warning", err: err.message }, "[Worker Redis] Connection warning");
  }
});

rateLimitRedisConnection.on("error", (err) => {
  if (!err.message?.includes("enableOfflineQueue")) {
    redisLogger.warn({ event: "redis.ratelimit_connection_warning", err: err.message }, "[RateLimit Redis] Connection warning");
  }
});

/**
 * Waits for the rate limit Redis connection to reach 'ready' status.
 *
 * @param {number} [timeoutMs=5000] - Maximum milliseconds to wait
 * @returns {Promise<boolean>} True if ready, false if timed out or in test env
 */
export async function waitForRateLimitRedis(timeoutMs = 5000) {
  if (isTestEnv) {
    return true;
  }

  if (rateLimitRedisConnection.status === "ready") {
    return true;
  }

  if (rateLimitRedisConnection.status === "wait") {
    rateLimitRedisConnection.connect().catch((err) => {
      redisLogger.warn({ event: "redis.wait_error", err: err.message }, "[RateLimit Redis] Connection error during waitForRateLimitRedis");
    });
  }

  return new Promise((resolve) => {
    let timer = null;

    const onReady = () => {
      cleanup();
      redisLogger.info({ event: "redis.ready" }, "[RateLimit Redis] Connection ready.");
      resolve(true);
    };

    const onError = () => {
      // Keep waiting until timeout or ready
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      rateLimitRedisConnection.removeListener("ready", onReady);
      rateLimitRedisConnection.removeListener("error", onError);
    };

    timer = setTimeout(() => {
      cleanup();
      redisLogger.error({ event: "redis.timeout", timeoutMs, status: rateLimitRedisConnection.status }, `[RateLimit Redis] Connection timed out after ${timeoutMs}ms. Proceeding with startup.`);
      resolve(false);
    }, timeoutMs);

    rateLimitRedisConnection.once("ready", onReady);
    rateLimitRedisConnection.on("error", onError);
  });
}

export const RECONCILIATION_CACHE_KEY = "reconciliation:latest";

export default {
  redisConnection,
  workerRedisConnection,
  rateLimitRedisConnection,
  waitForRateLimitRedis,
  RECONCILIATION_CACHE_KEY,
};
