import { Queue } from 'bullmq';
import { redisConnection } from './redis.js';

export const QUEUE_NAME = 'jobs';

export const jobQueue = new Queue(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: true, // Keep Redis memory clean
    removeOnFail: false,    // Retain failed jobs for inspection
  },
});
