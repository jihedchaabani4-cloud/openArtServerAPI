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

const BASE_OPTIONS = {
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,
  lazyConnect: true,
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
  lazyConnect: true,
};

export const rateLimitRedisConnection = redisUrl
  ? new Redis(redisUrl, RATE_LIMIT_BASE_OPTIONS)
  : new Redis({ host: redisHost, port: Number(redisPort), password: redisPassword || undefined, ...RATE_LIMIT_BASE_OPTIONS });

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

async function waitForRedisConnection(connection, label, timeoutMs = 5000) {
  if (!connection) {
    return false;
  }

  if (connection.status === "ready") {
    return true;
  }

  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;

  return new Promise((resolve) => {
    let timer = null;
    let settled = false;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      connection.removeListener?.("ready", onReady);
      connection.removeListener?.("error", onError);
    };

    const finish = (ready) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ready);
    };

    const onReady = () => {
      redisLogger.info({ event: "redis.ready", connection: label }, `[${label}] Connection ready.`);
      finish(true);
    };

    const onError = () => {
      // Keep waiting until timeout or ready
    };

    timer = setTimeout(() => {
      redisLogger.error(
        { event: "redis.timeout", connection: label, timeoutMs: effectiveTimeoutMs, status: connection.status },
        `[${label}] Connection timed out after ${effectiveTimeoutMs}ms. Proceeding with startup.`
      );
      finish(false);
    }, effectiveTimeoutMs);

    connection.once?.("ready", onReady);
    connection.on?.("error", onError);

    if (connection.status === "wait" && typeof connection.connect === "function") {
      Promise.resolve()
        .then(() => connection.connect())
        .catch((err) => {
          redisLogger.warn(
            { event: "redis.wait_error", connection: label, err: err?.message },
            `[${label}] Connection error during readiness wait`
          );
        });
    }
  });
}

/**
 * Waits for the queue Redis connection to reach 'ready' status.
 *
 * @param {number} [timeoutMs=5000] - Maximum milliseconds to wait
 * @param {object} [connection=redisConnection] - Optional connection override for testing
 * @returns {Promise<boolean>} True if ready, false if timed out
 */
export async function waitForRedis(timeoutMs = 5000, connection = redisConnection) {
  if (connection === redisConnection && redisConfig.isTestEnv) {
    return true;
  }

  return waitForRedisConnection(connection, "Redis", timeoutMs);
}

/**
 * Waits for the rate limit Redis connection to reach 'ready' status.
 *
 * @param {number} [timeoutMs=5000] - Maximum milliseconds to wait
 * @param {object} [connection=rateLimitRedisConnection] - Optional connection override for testing
 * @returns {Promise<boolean>} True if ready, false if timed out or in test env
 */
export async function waitForRateLimitRedis(timeoutMs = 5000, connection = rateLimitRedisConnection) {
  if (connection === rateLimitRedisConnection && redisConfig.isTestEnv) {
    return true;
  }

  return waitForRedisConnection(connection, "RateLimit Redis", timeoutMs);
}

export default {
  redisConnection,
  workerRedisConnection,
  rateLimitRedisConnection,
  waitForRedis,
  waitForRateLimitRedis,
};
