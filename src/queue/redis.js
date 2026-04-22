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

// Export connection config. BullMQ workers/queues should use an explicit Redis config.
export const connectionOptions = redisUrl ? undefined : {
  host: redisHost,
  port: Number(redisPort),
  password: redisPassword,
  maxRetriesPerRequest: null,
};

// Reusable instantiated connection
export const redisConnection = redisUrl 
  ? new Redis(redisUrl, { maxRetriesPerRequest: null, tls: redisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined }) 
  : new Redis(connectionOptions);
