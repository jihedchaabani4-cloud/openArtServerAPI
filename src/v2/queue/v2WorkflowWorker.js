import "dotenv/config";
import { Worker } from "bullmq";
import { workerRedisConnection } from "../../queue/redis.js";
import { V2_QUEUE_NAME } from "./v2WorkflowQueue.js";
import { executeOrchestration } from "../runner/workflowRunner.js";
import { logV2Event } from "../logging/v2Logger.js";
import { bootstrapV2 } from "../bootstrap.js";

// Initialize V2 Engine & Registries
bootstrapV2();

logV2Event({
  traceId: "v2-worker-bootstrap",
  operation: "worker.start",
  durationMs: 0,
  status: "success",
  message: `Specialized UseCase Worker listening on Redis queue: ${V2_QUEUE_NAME}`
});

/**
 * 🎯 Specialized UseCase Worker
 * Single Responsibility: Dedicated exclusively to listening for UseCase execution jobs
 * from Upstash Redis and running executeOrchestration(runId).
 */
export const v2WorkflowWorker = new Worker(
  V2_QUEUE_NAME,
  async (job) => {
    const { runId } = job.data;
    await executeOrchestration(runId);
  },
  {
    connection: workerRedisConnection,
    concurrency: 10,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 }
  }
);

v2WorkflowWorker.on("failed", (job, err) => {
  console.error(`❌ [UseCase Worker] Job ${job?.id} failed: ${err.message}`);
});
