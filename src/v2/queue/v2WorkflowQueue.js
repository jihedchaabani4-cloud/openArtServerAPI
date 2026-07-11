import { Queue } from "bullmq";
import { redisConnection } from "../../queue/redis.js";

export const V2_QUEUE_NAME = "v2-workflow-jobs";

export const v2WorkflowQueue = new Queue(V2_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

/**
 * Enqueue a workflow run orchestrator job.
 * @param {string} runId
 * @returns {Promise<import('bullmq').Job>}
 */
export async function enqueueWorkflowRun(runId) {
  // Do not use a fixed jobId to prevent BullMQ from ignoring duplicate enqueues
  return v2WorkflowQueue.add("workflow-run", { runId });
}

/**
 * Enqueue a single node execution job.
 * @param {string} runId
 * @param {string} nodeId
 * @returns {Promise<import('bullmq').Job>}
 */
export async function enqueueNodeExecute(runId, nodeId) {
  // Use a unique jobId to prevent duplicate node execution in same tick
  return v2WorkflowQueue.add(
    "node-execute",
    { runId, nodeId },
    { jobId: `node-${runId}-${nodeId}` }
  );
}
