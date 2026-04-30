import { Queue } from 'bullmq';
import { redisConnection } from './redis.js';

export const QUEUE_NAME = 'jobs';

export const jobQueue = new Queue(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    // ── Redis Memory Optimization (important on Upstash free plan) ──────────
    removeOnComplete: { count: 10 },  // Keep only last 10 completed jobs
    removeOnFail:     { count: 50 },  // Keep last 50 failed for inspection
  },
});
