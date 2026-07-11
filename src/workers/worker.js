import "dotenv/config";
import { Worker, UnrecoverableError } from "bullmq";
import { workerRedisConnection } from "../queue/redis.js";
import { QUEUE_NAME } from "../queue/queue.js";
import { resolveTreatment, treatmentDeps } from "../treatments/treatmentRegistry.js";
import { processWorkflowJob, WORKFLOW_ARCHITECTURE_JOB_TYPE } from "../workflows/workflowJobProcessor.js";

function isPermanentJobError(error) {
  const message = String(error?.message || error || "").toLowerCase();

  // Do not use a bare "workflow" match — it blocks retries on transient DB/workflow errors.
  return [
    "insufficient credits",
    "prompt rejected",
    "model not found",
    "provider not found",
    "does not implement runjob",
    "missing configuration",
    "not support",
    "not an image model",
    "workflow not found",
    "unknown workflow",
    "invalid workflow_id",
  ].some((needle) => message.includes(needle));
}

const isEnabled = process.env.WORKER_ENABLED !== "false";

/** Long jobs (video) must hold the BullMQ lock long enough; renewed periodically while processing. */
const LOCK_MS = parseInt(process.env.WORKER_LOCK_DURATION_MS || String(5 * 60 * 1000), 10);

export const worker = isEnabled ? new Worker(
  QUEUE_NAME,
  async (job) => {
    const { type, payload } = job.data || {};

    if (!type || !payload) {
      throw new Error(`Invalid job payload for job ${job.id}. Expected { type, payload }.`);
    }

    if (type === WORKFLOW_ARCHITECTURE_JOB_TYPE) {
      return processWorkflowJob(payload);
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

    // ── Redis / BullMQ — avoid false “stalled” on long video generations ─────
    stalledInterval:  60_000,
    maxStalledCount:  2,
    lockDuration:     LOCK_MS,
    lockRenewTime:    Math.min(30_000, Math.floor(LOCK_MS / 2)),
    drainDelay:       10_000,
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

  // Rate limit hit — pause the worker immediately to stop the flood (Dev mode only)
  if (msg.includes("max requests limit exceeded")) {
    if (process.env.NODE_ENV === "development") {
      console.error("🛑 [Worker] Upstash rate limit reached! Pausing worker... (Dev mode)");
      worker.pause().catch(console.error);
    } else {
      console.error("🛑 [Worker] Upstash rate limit reached! (Prod mode - not pausing)");
    }
    return;
  }

  // Any other Redis error — log normally
  console.error("[Worker] Internal Redis error:", msg);
});

  // Graceful shutdown: finish active job + release lock cleanly so Redis does not leave a “stalled” job that replays on next dev restart.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[Worker] ${signal} — draining (close worker, wait for active job)...`);
    try {
      await worker.close();
      console.log("[Worker] Stopped cleanly.");
    } catch (err) {
      console.error("[Worker] close() error:", err?.message || err);
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

