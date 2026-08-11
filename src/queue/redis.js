import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || process.env.REDIS_DEV_URL || "";
const redisHost = process.env.REDIS_HOST || "127.0.0.1";
const redisPort = process.env.REDIS_PORT || "6379";
const redisPassword = process.env.REDIS_PASSWORD || "";

const isTLS = redisUrl?.startsWith('rediss://');

// ── Base options for short-lived / regular commands (Queue, API side) ────────
const BASE_OPTIONS = {
  maxRetriesPerRequest: null,
  enableReadyCheck:     false,  // Skip PING on connect
  lazyConnect:          true,   // Connect only when first command runs
  enableOfflineQueue:   false,  // Prevent infinite reconnect attempts if Redis is offline
  connectTimeout:       5_000,
  tls: isTLS ? { rejectUnauthorized: false } : undefined,
};

// ── Regular connection (used by Queue + any non-blocking calls) ──────────────
export const redisConnection = redisUrl
  ? new Redis(redisUrl, BASE_OPTIONS)
  : new Redis({ host: redisHost, port: Number(redisPort), password: redisPassword || undefined, ...BASE_OPTIONS });

// ── Worker connection (used by BullMQ Worker only) ───────────────────────────
export const workerRedisConnection = redisUrl
  ? new Redis(redisUrl, BASE_OPTIONS)
  : new Redis({ host: redisHost, port: Number(redisPort), password: redisPassword || undefined, ...BASE_OPTIONS });
