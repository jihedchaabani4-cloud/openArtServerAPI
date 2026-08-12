import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || process.env.REDIS_DEV_URL || "";
const redisHost = process.env.REDIS_HOST || "127.0.0.1";
const redisPort = process.env.REDIS_PORT || "6379";
const redisPassword = process.env.REDIS_PASSWORD || "";

const isTLS = redisUrl?.startsWith('rediss://') || redisUrl?.includes('upstash.io');

// ── Base options for Upstash Serverless Redis & BullMQ ───────────────────────
const BASE_OPTIONS = {
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck:     false,
  lazyConnect:          false,
  enableOfflineQueue:   true,   // Allows ioredis to buffer commands during Upstash TCP reconnect
  keepAlive:            10_000, // Send TCP keep-alive packets to prevent Upstash idle disconnect
  pingInterval:         15_000, // Heartbeat PING every 15s to keep socket warm
  connectTimeout:       10_000,
  retryStrategy(times) {
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
