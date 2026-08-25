import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";

export const USECASE_QUEUE_NAME = "v2-workflow-jobs";

let useCaseQueueInstance = null;

export async function getUseCaseQueue() {
  if (!useCaseQueueInstance) {
    const { redisConnection } = await import("../queue/redis.js");
    useCaseQueueInstance = new Queue(USECASE_QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: "exponential",
          delay: 1000,
        },
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
    return queue.add(
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
      },
      {
        jobId: `usecase-${finalExecutionId}`,
      }
    );
  }

  /**
   * Enqueue a single node execution job.
   * @param {string} runId
   * @param {string} nodeId
   * @returns {Promise<import('bullmq').Job>}
   */
  async addNodeExecutionJob(runId, nodeId) {
    const queue = await this.getQueue();
    return queue.add(
      "node-execute",
      { runId, nodeId },
      { jobId: `node-${runId}-${nodeId}` }
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
