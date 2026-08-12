import "dotenv/config";
import { Worker } from "bullmq";
import { workerRedisConnection } from "../../queue/redis.js";
import { V2_QUEUE_NAME } from "./v2WorkflowQueue.js";
import { executeOrchestration } from "../runner/workflowRunner.js";
import { executeNodeJob } from "../runner/nodeExecutor.js";
import { logV2Event } from "../logging/v2Logger.js";
import { bootstrapV2 } from "../bootstrap.js";

// Initialize V2 Registries & Gateways
bootstrapV2();

logV2Event({
  traceId: "v2-worker-bootstrap",
  operation: "worker.start",
  durationMs: 0,
  status: "success",
  message: `Pure Dispatcher Worker listening on Redis queue: ${V2_QUEUE_NAME}`
});

/**
 * Pure Dispatcher Worker
 * Duty: Listens to Upstash Redis queue, fetches enqueued UseCase jobs,
 * and delegates execution directly to the specialized runner function.
 */
export const v2WorkflowWorker = new Worker(
  V2_QUEUE_NAME,
  async (job) => {
    const { name, data } = job;
    const runId = data.runId;

    if (name === "workflow-run" || name === "usecase-run") {
      await executeOrchestration(runId);
    } else if (name === "node-execute") {
      await executeNodeJob(runId, data.nodeId);
    } else {
      await executeOrchestration(runId);
    }
  },
  {
    connection: workerRedisConnection,
    concurrency: 10,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 }
  }
);

v2WorkflowWorker.on("failed", (job, err) => {
  console.error(`❌ [V2 Worker] Job ${job?.id} failed: ${err.message}`);
});
