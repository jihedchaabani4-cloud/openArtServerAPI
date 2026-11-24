/**
 * jobQueueService
 * @owns System 1: Generation & Workflows — BullMQ queue dispatch and lifecycle management.
 */
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { getCleanContext, createLogger, LogEvents, redisConnection } from "#shared";

/**
 * Thrown when all dispatch attempts to Redis/BullMQ have failed.
 * This is an infrastructure error — callers should not inspect its internals.
 * ExecutionEngine catches this and handles business cleanup (rollback, status update).
 */
export class QueueDispatchError extends Error {
  constructor(cause, attempts) {
    super(`Queue dispatch failed after ${attempts} attempt(s): ${cause?.message ?? cause}`);
    this.name = "QueueDispatchError";
    this.code = "QUEUE_DISPATCH_FAILED";
    this.statusCode = 503;
    this.cause = cause;
    this.attempts = attempts;
  }
}

const queueLogger = createLogger("queue");

export const USECASE_QUEUE_NAME = "v2-workflow-jobs";

let useCaseQueueInstance = null;

export async function getUseCaseQueue() {
  if (!useCaseQueueInstance) {
    useCaseQueueInstance = new Queue(USECASE_QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 1, // Retries are handled at the Node level inside DAG, NEVER re-run entire workflow
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });

    useCaseQueueInstance.on("error", (err) => {
      queueLogger.error(
        { event: "usecase_queue.error", err: err?.message || String(err) },
        `[UseCaseQueue] Redis queue error: ${err?.message || String(err)}`
      );
    });
  }
  return useCaseQueueInstance;
}

/**
 * Centralized Job Queue Service for V3 Workflow Executions.
 */
export class JobQueueService {
  constructor(queue = null) {
    this.queue = queue;
  }

  async getQueue() {
    if (!this.queue) {
      this.queue = await getUseCaseQueue();
    }
    return this.queue;
  }

  /**
   * Enqueue an independent V3 workflow execution job for background worker processing.
   *
   * @param {Object} params
   * @param {string} params.useCaseId
   * @param {Object} params.input
   * @param {string} params.userId
   * @param {string} [params.executionId]
   * @param {string} [params.workflowRunId]
   * @param {string} [params.billingHoldId]
   * @param {string} [params.idempotencyKey]
   * @param {string} [params.traceId]
   * @param {Object|null} [params.serverContext]
   * @returns {Promise<import('bullmq').Job>}
   */
  async addUseCaseJob({
    useCaseId,
    input,
    userId,
    executionId = null,
    workflowRunId = null,
    billingHoldId = null,
    idempotencyKey = null,
    traceId = null,
    serverContext = null,
  }) {
    const finalExecutionId = executionId || workflowRunId || randomUUID();
    const queue = await this.getQueue();
    const jobId = `usecase-${finalExecutionId}`;

    const activeContext = getCleanContext();
    const jobContext = {
      ...activeContext,
      requestId: activeContext.requestId || traceId || finalExecutionId,
      userId: userId || activeContext.userId,
      useCase: useCaseId,
      operation: "run-usecase",
    };

    const DISPATCH_MAX_ATTEMPTS = 3;
    const DISPATCH_BASE_BACKOFF_MS = 300;
    const enqueueStartMs = performance.now();

    let lastErr = null;
    for (let attempt = 1; attempt <= DISPATCH_MAX_ATTEMPTS; attempt++) {
      try {
        const job = await queue.add(
          "run-usecase",
          {
            useCaseId,
            input,
            userId,
            executionId: finalExecutionId,
            workflowRunId: workflowRunId || finalExecutionId,
            billingHoldId,
            idempotencyKey,
            traceId: traceId || finalExecutionId,
            serverContext: serverContext || null,
            _context: jobContext,
          },
          {
            jobId,
          }
        );
        const enqueueDurationMs = Math.round(performance.now() - enqueueStartMs);
        queueLogger.info(
          {
            event: LogEvents.JOB_QUEUED,
            jobId,
            useCase: useCaseId,
            userId: jobContext.userId,
            attempt,
            enqueueDurationMs,
          },
          `Job ${jobId} enqueued for usecase "${useCaseId}"`
        );
        return job;
      } catch (err) {
        lastErr = err;
        if (attempt < DISPATCH_MAX_ATTEMPTS) {
          const backoffMs = DISPATCH_BASE_BACKOFF_MS * Math.pow(2, attempt - 1); // 300, 600ms
          queueLogger.warn(
            { jobId, attempt, nextAttemptInMs: backoffMs, err: err.message },
            `[JobQueueService] Dispatch attempt ${attempt}/${DISPATCH_MAX_ATTEMPTS} failed. Retrying in ${backoffMs}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    throw new QueueDispatchError(lastErr, DISPATCH_MAX_ATTEMPTS);
  }
}

export const jobQueueService = new JobQueueService();
export default jobQueueService;
