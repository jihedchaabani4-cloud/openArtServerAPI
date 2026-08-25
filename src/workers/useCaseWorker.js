import "dotenv/config";
import { Worker } from "bullmq";
import { workerRedisConnection } from "../queue/redis.js";
import { USECASE_QUEUE_NAME } from "../services/jobQueueService.js";
import { useCaseService } from "../container.js";
import { executeNodeJob } from "../v2/runner/nodeExecutor.js";
import { executeOrchestration } from "../v2/runner/workflowRunner.js";
import { bootstrapV2 } from "../v2/bootstrap.js";
import { logV2Event } from "../v2/logging/v2Logger.js";

// Initialize V2 Engine, Gateways, and Register all UseCases in Worker process
bootstrapV2();

logV2Event({
  traceId: "usecase-worker-bootstrap",
  operation: "worker.start",
  durationMs: 0,
  status: "success",
  message: `Specialized UseCase Worker listening on Redis queue: ${USECASE_QUEUE_NAME}`
});

console.log(`\n================================================================`);
console.log(`⚡ [UseCase Worker] Active & listening on Redis Queue: "${USECASE_QUEUE_NAME}"`);
console.log(`================================================================\n`);

/**
 * 🎯 Dedicated UseCase & Node Execution Worker
 */
export const useCaseWorker = new Worker(
  USECASE_QUEUE_NAME,
  async (job) => {
    const start = Date.now();

    // ── Case 1: Full UseCase Execution Job ──────────────────────────────────
    if (job.name === "run-usecase") {
      const { useCaseId, input, userId, billingHoldId } = job.data;
      console.log(`\n================================================================`);
      console.log(`🚀 [UseCase Worker] RUNNING USECASE "${useCaseId}" FOR USER #${userId}`);
      console.log(`================================================================`);

      await useCaseService.executeQueuedUseCase({
        useCaseId,
        input,
        userId,
        billingHoldId,
      });

      const duration = Date.now() - start;
      console.log(`✅ [UseCase Worker] USECASE "${useCaseId}" COMPLETED IN ${duration}ms!`);
      console.log(`================================================================\n`);
      return;
    }

    const { runId, nodeId } = job.data;

    // ── Case 2: Individual Node Execution Job ───────────────────────────────
    if (nodeId) {
      console.log(`\n================================================================`);
      console.log(`⚙️ [UseCase Worker] EXECUTING NODE "${nodeId}" FOR RUN #${runId}`);
      console.log(`================================================================`);

      await executeNodeJob(runId, nodeId);
      const duration = Date.now() - start;
      console.log(`✅ [UseCase Worker] NODE "${nodeId}" COMPLETED IN ${duration}ms! Triggering orchestration...`);
      
      await executeOrchestration(runId);
    } else {
      // ── Case 3: Workflow Orchestration Job ─────────────────────────────────
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

useCaseWorker.on("active", (job) => {
  console.log(`⚙️ [UseCase Worker] Job #${job.id} activated on Redis.`);
});

useCaseWorker.on("completed", (job) => {
  console.log(`🎉 [UseCase Worker] Job #${job.id} marked as COMPLETED.`);
});

useCaseWorker.on("failed", (job, err) => {
  console.error(`❌ [UseCase Worker] Job #${job?.id} FAILED: ${err.message}`);
});

export default useCaseWorker;
