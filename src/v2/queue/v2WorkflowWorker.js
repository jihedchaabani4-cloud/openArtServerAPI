import "dotenv/config";
import { Worker } from "bullmq";
import { workerRedisConnection } from "../../queue/redis.js";
import { V2_QUEUE_NAME } from "./v2WorkflowQueue.js";
import { executeOrchestration } from "../runner/workflowRunner.js";
import { executeNodeJob } from "../runner/nodeExecutor.js";
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

console.log(`\n================================================================`);
console.log(`⚡ [UseCase Worker] Active & listening on Redis Queue: "${V2_QUEUE_NAME}"`);
console.log(`================================================================\n`);

/**
 * 🎯 Specialized UseCase & Node Execution Worker
 * Handles both:
 * 1. Workflow Orchestration jobs ({ runId })
 * 2. Individual Node Execution jobs ({ runId, nodeId })
 */
export const v2WorkflowWorker = new Worker(
  V2_QUEUE_NAME,
  async (job) => {
    const { runId, nodeId } = job.data;
    const start = Date.now();

    if (nodeId) {
      console.log(`\n================================================================`);
      console.log(`⚙️ [UseCase Worker] EXECUTING NODE "${nodeId}" FOR RUN #${runId}`);
      console.log(`================================================================`);

      await executeNodeJob(runId, nodeId);
      const duration = Date.now() - start;
      console.log(`✅ [UseCase Worker] NODE "${nodeId}" COMPLETED IN ${duration}ms! Triggering orchestration step...`);
      
      // Trigger next orchestration step after node completion
      await executeOrchestration(runId);
    } else {
      console.log(`\n================================================================`);
      console.log(`🚀 [UseCase Worker] ORCHESTRATING RUN #${runId}`);
      console.log(`================================================================`);

      await executeOrchestration(runId);
      const duration = Date.now() - start;
      console.log(`✅ [UseCase Worker] ORCHESTRATION STEP FINISHED IN ${duration}ms!`);
    }

    console.log(`================================================================\n`);
  },
  {
    connection: workerRedisConnection,
    concurrency: 10,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 }
  }
);

v2WorkflowWorker.on("active", (job) => {
  console.log(`⚙️ [UseCase Worker] Job #${job.id} activated on Redis.`);
});

v2WorkflowWorker.on("completed", (job) => {
  console.log(`🎉 [UseCase Worker] Job #${job.id} marked as COMPLETED.`);
});

v2WorkflowWorker.on("failed", (job, err) => {
  console.error(`❌ [UseCase Worker] Job #${job?.id} FAILED: ${err.message}`);
});
