import "dotenv/config";
import { EventEmitter } from "node:events";
import { Worker } from "bullmq";
import { workerRedisConnection, wrapWorkerJob, createLogger, LogEvents, envConfig } from "#shared";
import { USECASE_QUEUE_NAME } from "../engine/jobQueueService.js";
import { getUseCaseService, getDefaultDb } from "../serviceAccessor.js";
import { executeNodeJob } from "../v2/runner/nodeExecutor.js";
import { executeOrchestration } from "../v2/runner/workflowRunner.js";
import { bootstrapV2 } from "../v2/bootstrap.js";
import { failWorkflowPendingMedia } from "#media/tools";

const workerLogger = createLogger("worker");

// Initialize V2 Engine, Gateways, and Register all UseCases in Worker process
if (!envConfig.isTest) {
  bootstrapV2();
  workerLogger.info({
    event: "worker.start",
    queue: USECASE_QUEUE_NAME,
  }, `Specialized UseCase Worker listening on Redis queue: "${USECASE_QUEUE_NAME}"`);
}

/**
 * 🎯 Dedicated UseCase & Node Execution Worker
 */
export const useCaseWorker = envConfig.isTest
  ? Object.assign(new EventEmitter(), { close: async () => {} })
  : new Worker(
      USECASE_QUEUE_NAME,
      wrapWorkerJob("usecase-worker", async (job) => {
        const useCaseService = getUseCaseService();

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

useCaseWorker.on("error", (err) => {
  workerLogger.error(
    { event: "usecase_worker.error", err: err?.message || String(err) },
    `[UseCaseWorker] Redis worker error: ${err?.message || String(err)}`
  );
});

if (!envConfig.isTest) {
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

  const alreadyHandled = Boolean(err?.errorReport);
  if (alreadyHandled) {
    workerLogger.debug(
      { jobId: job?.id },
      `[Worker] Job #${job?.id} failed with errorReport — cleanup already done by executeQueuedUseCase.`
    );
    return;
  }

  workerLogger.warn(
    { jobId: job?.id },
    `[Worker] Job #${job?.id} failed without errorReport — Worker crash detected. Running manual cleanup.`
  );

  const useCaseService = getUseCaseService();
  const db = getDefaultDb();

  const billingHoldId = job?.data?.billingHoldId || job?.data?.input?.billing_hold_id;
  const workflowId    = job?.data?.input?.workflow_id || job?.data?.serverContext?.workflowId || job?.data?.input?.serverWorkflowId;

  if (billingHoldId && useCaseService) {
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

  const failMessage = "Generation failed unexpectedly. Your credits have been refunded.";

  const directMediaIds = [
    ...(Array.isArray(job?.data?.serverContext?.mediaIds) ? job.data.serverContext.mediaIds : []),
    ...(Array.isArray(job?.data?.input?.serverMediaIds) ? job.data.input.serverMediaIds : []),
    ...(job?.data?.input?.media_id ? [job.data.input.media_id] : []),
    ...(job?.data?.input?.pendingMediaId ? [job.data.input.pendingMediaId] : []),
    ...(job?.data?.serverContext?.pendingMediaId ? [job.data.serverContext.pendingMediaId] : []),
  ].filter(Boolean);

  const uniqueDirectMediaIds = [...new Set(directMediaIds)];

  if (db?.media) {
    for (const mediaId of uniqueDirectMediaIds) {
      await db.media.updateMedia(mediaId, {
        status: "failed",
        error_message: failMessage,
      }).catch((dbErr) => {
        workerLogger.error(
          { jobId: job?.id, mediaId, err: dbErr.message },
          `[Worker] Direct media status update failed for media ${mediaId} — manual review required.`
        );
      });
    }
  }

  if (workflowId && db?.media) {
    await failWorkflowPendingMedia(db, workflowId, failMessage).catch((dbErr) => {
      workerLogger.error(
        { jobId: job?.id, workflowId, err: dbErr.message },
        `[Worker] Media status update failed for workflow ${workflowId} — manual review required.`
      );
    });
  }
}

export default useCaseWorker;
