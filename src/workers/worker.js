import "dotenv/config";
import { Worker, UnrecoverableError } from "bullmq";
import { workerRedisConnection } from "../queue/redis.js";
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

const isEnabled = process.env.WORKER_ENABLED !== "false";

export const worker = isEnabled ? new Worker(
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
    connection: workerRedisConnection,  // ← dedicated connection, no commandTimeout
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || "1", 10),

    // ── Redis Optimization (reduce idle command pressure on Upstash) ────────
    stalledInterval:  30_000,   // Check for stalled jobs every 30s (default: 5s)
    maxStalledCount:  2,        // Allow 2 stalls before marking job failed
    lockDuration:     30_000,   // Job lock TTL in Redis
    lockRenewTime:    15_000,   // Renew lock halfway through lockDuration
    drainDelay:       10_000,   // ← Wait 10s before re-checking empty queue (default: 5ms)
  }
) : null;

if (!isEnabled) {
  console.log("💤 [Worker] WORKER_ENABLED is false. Worker is in sleep mode (no Redis connections).");
  // Keep process alive so nodemon doesn't restart it constantly
  setInterval(() => {}, 3600000);
} else {
  worker.on("completed", (job) => {
    console.log(`[Worker] ✅ Job ${job.data?.type || job.name} (${job.id}) completed.`);
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] ❌ Job ${job?.data?.type || job?.name} (${job?.id}) failed: ${err.message}`);
});

// ── Error handler with cooldown to prevent log spam ──────────────────────────
let _lastErrLog = 0;
worker.on("error", (err) => {
  const msg = err.message || "";

  // "Command timed out" can appear briefly during reconnect — not critical
  // Suppress repeated logs but allow 1 every 10 seconds to show it's happening
  if (msg.includes("Command timed out")) {
    const now = Date.now();
    if (now - _lastErrLog > 10_000) {
      console.warn("[Worker] ⚠️  Redis command timed out (reconnecting...)");
      _lastErrLog = now;
    }
    return;
  }

  // Rate limit hit — pause the worker immediately to stop the flood
  if (msg.includes("max requests limit exceeded")) {
    console.error("🛑 [Worker] Upstash rate limit reached! Pausing worker...");
    worker.pause().catch(console.error);
    return;
  }

  // Any other Redis error — log normally
  console.error("[Worker] Internal Redis error:", msg);
});
}

