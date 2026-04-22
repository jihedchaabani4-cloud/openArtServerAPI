import 'dotenv/config';
import { Worker } from 'bullmq';
import { redisConnection } from '../queue/redis.js';
import { QUEUE_NAME } from '../queue/queue.js';
import { jobHandlers } from '../jobs/jobHandlers.js';

import { db, storageService, promptService, IMAGE_MODELS as models } from '../container.js';

// Real dependencies injected into all Treatment handlers
const deps = {
  db,
  storageService,
  promptService,
  models,
  externalApi: {} // Add any other required external API abstractions here if needed in the future
};

/**
 * Initialize the worker
 */
export const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    // 1. Find the appropriate handler
    const handler = jobHandlers[job.name];

    // 2. Throw an explicit error if missing
    if (!handler) {
      throw new Error(`FATAL: No handler defined for job name "${job.name}"`);
    }

    // 3. Execute the handler with dependency injection
    return await handler(job.data, deps);
  },
  {
    connection: redisConnection,
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || '10', 10),
  }
);

// --- Event Listeners for Logging & Monitoring ---

worker.on('completed', (job) => {
  console.log(`✅ [Worker] Job ${job.name} (${job.id}) completed successfully.`);
});

worker.on('failed', (job, err) => {
  console.error(`❌ [Worker] Job ${job.name} (${job.id}) failed: ${err.message}`);
});

worker.on('error', (err) => {
  console.error(`🚨 [Worker] Internal Redis error:`, err);
});
