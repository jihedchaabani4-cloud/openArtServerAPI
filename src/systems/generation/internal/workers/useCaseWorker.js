import "dotenv/config";
import { EventEmitter } from "node:events";
import { Worker } from "bullmq";
import { workerRedisConnection, wrapWorkerJob, createLogger, LogEvents, envConfig } from "#shared";
import { markMediaFailed } from "#media/tools";
import { USECASE_QUEUE_NAME } from "../services/jobQueueService.js";
import { getExecutionEngine } from "../services/serviceAccessor.js";

const workerLogger = createLogger("worker");

/**
 * Ensures the generation worker only boots after `src/container.js` has wired
 * `ExecutionEngine` (and all peer systems: billing, media, identity).
 */
export function assertWorkerConfigured() {
  const engine = getExecutionEngine();
  if (!engine) {
    throw new Error(
      'ExecutionEngine is not configured in generation serviceAccessor. Start the worker via root "worker.js" (npm run start:worker / npm run dev:worker) so src/container.js wires all systems first.'
    );
  }
  return engine;
}

if (!envConfig.isTest) {
  assertWorkerConfigured();
  workerLogger.info(
    {
      event: "worker.start",
      queue: USECASE_QUEUE_NAME,
    },
    `Dedicated Generation & Workflow Worker listening on Redis queue: "${USECASE_QUEUE_NAME}"`
  );
}

/**
 * Processes a single queued V3 execution job via `ExecutionEngine.execute(...)`.
 * Preserves per-job identity (`executionId`, `workflowRunId`, `jobId`), `billingHoldId`,
 * and `serverContext` targets.
 */
export async function processUseCaseJob(job) {
  const engine = assertWorkerConfigured();

  const {
    useCaseId,
    workflowId,
    input = {},
    userId,
    billingHoldId = null,
    executionId = null,
    workflowRunId = null,
    serverContext = null,
  } = job?.data || {};

  const runId = workflowRunId || executionId || null;
  const mergedInput =
    serverContext && typeof serverContext === "object"
      ? {
          ...input,
          ...(serverContext.workflowId && !input.serverWorkflowId
            ? { serverWorkflowId: serverContext.workflowId }
            : {}),
          ...(Array.isArray(serverContext.mediaIds) &&
          serverContext.mediaIds.length > 0 &&
          !input.serverMediaIds
            ? { serverMediaIds: serverContext.mediaIds }
            : {}),
          ...(serverContext.projectId && !input.serverProjectId
            ? { serverProjectId: serverContext.projectId }
            : {}),
        }
      : input;

  workerLogger.debug(
    { useCaseId, workflowId, userId, executionId, workflowRunId, jobId: job?.id },
    `Processing V3 workflow "${useCaseId || workflowId}" for user ${userId}`
  );

  return engine.execute({
    useCaseId,
    workflowId,
    input: mergedInput,
    userId,
    billingHoldId,
    executionId: executionId || runId,
    runId,
    jobId: job?.id ?? null,
  });
}

/**
 * Dedicated Generation & Workflow Execution Worker
 */
export const useCaseWorker = envConfig.isTest
  ? Object.assign(new EventEmitter(), { close: async () => {} })
  : new Worker(USECASE_QUEUE_NAME, wrapWorkerJob("usecase-worker", processUseCaseJob), {
      connection: workerRedisConnection,
      concurrency: 10,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    });

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

/**
 * Worker crash recovery handler.
 * If `ExecutionEngine.execute` already handled the error (`err.errorReport` present), skips duplicate cleanup.
 * Otherwise rolls back the credit hold via `engine.rollbackHold` and marks ONLY this job's `directMediaIds`
 * failed via `#media/tools` `markMediaFailed` (never wiping sibling runs on a shared workflow).
 */
export async function handleUseCaseWorkerFailure(job, err) {
  if (err?.errorReport) {
    workerLogger.debug(
      { event: LogEvents.JOB_FAILED, jobId: job?.id, err },
      `[Worker] Job #${job?.id} failed with errorReport — cleanup already done by ExecutionEngine.execute.`
    );
    return;
  }

  workerLogger.error({ event: LogEvents.JOB_FAILED, jobId: job?.id, err }, `Job #${job?.id} FAILED: ${err?.message}`);

  workerLogger.warn(
    { jobId: job?.id },
    `[Worker] Job #${job?.id} failed without errorReport — Worker crash detected. Running crash cleanup.`
  );

  const engine = getExecutionEngine();
  const billingHoldId = job?.data?.billingHoldId || job?.data?.input?.billing_hold_id || null;

  if (billingHoldId && engine) {
    await engine
      .rollbackHold(billingHoldId, {
        failedMessage: err?.message || "Worker crash",
        errorCategory: "WORKER_CRASH",
      })
      .catch((rollbackErr) => {
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
    ...(job?.data?.input?.mediaId ? [job.data.input.mediaId] : []),
    ...(job?.data?.input?.pendingMediaId ? [job.data.input.pendingMediaId] : []),
    ...(job?.data?.serverContext?.pendingMediaId ? [job.data.serverContext.pendingMediaId] : []),
  ].filter((id) => typeof id === "string" && id.trim());

  const uniqueDirectMediaIds = [...new Set(directMediaIds)];

  for (const mediaId of uniqueDirectMediaIds) {
    await markMediaFailed({
      mediaId,
      errorCode: "WORKER_CRASH",
      errorMessage: failMessage,
    }).catch((mediaErr) => {
      workerLogger.error(
        { jobId: job?.id, mediaId, err: mediaErr.message },
        `[Worker] Direct media status update failed for media ${mediaId} — manual review required.`
      );
    });
  }
}

export default useCaseWorker;
