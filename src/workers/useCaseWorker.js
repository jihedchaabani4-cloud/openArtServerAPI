import "dotenv/config";
import { Worker } from "bullmq";
import { workerRedisConnection } from "../queue/redis.js";
import { USECASE_QUEUE_NAME } from "../services/jobQueueService.js";
import { useCaseService, db } from "../container.js";
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
export const useCaseWorker = process.env.NODE_ENV === "test"
  ? { on: () => {}, close: async () => {} }
  : new Worker(
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

if (process.env.NODE_ENV !== "test") {
  useCaseWorker.on("active", (job) => {
    workerLogger.debug({ event: LogEvents.JOB_STARTED, jobId: job.id }, `Job #${job.id} activated on Redis`);
  });

  useCaseWorker.on("completed", (job) => {
    workerLogger.debug({ event: LogEvents.JOB_COMPLETED, jobId: job.id }, `Job #${job.id} marked as COMPLETED`);
  });

  useCaseWorker.on("failed", handleUseCaseWorkerFailure);
}

export async function handleUseCaseWorkerFailure(job, err) {
  workerLogger.error({ event: LogEvents.JOB_FAILED, jobId: job?.id, err }, `Job #${job?.id} FAILED: ${err?.message}`);

  // ── Smart crash detection ─────────────────────────────────────────────────
  // executeQueuedUseCase adds `err.errorReport` when it catches normally.
  // If it's present → cleanup already done there → skip to avoid double-rollback.
  // If absent → Worker crashed before catch ran → we must handle cleanup here.
  const alreadyHandled = Boolean(err?.errorReport);
  if (alreadyHandled) {
    workerLogger.debug(
      { jobId: job?.id },
      `[Worker] Job #${job?.id} failed with errorReport — cleanup already done by executeQueuedUseCase.`
    );
    return;
  }

  // ── Worker crash path: manual cleanup ────────────────────────────────────
  workerLogger.warn(
    { jobId: job?.id },
    `[Worker] Job #${job?.id} failed without errorReport — Worker crash detected. Running manual cleanup.`
  );

  const billingHoldId = job?.data?.billingHoldId || job?.data?.input?.billing_hold_id;
  const workflowId    = job?.data?.input?.workflow_id;

  // 1. Rollback credits (idempotent: safe to run multiple times without duplicate refunds)
  if (billingHoldId) {
    await useCaseService.rollbackPreparedBilling(billingHoldId, {
      failedMessage: err?.message || "Worker crash",
      errorCategory: "WORKER_CRASH",
    }).catch((rollbackErr) => {
      workerLogger.error(
        { jobId: job?.id, billingHoldId, err: rollbackErr.message },
        `[Worker] Billing rollback failed for hold ${billingHoldId} — manual review required.`
      );
    });
  }

  // 2. Update media status → "failed"
  if (workflowId && db?.media) {
    await db.media.findByWorkflow(workflowId).then((list) => {
      const pending = list?.find((m) => m.status === "processing" || m.status === "pending");
      if (pending?.id) {
        return db.media.updateMedia(pending.id, {
          status: "failed",
          error_message: "Generation failed unexpectedly. Your credits have been refunded.",
        });
      }
    }).catch((dbErr) => {
      workerLogger.error(
        { jobId: job?.id, workflowId, err: dbErr.message },
        `[Worker] Media status update failed for workflow ${workflowId} — manual review required.`
      );
    });
  }
}

useCaseWorker.on("failed", handleUseCaseWorkerFailure);

export default useCaseWorker;
