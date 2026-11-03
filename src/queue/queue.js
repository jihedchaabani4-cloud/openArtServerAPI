import { Queue } from 'bullmq';
import { redisConnection } from './redis.js';
import { createLogger } from '../infrastructure/logging/index.js';

const queueLogger = createLogger('queue');

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

jobQueue.on('error', (err) => {
  queueLogger.error(
    { event: 'job_queue.error', err: err?.message || String(err) },
    `[JobQueue] Redis queue error: ${err?.message || String(err)}`
  );
});
