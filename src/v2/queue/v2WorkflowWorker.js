import "dotenv/config";
import { Worker } from "bullmq";
import { workerRedisConnection } from "../../queue/redis.js";
import { V2_QUEUE_NAME } from "./v2WorkflowQueue.js";
import { executeOrchestration } from "../runner/workflowRunner.js";
import { executeNodeJob } from "../runner/nodeExecutor.js";
import { logV2Event } from "../logging/v2Logger.js";
import { bootstrapV2 } from "../bootstrap.js";

bootstrapV2();

logV2Event({
  traceId: "v2-worker-bootstrap",
  operation: "worker.start",
  durationMs: 0,
  status: "success",
  message: `V2 Workflow worker listening on queue: ${V2_QUEUE_NAME}`
});

export const v2WorkflowWorker = new Worker(
  V2_QUEUE_NAME,
  async (job) => {
    const started = Date.now();
    const { name, data } = job;
    const runId = data.runId;

    logV2Event({
      traceId: runId,
      operation: `job.start:${name}`,
      durationMs: 0,
      status: "success",
      message: `Processing V2 job ${name} (jobId: ${job.id})`
    });

    try {
      if (name === "workflow-run") {
        await executeOrchestration(runId);
      } else if (name === "node-execute") {
        await executeNodeJob(runId, data.nodeId);
      } else {
        throw new Error(`Unknown job name: ${name}`);
      }

      logV2Event({
        traceId: runId,
        operation: `job.complete:${name}`,
        durationMs: Date.now() - started,
        status: "success",
        message: `Completed V2 job ${name}`
      });
    } catch (error) {
      logV2Event({
        traceId: runId,
        operation: `job.fail:${name}`,
        durationMs: Date.now() - started,
        status: "error",
        errorCode: error.code || "JOB_PROCESSING_FAILED",
        message: `Failed V2 job ${name}: ${error.message}`
      });
      throw error; // rethrow to let BullMQ mark job as failed
    }
  },
  {
    connection: workerRedisConnection,
    concurrency: 10,
    // Redis memory optimization limits
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 }
  }
);

v2WorkflowWorker.on("failed", (job, err) => {
  console.error(`[V2 Worker] Job ${job?.id} failed with error: ${err.message}`);
});
