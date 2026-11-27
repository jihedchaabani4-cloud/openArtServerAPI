/**
 * WorkflowDispatchService
 * @owns System 1: Generation & Workflows — fail-fast workflow input verification and BullMQ queue dispatch.
 */
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { getCleanContext, createLogger, LogEvents } from "#shared";
import { redisConnection } from "#shared/redis";
import { verifyInput as defaultVerifyInput } from "#workflow-engine/tools";
import {
  GenerationValidationError,
  GenerationNotFoundError,
  GenerationCompilationError,
  GenerationQueueDispatchError,
} from "../errors.js";

const queueLogger = createLogger("workflow-dispatch");

export const USECASE_QUEUE_NAME = "workflow-jobs";

const DISPATCH_MAX_ATTEMPTS = 3;
const DISPATCH_BASE_BACKOFF_MS = 300;

let useCaseQueueInstance = null;

function mergeServerContext(input = {}, serverContext = null) {
  if (!serverContext || typeof serverContext !== "object") return { ...input };
  return {
    ...serverContext,
    ...input,
  };
}

export async function getUseCaseQueue() {
  if (!useCaseQueueInstance) {
    useCaseQueueInstance = new Queue(USECASE_QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 1, // Single-attempt fail-fast: never re-run paid AI workflows automatically
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });

    useCaseQueueInstance.on("error", (err) => {
      queueLogger.error(
        { event: "usecase_queue.error", err: err?.message || String(err) },
        `[WorkflowDispatchService] Redis queue error: ${err?.message || String(err)}`
      );
    });
  }
  return useCaseQueueInstance;
}

/**
 * Single authoritative queue-dispatch module for asynchronous workflow jobs:
 * 1. Validates workflow inputs & DAG fail-fast via `#workflow-engine/tools` `verifyInput()`.
 * 2. Enqueues once into Redis/BullMQ (`workflow-jobs`) with transient enqueue retry backoff.
 * 3. Throws `GenerationQueueDispatchError` (503) on enqueue failure so the calling intake
 *    service remains the sole owner of synchronous placeholder compensation.
 */
export class WorkflowDispatchService {
  constructor({ queue = null, verifyInput = defaultVerifyInput } = {}) {
    this.queue = queue;
    this.verifyInput = verifyInput;
  }

  async getQueue() {
    if (!this.queue) {
      this.queue = await getUseCaseQueue();
    }
    return this.queue;
  }

  async dispatch({
    workflow = null,
    useCaseId = null,
    workflowId = null,
    input = {},
    userId = null,
    executionId = null,
    runId = null,
    workflowRunId = null,
    idempotencyKey = null,
    traceId = null,
    serverContext = null,
  } = {}) {
    const workflowOrId = workflow || useCaseId || workflowId;
    const mergedInput = mergeServerContext(input, serverContext);
    const validation = this.verifyInput(workflowOrId, mergedInput);

    if (!validation.valid) {
      const firstErr = validation.errors?.[0];
      if (firstErr?.code === "USE_CASE_NOT_FOUND") {
        const err = new GenerationNotFoundError(firstErr.message, {
          resourceId: typeof workflowOrId === "string" ? workflowOrId : null,
        });
        err.code = "USE_CASE_NOT_FOUND";
        err.errorCode = "USE_CASE_NOT_FOUND";
        throw err;
      }
      if (firstErr?.code === "MISSING_REQUIRED_INPUT") {
        throw new GenerationValidationError(
          `Workflow "${validation.workflowId}" requires input "${firstErr.field}" before dispatch`,
          { field: firstErr.field }
        );
      }
      throw new GenerationCompilationError(firstErr?.message || "Workflow compilation failed");
    }

    const resolvedWorkflowId = validation.workflowId;
    const resolvedRunId = runId || executionId || workflowRunId || randomUUID();
    const effectiveTraceId = traceId || resolvedRunId;
    const referenceId = idempotencyKey || `exec:${resolvedWorkflowId}:${userId || "anon"}:${resolvedRunId}`;
    const opaqueServerContext = serverContext ?? null;
    const jobId = `usecase-${resolvedRunId}`;

    const activeContext = getCleanContext();
    const jobContext = {
      ...activeContext,
      requestId: activeContext.requestId || effectiveTraceId,
      userId: userId || activeContext.userId,
      useCase: resolvedWorkflowId,
      operation: "run-usecase",
    };

    const queue = await this.getQueue();
    const enqueueStartMs = performance.now();

    let lastErr = null;
    for (let attempt = 1; attempt <= DISPATCH_MAX_ATTEMPTS; attempt++) {
      try {
        const job = await queue.add(
          "run-usecase",
          {
            useCaseId: resolvedWorkflowId,
            ...(workflow && typeof workflow === "object" ? { workflow } : {}),
            input: mergedInput,
            userId,
            executionId: resolvedRunId,
            workflowRunId: resolvedRunId,
            idempotencyKey: referenceId,
            traceId: effectiveTraceId,
            serverContext: opaqueServerContext,
            _context: jobContext,
          },
          { jobId }
        );

        const enqueueDurationMs = Math.round(performance.now() - enqueueStartMs);
        queueLogger.info(
          {
            event: LogEvents.JOB_QUEUED,
            jobId: job?.id || jobId,
            workflowId: resolvedWorkflowId,
            runId: resolvedRunId,
            userId: jobContext.userId,
            attempt,
            enqueueDurationMs,
          },
          `[WorkflowDispatchService] Job ${job?.id || jobId} enqueued for workflow "${resolvedWorkflowId}"`
        );

        return {
          status: "queued",
          workflowId: resolvedWorkflowId,
          executionId: resolvedRunId,
          runId: resolvedRunId,
          workflowRunId: resolvedRunId,
          jobId: job?.id || null,
        };
      } catch (err) {
        lastErr = err;
        if (attempt < DISPATCH_MAX_ATTEMPTS) {
          const backoffMs = DISPATCH_BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
          queueLogger.warn(
            { jobId, attempt, nextAttemptInMs: backoffMs, err: err?.message },
            `[WorkflowDispatchService] Dispatch attempt ${attempt}/${DISPATCH_MAX_ATTEMPTS} failed. Retrying in ${backoffMs}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    queueLogger.error(
      {
        event: "V3_QUEUE_DISPATCH_FAILED",
        workflowId: resolvedWorkflowId,
        runId: resolvedRunId,
        attempts: DISPATCH_MAX_ATTEMPTS,
        err: lastErr?.message,
      },
      `[WorkflowDispatchService] Queue dispatch failed for "${resolvedWorkflowId}" after ${DISPATCH_MAX_ATTEMPTS} attempts.`
    );

    throw new GenerationQueueDispatchError(
      `Failed to enqueue workflow "${resolvedWorkflowId}": ${lastErr?.message ?? lastErr}`,
      { attempts: DISPATCH_MAX_ATTEMPTS, cause: lastErr }
    );
  }
}

export default WorkflowDispatchService;
