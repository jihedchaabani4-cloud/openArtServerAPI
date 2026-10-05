import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { getCleanContext, createLogger, LogEvents } from "../infrastructure/logging/index.js";

/**
 * Thrown when all dispatch attempts to Redis/BullMQ have failed.
 * This is an infrastructure error — callers should not inspect its internals.
 * UseCaseService catches this and handles business cleanup (rollback, status update).
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
    const { redisConnection } = await import("../queue/redis.js");
    useCaseQueueInstance = new Queue(USECASE_QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 1, // Retries are handled at the Node level inside DAG, NEVER re-run entire UseCase
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return useCaseQueueInstance;
}

/**
 * Centralized Job Queue Service for UseCases & Background Tasks.
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
   * Enqueue a UseCase execution job for background worker processing.
   * @param {Object} params
   * @param {string} params.useCaseId
   * @param {Object} params.input
   * @param {string} params.userId
   * @param {string} [params.executionId]
   * @param {string} [params.workflowRunId]
   * @param {string} [params.billingHoldId]
   * @param {string} [params.idempotencyKey]
   * @param {string} [params.traceId]
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
  }) {
    const finalExecutionId = executionId || workflowRunId || input?.workflow_id || randomUUID();
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

    queueLogger.info(
      {
        event: LogEvents.JOB_QUEUED,
        jobId,
        useCase: useCaseId,
        userId: jobContext.userId,
      },
      `Job ${jobId} enqueued for usecase "${useCaseId}"`
    );

    const DISPATCH_MAX_ATTEMPTS = 3;
    const DISPATCH_BASE_BACKOFF_MS = 300;

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
            _context: jobContext,
          },
          {
            jobId,
          }
        );
        if (attempt > 1) {
          queueLogger.info({ jobId, attempt }, `Job ${jobId} dispatched successfully on attempt ${attempt}`);
        }
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

    // All attempts exhausted — throw a clean infrastructure error upward
    throw new QueueDispatchError(lastErr, DISPATCH_MAX_ATTEMPTS);
  }

  /**

   * Enqueue a single node execution job.
   * @param {string} runId
   * @param {string} nodeId
   * @returns {Promise<import('bullmq').Job>}
   */
  async addNodeExecutionJob(runId, nodeId) {
    const queue = await this.getQueue();
    const jobId = `node-${runId}-${nodeId}`;
    const activeContext = getCleanContext();

    return queue.add(
      "node-execute",
      { runId, nodeId, _context: activeContext },
      { jobId }
    );
  }

  /**
   * Get BullMQ job by ID.
   * @param {string} jobId
   */
  async getJob(jobId) {
    const queue = await this.getQueue();
    return queue.getJob(jobId);
  }

  /**
   * Get job status and progress.
   * @param {string} jobId
   */
  async getJobStatus(jobId) {
    const job = await this.getJob(jobId);
    if (!job) return null;
    const state = await job.getState();
    return {
      id: job.id,
      state,
      progress: job.progress,
      failedReason: job.failedReason,
      returnvalue: job.returnvalue,
      timestamp: job.timestamp,
    };
  }

  /**
   * Remove a job from the queue.
   * @param {string} jobId
   */
  async removeJob(jobId) {
    const job = await this.getJob(jobId);
    if (job) {
      await job.remove();
      return true;
    }
    return false;
  }
}

export const jobQueueService = new JobQueueService();
export default jobQueueService;
