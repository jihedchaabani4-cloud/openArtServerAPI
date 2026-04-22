import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL;

// Export connection config. BullMQ workers/queues prefer creating their own connections 
// based on these options to avoid blocking issues.
export const connectionOptions = redisUrl ? undefined : {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // CRITICAL: This is required by BullMQ
};

// Reusable instantiated connection
export const redisConnection = redisUrl 
  ? new Redis(redisUrl, { maxRetriesPerRequest: null, tls: redisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined }) 
  : new Redis(connectionOptions);
