import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || process.env.REDIS_DEV_URL || "";
const redisHost = process.env.REDIS_HOST || "127.0.0.1";
const redisPort = process.env.REDIS_PORT || "6379";
const redisPassword = process.env.REDIS_PASSWORD || "";

const isTLS = redisUrl?.startsWith('rediss://') || redisUrl?.includes('upstash.io');

// ── Base options for Upstash Serverless Redis & BullMQ ───────────────────────
const MAX_RECONNECT_ATTEMPTS = 20; // Stop retrying after 20 attempts (~60s total)

const BASE_OPTIONS = {
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck:     false,
  lazyConnect:          false,
  enableOfflineQueue:   true,   // Allows ioredis to buffer commands during Upstash TCP reconnect
  keepAlive:            10_000, // Send TCP keep-alive packets to prevent Upstash idle disconnect
  pingInterval:         15_000, // Heartbeat PING every 15s to keep socket warm
  connectTimeout:       10_000,
  retryStrategy(times) {
    // Stop retrying after max attempts — prevents quota drain on Upstash plan limits
    if (times > MAX_RECONNECT_ATTEMPTS) {
      console.error(`[Redis] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
      return null; // null = stop retrying
    }
    return Math.min(times * 200, 3000); // Smooth exponential reconnect backoff
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

const isTestEnv = process.env.NODE_ENV === "test";

// ── Rate limiter connection (fail fast: no offline queue, strict command timeout) ─
const RATE_LIMIT_BASE_OPTIONS = {
  ...BASE_OPTIONS,
  enableOfflineQueue:   false, // Fail immediately during Redis outages; do not buffer commands in memory
  commandTimeout:       Number(process.env.RATE_LIMIT_COMMAND_TIMEOUT_MS) || 1500,
  connectTimeout:       2000,
  maxRetriesPerRequest: 1,
  lazyConnect:          isTestEnv,  // Keep lazyConnect in tests; connect eagerly outside NODE_ENV=test
};

export const rateLimitRedisConnection = redisUrl
  ? new Redis(redisUrl, RATE_LIMIT_BASE_OPTIONS)
  : new Redis({ host: redisHost, port: Number(redisPort), password: redisPassword || undefined, ...RATE_LIMIT_BASE_OPTIONS });

// Eagerly connect outside test environment to prevent 503 on boot
if (!isTestEnv && rateLimitRedisConnection.status === "wait") {
  rateLimitRedisConnection.connect().catch((err) => {
    console.warn('[RateLimit Redis] Eager connection warning:', err.message);
  });
}

// Error handlers to prevent unhandled log floods
redisConnection.on('error', (err) => {
  if (!err.message?.includes('enableOfflineQueue')) {
    console.warn('[Redis] Connection warning:', err.message);
  }
});

workerRedisConnection.on('error', (err) => {
  if (!err.message?.includes('enableOfflineQueue')) {
    console.warn('[Worker Redis] Connection warning:', err.message);
  }
});

rateLimitRedisConnection.on('error', (err) => {
  if (!err.message?.includes('enableOfflineQueue')) {
    console.warn('[RateLimit Redis] Connection warning:', err.message);
  }
});
