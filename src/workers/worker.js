import "dotenv/config";
import { Worker, UnrecoverableError } from "bullmq";
import { redisConnection } from "../queue/redis.js";
import { QUEUE_NAME } from "../queue/queue.js";
import { resolveTreatment, treatmentDeps } from "../treatments/treatmentRegistry.js";

function isPermanentJobError(error) {
  const message = String(error?.message || error || "").toLowerCase();

  return [
    "insufficient credits",
    "prompt rejected",
    "model not found",
    "provider not found",
    "does not implement runjob",
    "missing configuration",
    "not support",
    "not an image model",
    "workflow",
  ].some((needle) => message.includes(needle));
}

export const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { type, payload } = job.data || {};

    if (!type || !payload) {
      throw new Error(`Invalid job payload for job ${job.id}. Expected { type, payload }.`);
    }

    const treatment = resolveTreatment(type, treatmentDeps);
    if (typeof treatment.runJob !== "function") {
      throw new Error(`Treatment "${type}" does not implement runJob(payload)`);
    }

    try {
      return await treatment.runJob(payload);
    } catch (error) {
      if (isPermanentJobError(error)) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || "10", 10),
  }
);

worker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.data?.type || job.name} (${job.id}) completed successfully.`);
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.data?.type || job?.name} (${job?.id}) failed: ${err.message}`);
});

worker.on("error", (err) => {
  console.error("[Worker] Internal Redis error:", err);
});
