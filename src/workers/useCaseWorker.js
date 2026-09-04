import "dotenv/config";
import { Worker } from "bullmq";
import { workerRedisConnection } from "../queue/redis.js";
import { USECASE_QUEUE_NAME } from "../services/jobQueueService.js";
import { useCaseService } from "../container.js";
import { executeNodeJob } from "../v2/runner/nodeExecutor.js";
import { executeOrchestration } from "../v2/runner/workflowRunner.js";
import { bootstrapV2 } from "../v2/bootstrap.js";
import { wrapWorkerJob } from "../infrastructure/logging/workerLogger.js";
import { createLogger, LogEvents } from "../infrastructure/logging/index.js";

const workerLogger = createLogger("worker");

// Initialize V2 Engine, Gateways, and Register all UseCases in Worker process
bootstrapV2();

workerLogger.info({
  event: "worker.start",
  queue: USECASE_QUEUE_NAME,
}, `Specialized UseCase Worker listening on Redis queue: "${USECASE_QUEUE_NAME}"`);

/**
 * 🎯 Dedicated UseCase & Node Execution Worker
 */
export const useCaseWorker = new Worker(
  USECASE_QUEUE_NAME,
  wrapWorkerJob("usecase-worker", async (job) => {
    const start = Date.now();

    // ── Case 1: Full UseCase Execution Job ──────────────────────────────────
    if (job.name === "run-usecase") {
      const { useCaseId, input, userId, billingHoldId } = job.data;
      workerLogger.debug({ useCaseId, userId }, `Processing UseCase "${useCaseId}" for user ${userId}`);

      await useCaseService.executeQueuedUseCase({
        useCaseId,
        input,
        userId,
        billingHoldId,
      });
      return;
    }

    const { runId, nodeId } = job.data;

    // ── Case 2: Individual Node Execution Job ───────────────────────────────
    if (nodeId) {
      workerLogger.debug({ runId, nodeId }, `Executing node "${nodeId}" for run ${runId}`);
      await executeNodeJob(runId, nodeId);
      await executeOrchestration(runId);
    } else {
      // ── Case 3: Workflow Orchestration Job ─────────────────────────────────
      workerLogger.debug({ runId }, `Orchestrating run ${runId}`);
      await executeOrchestration(runId);
    }
  }),
  {
    connection: workerRedisConnection,
    concurrency: 10,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 }
  }
);

useCaseWorker.on("active", (job) => {
  workerLogger.debug({ event: LogEvents.JOB_STARTED, jobId: job.id }, `Job #${job.id} activated on Redis`);
});

useCaseWorker.on("completed", (job) => {
  workerLogger.debug({ event: LogEvents.JOB_COMPLETED, jobId: job.id }, `Job #${job.id} marked as COMPLETED`);
});

useCaseWorker.on("failed", (job, err) => {
  workerLogger.error({ event: LogEvents.JOB_FAILED, jobId: job?.id, err }, `Job #${job?.id} FAILED: ${err.message}`);
});

export default useCaseWorker;
