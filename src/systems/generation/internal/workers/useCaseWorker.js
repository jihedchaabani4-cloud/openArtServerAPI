import "dotenv/config";
import { EventEmitter } from "node:events";
import { Worker } from "bullmq";
import { wrapWorkerJob, createLogger, LogEvents, envConfig } from "#shared";
import { workerRedisConnection } from "#shared/redis";
import { createWorkflowEngine } from "#workflow-engine/tools";
import { USECASE_QUEUE_NAME } from "../services/WorkflowDispatchService.js";
import { getMarkMediaFailed, getWorkflowAdapters } from "../services/serviceAccessor.js";
import { GenerationError, sanitizeClientError } from "../errors.js";

const workerLogger = createLogger("worker");

const REQUIRED_WORKER_ADAPTER_KEYS = Object.freeze([
  "getCharacterPromptContext",
  "getElementPromptContext",
  "getMediaById",
  "getMediaUrls",
  "getWorkflowPrimaryMedia",
  "completeMedia",
  "persistExternalMedia",
  "assertOwns",
  "assertOwnsAny",
]);

/**
 * Creates Generation's pending-media failure handler scoped strictly to explicit
 * `serverContext.mediaIds` (never touching generic read-only `input.media_id`).
 * Formats client-facing credit-refund copy using Generation's `sanitizeClientError`.
 *
 * @param {{ markMediaFailed: Function }} deps
 */
export function createGenerationFailureHandler({ markMediaFailed }) {
  return async function onGenerationFailure({
    stage = "execute",
    runId = null,
    workflowId = null,
    serverContext = null,
    errorCode = null,
    errorMessage = null,
    error = null,
  } = {}) {
    if (typeof markMediaFailed !== "function") {
      return;
    }

    const rawIds = Array.isArray(serverContext?.mediaIds) ? serverContext.mediaIds : [];
    const mediaIds = [...new Set(rawIds.filter((id) => typeof id === "string" && id.trim().length > 0))];
    if (mediaIds.length === 0) {
      return;
    }

    const sanitized = error ? sanitizeClientError(error) : null;
    const finalErrorCode = sanitized?.code || errorCode || "GENERATION_FAILED";
    const finalErrorMessage =
      sanitized?.userMessage ||
      errorMessage ||
      "Generation failed due to an unexpected internal error. Your credits have been refunded.";

    for (const mediaId of mediaIds) {
      try {
        await markMediaFailed({
          mediaId,
          errorMessage: finalErrorMessage,
          errorCode: finalErrorCode,
        });
      } catch (cleanupErr) {
        workerLogger.warn(
          { stage, runId, workflowId, mediaId, err: cleanupErr?.message },
          "[UseCaseWorker] Failed to mark pending media as failed during failure hook"
        );
      }
    }
  };
}

/**
 * Ensures the workflow worker only boots after `src/container.js` has wired
 * Generation's `markMediaFailed` adapter and all required workflow domain adapters.
 */
export function assertWorkerConfigured() {
  const markMediaFailed = getMarkMediaFailed();
  if (typeof markMediaFailed !== "function") {
    throw new GenerationError(
      "WORKER_NOT_CONFIGURED",
      'markMediaFailed is not configured in generation serviceAccessor. Start the worker via root "worker.js" (npm run start:worker / npm run dev:worker) so src/container.js wires all systems first.',
      { statusCode: 500 }
    );
  }

  const workflowAdapters = getWorkflowAdapters();
  const missingAdapters = REQUIRED_WORKER_ADAPTER_KEYS.filter(
    (key) => typeof workflowAdapters?.[key] !== "function"
  );
  if (missingAdapters.length > 0) {
    throw new GenerationError(
      "WORKER_NOT_CONFIGURED",
      `Workflow adapters are not configured in generation serviceAccessor (missing: ${missingAdapters.join(", ")}). Start the worker via root "worker.js" so src/container.js wires all systems first.`,
      { statusCode: 500 }
    );
  }

  return { markMediaFailed, workflowAdapters };
}

if (!envConfig.isTest) {
  assertWorkerConfigured();
  workerLogger.info(
    {
      event: "worker.start",
      queue: USECASE_QUEUE_NAME,
      concurrency: envConfig.useCaseWorkerConcurrency,
    },
    `Dedicated Workflow Execution Worker listening on Redis queue: "${USECASE_QUEUE_NAME}"`
  );
}

