import { EventEmitter } from "node:events";
import { Queue } from "bullmq";
import { redisConnection, createLogger, envConfig } from "#shared";

const queueLogger = createLogger("wallet-queue");

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

export const walletMaintenanceQueue = envConfig.isTest
  ? Object.assign(new EventEmitter(), {
      name: WALLET_QUEUE_NAME,
      upsertJobScheduler: async () => {},
      add: async () => ({}),
      close: async () => {},
    })
  : new Queue(WALLET_QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 20 },
      },
    });

walletMaintenanceQueue.on("error", (err) => {
  queueLogger.error(
    { event: "wallet_queue.error", err: err?.message || String(err) },
    `[WalletQueue] Redis queue error: ${err?.message || String(err)}`
  );
});

/**
 * Register all recurring wallet maintenance jobs.
 * Uses upsertJobScheduler() — the BullMQ v5 idiomatic API for repeatable jobs.
 * Safe to call multiple times on startup (idempotent — updates, does not duplicate).
 */
export async function scheduleWalletJobs() {
  await walletMaintenanceQueue.upsertJobScheduler(
    "expire-stale-holds",
    { every: 5 * 60 * 1000 },
    { data: {}, opts: {} }
  );

  await walletMaintenanceQueue.upsertJobScheduler(
    "retry-failed-ops",
    { every: 5 * 60 * 1000 },
    { data: {}, opts: {} }
  );

  await walletMaintenanceQueue.upsertJobScheduler(
    "reconcile-wallets",
    { pattern: "0 3 * * *" },
    { data: {}, opts: {} }
  );

  queueLogger.info(
    { event: "wallet.queue.scheduled" },
    "[WalletQueue] Scheduled: expire-stale-holds (every 5 min), retry-failed-ops (every 5 min), reconcile-wallets (daily 03:00 UTC)"
  );
}
