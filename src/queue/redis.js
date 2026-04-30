import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL;
const redisHost = process.env.REDIS_HOST;
const redisPort = process.env.REDIS_PORT;
const redisPassword = process.env.REDIS_PASSWORD;

if (!redisUrl && !(redisHost && redisPort && redisPassword)) {
  throw new Error(
    "[Redis] Missing configuration. Set REDIS_URL or set REDIS_HOST, REDIS_PORT, and REDIS_PASSWORD."
  );
}

const isTLS = redisUrl?.startsWith('rediss://');

// ── Base options for short-lived / regular commands (Queue, API side) ────────
// ⚠️  NO commandTimeout here — BullMQ's BZPOPMIN is a blocking command that
//     legitimately blocks for 30s+ waiting for new jobs. A commandTimeout
//     would kill it every cycle, causing infinite "Command timed out" errors.
const BASE_OPTIONS = {
  maxRetriesPerRequest: null,
  enableReadyCheck:     false,  // Skip PING on connect
  lazyConnect:          true,   // Connect only when first command runs
  connectTimeout:       10_000,
  tls: isTLS ? { rejectUnauthorized: false } : undefined,
};

// ── Regular connection (used by Queue + any non-blocking calls) ──────────────
export const redisConnection = redisUrl
  ? new Redis(redisUrl, BASE_OPTIONS)
  : new Redis({ host: redisHost, port: Number(redisPort), password: redisPassword, ...BASE_OPTIONS });

// ── Worker connection (used by BullMQ Worker only) ───────────────────────────
// Must be a SEPARATE connection — BullMQ opens its own blocking socket.
// Never share this with Queue or other clients.
export const workerRedisConnection = redisUrl
  ? new Redis(redisUrl, BASE_OPTIONS)
  : new Redis({ host: redisHost, port: Number(redisPort), password: redisPassword, ...BASE_OPTIONS });
