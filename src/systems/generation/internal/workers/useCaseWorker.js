import "dotenv/config";
import { EventEmitter } from "node:events";
import { Worker } from "bullmq";
import { workerRedisConnection, wrapWorkerJob, createLogger, LogEvents, envConfig } from "#shared";
import { USECASE_QUEUE_NAME } from "../services/jobQueueService.js";
import { getExecutionEngine } from "../services/serviceAccessor.js";

const workerLogger = createLogger("worker");

/**
 * Ensures the workflow worker only boots after `src/container.js` has wired `ExecutionEngine`.
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
    `Dedicated Workflow Execution Worker listening on Redis queue: "${USECASE_QUEUE_NAME}"`
  );
}

/**
 * Processes a single queued V3 workflow job via `ExecutionEngine.runWorkflow(..., { async: false })`.
 * Domain-agnostic: forwards workflow blueprint/useCaseId, input, and execution identity only.
 */
export async function processUseCaseJob(job) {
  const engine = assertWorkerConfigured();

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

  workerLogger.debug(
    { useCaseId, workflowId, userId, executionId, workflowRunId, jobId: job?.id },
    `Processing V3 workflow "${useCaseId || workflow?.id || workflowId}"`
  );

  return engine.runWorkflow(workflow || useCaseId || workflowId, input, {
    async: false,
    userId,
    executionId: executionId || runId,
    runId,
    jobId: job?.id ?? null,
    serverContext,
  });
}

/**
 * BullMQ worker configuration for long-running workflow jobs.
 * - `lockDuration: 300_000` (5 min) with `lockRenewTime: 60_000` (1 min) prevents false stalls.
 * - `maxStalledCount: 0` fails closed so a stalled worker NEVER re-runs a job twice.
 */
export const USECASE_WORKER_OPTIONS = Object.freeze({
  concurrency: 10,
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
 * Worker crash recovery handler.
 * If `ExecutionEngine.runWorkflow` already handled the error (`err.errorReport` present), skips duplicate cleanup.
 * Otherwise notifies registered external failure hooks on `ExecutionEngine`.
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
    `[Worker] Job #${job?.id} failed without errorReport — Worker crash detected. Notifying failure hooks.`
  );

  const engine = getExecutionEngine();
  if (engine && typeof engine.notifyFailure === "function") {
    await engine.notifyFailure({
      stage: "worker_crash",
      jobId: job?.id ?? null,
      runId: job?.data?.workflowRunId || job?.data?.executionId || null,
      workflowId: job?.data?.useCaseId || job?.data?.workflowId || null,
      userId: job?.data?.userId || null,
      input: job?.data?.input || {},
      serverContext: job?.data?.serverContext || null,
      errorCode: "WORKER_CRASH",
      errorMessage: "Generation failed unexpectedly. Please try again.",
      error: err,
    });
  }
}

export default useCaseWorker;
