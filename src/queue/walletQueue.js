import { Queue } from "bullmq";
import { redisConnection } from "./redis.js";

/**
 * Wallet Maintenance Queue
 * ─────────────────────────────────────────────────────────────────────────────
 * Dedicated BullMQ queue for wallet housekeeping jobs.
 * Completely separate from the main 'jobs' queue (generation worker) so that
 * wallet maintenance jobs never block or interfere with AI generation jobs.
 *
 * Jobs registered via scheduleWalletJobs():
 *   expire-stale-holds  — every 5 min
 *   retry-failed-ops    — every 5 min
 *   reconcile-wallets   — daily at 03:00 UTC
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const WALLET_QUEUE_NAME = "wallet-maintenance";

export const walletMaintenanceQueue = new Queue(WALLET_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    // Keep only a small tail of completed/failed for inspection
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 20 },
  },
});

/**
 * Register all recurring wallet maintenance jobs.
 * Uses upsertJobScheduler() — the BullMQ v5 idiomatic API for repeatable jobs.
 * Safe to call multiple times on startup (idempotent — updates, does not duplicate).
 */
export async function scheduleWalletJobs() {
  // Expire holds that have been PENDING past their expires_at — every 5 minutes
  await walletMaintenanceQueue.upsertJobScheduler(
    "expire-stale-holds",
    { every: 5 * 60 * 1000 },
    { data: {}, opts: {} }
  );

  // Retry failed wallet operations (commit / rollback / credit) — every 5 minutes
  await walletMaintenanceQueue.upsertJobScheduler(
    "retry-failed-ops",
    { every: 5 * 60 * 1000 },
    { data: {}, opts: {} }
  );

  // Daily financial reconciliation: ledger balance vs SUM(transactions) — 03:00 UTC
  await walletMaintenanceQueue.upsertJobScheduler(
    "reconcile-wallets",
    { pattern: "0 3 * * *" },
    { data: {}, opts: {} }
  );

  console.log(
    "[WalletQueue] Scheduled: expire-stale-holds (every 5 min), retry-failed-ops (every 5 min), reconcile-wallets (daily 03:00 UTC)"
  );
}