/**
 * Processes a single queued workflow job by spawning a fresh isolated ExecutionEngine
 * instance from `#workflow-engine/tools` (sharing the frozen singleton NodeRegistry
 * and cached GraphCompiler) with Generation's scoped pending-media failure handler.
 */
export async function processUseCaseJob(job, { engineFactory = createWorkflowEngine } = {}) {
  const { markMediaFailed, workflowAdapters } = assertWorkerConfigured();

  const {
    workflow = null,
    useCaseId,
    workflowId,
    input = {},
    userId = null,
    executionId = null,
    workflowRunId = null,
    serverContext = null,
  } = job?.data || {};

  const runId = workflowRunId || executionId || null;
  const onFailure = createGenerationFailureHandler({ markMediaFailed });
  const engine = engineFactory({
    adapters: workflowAdapters,
    onFailure,
  });

  workerLogger.debug(
    { useCaseId, workflowId, userId, executionId, workflowRunId, jobId: job?.id },
    `Processing workflow "${useCaseId || workflow?.id || workflowId}"`
  );

  return engine.runWorkflow(workflow || useCaseId || workflowId, input, {
    userId,
    executionId: executionId || runId,
    runId,
    jobId: job?.id ?? null,
    serverContext,
  });
}

/**
 * BullMQ worker configuration for long-running workflow jobs.
 * - `concurrency`: bounded via `USECASE_WORKER_CONCURRENCY` (default 6)
 * - `lockDuration: 300_000` (5 min) with `lockRenewTime: 60_000` (1 min) prevents false stalls.
 * - `maxStalledCount: 0` fails closed so a stalled worker NEVER re-runs a job twice.
 */
export const USECASE_WORKER_OPTIONS = Object.freeze({
  concurrency: envConfig.useCaseWorkerConcurrency,
  lockDuration: 300_000,
  lockRenewTime: 60_000,
  stalledInterval: 60_000,
  maxStalledCount: 0,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
});

/**
 * Dedicated Universal Workflow Execution Worker
 */
export const useCaseWorker = envConfig.isTest
  ? Object.assign(new EventEmitter(), { close: async () => {} })
  : new Worker(USECASE_QUEUE_NAME, wrapWorkerJob("usecase-worker", processUseCaseJob), {
      connection: workerRedisConnection,
      ...USECASE_WORKER_OPTIONS,
    });

useCaseWorker.on("error", (err) => {
  workerLogger.error(
    { event: "usecase_worker.error", err: err?.message || String(err) },
    `[UseCaseWorker] Redis worker error: ${err?.message || String(err)}`
  );
});

useCaseWorker.on("stalled", (jobId) => {
  workerLogger.warn(
    { event: "usecase_worker.stalled", jobId },
    `[UseCaseWorker] Job #${jobId} stalled (maxStalledCount=0; failing closed without re-execution)`
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
 * Worker crash / unhandled exception recovery handler.
 * If `ExecutionEngine.runWorkflow` already handled the error (`err.errorReport` present),
 * skips duplicate cleanup. Otherwise invokes Generation's pending-media failure handler directly.
 */
export async function handleUseCaseWorkerFailure(job, err) {
  if (err?.errorReport) {
    workerLogger.debug(
      { event: LogEvents.JOB_FAILED, jobId: job?.id, err },
      `[Worker] Job #${job?.id} failed with errorReport — cleanup already done by ExecutionEngine.runWorkflow.`
    );
    return;
  }

  workerLogger.error({ event: LogEvents.JOB_FAILED, jobId: job?.id, err }, `Job #${job?.id} FAILED: ${err?.message}`);

  workerLogger.warn(
    { jobId: job?.id },
    `[Worker] Job #${job?.id} failed without errorReport — Worker failure detected. Marking pending media failed.`
  );

  const markMediaFailed = getMarkMediaFailed();
  if (typeof markMediaFailed === "function") {
    const onFailure = createGenerationFailureHandler({ markMediaFailed });
    await onFailure({
      stage: "worker_crash",
      jobId: job?.id ?? null,
      runId: job?.data?.workflowRunId || job?.data?.executionId || null,
      workflowId: job?.data?.useCaseId || job?.data?.workflowId || null,
      userId: job?.data?.userId || null,
      input: job?.data?.input || {},
      serverContext: job?.data?.serverContext || null,
      errorCode: "WORKER_CRASH",
      errorMessage: "Generation failed unexpectedly. Your credits have been refunded. Please try again.",
      error: err,
    });
  }
}

export default useCaseWorker;
