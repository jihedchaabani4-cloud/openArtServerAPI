import "dotenv/config";
import "../container.js";
import { Worker } from "bullmq";
import { createClient } from "@supabase/supabase-js";
import { workerRedisConnection, redisConnection } from "../queue/redis.js";
import { walletMaintenanceQueue, WALLET_QUEUE_NAME, scheduleWalletJobs } from "../queue/walletQueue.js";
import { WalletService } from "#platform/billing/WalletService.js";
import { FailedOpsService } from "#platform/billing/FailedOpsService.js";
import { runReservationReaper } from "./reservationReaperWorker.js";
import { createLogger, LogEvents } from "../infrastructure/logging/index.js";

const logger = createLogger("wallet-worker");

/**
 * Wallet Maintenance Worker
 * ─────────────────────────────────────────────────────────────────────────────
 * Dedicated BullMQ worker for wallet housekeeping jobs.
 * Runs as a SEPARATE process from the generation worker (worker.js).
 *
 * Never merge this worker with the generation worker:
 *   - BullMQ Worker connections must not be shared across queues
 *   - Wallet jobs must not be blocked by long-running generation jobs
 *
 * Start with: npm run start:wallet-worker
 * Dev mode:   npm run dev:wallet-worker
 *
 * Jobs handled:
 *   expire-stale-holds  — releases PENDING transactions past expires_at
 *   retry-failed-ops    — replays failed commits/rollbacks/credits
 *   reconcile-wallets   — compares ledger balances vs transaction sums
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Services ─────────────────────────────────────────────────────────────────

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  if (process.env.NODE_ENV !== "test") {
    logger.error({ event: "worker.boot_failed" }, "[WalletWorker] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — exiting.");
    process.exit(1);
  }
}

const supabase = supabaseUrl && supabaseServiceKey ? createClient(supabaseUrl, supabaseServiceKey) : null;
const walletService = supabaseUrl && supabaseServiceKey ? new WalletService(supabaseUrl, supabaseServiceKey) : null;
const failedOpsService = supabaseUrl && supabaseServiceKey ? new FailedOpsService(supabaseUrl, supabaseServiceKey) : null;

// ── Job Handlers ─────────────────────────────────────────────────────────────

/**
 * expire-stale-holds
 * Calls the atomic expire_stale_holds Supabase RPC via runReservationReaper which:
 *   1. Finds PENDING transactions where expires_at < NOW()
 *   2. Marks them FAILED and restores the corresponding wallet balances
 *   3. Reconciles associated workflow and media state (marks placeholder failed)
 *   4. Sweeps stale processing placeholders (>30m)
 */
export async function handleExpireStaleHolds({
  walletService: injectedWallet = null,
  lifecycleService: injectedLifecycle = null,
} = {}) {
  const start = Date.now();
  const activeWallet = injectedWallet || walletService;
  const releasedCount = await runReservationReaper({
    walletService: activeWallet,
    lifecycleService: injectedLifecycle,
  });

  logger.info(
    {
      event: LogEvents.WALLET_HOLD_EXPIRED || "wallet.expire_stale_holds.completed",
      operation: "expire-stale-holds",
      status: "success",
      releasedCount,
      durationMs: Date.now() - start,
    },
    `Expired stale holds job completed: ${releasedCount} holds reaped and reconciled`
  );

  return releasedCount;
}

/**
 * retry-failed-ops
 * Fetches all PENDING rows from failed_wallet_operations where
 * next_retry_at is NULL or in the past, then replays each operation.
 * Uses exponential backoff on failure and marks ABANDONED after max_retries.
 */
export async function handleRetryFailedOps({ failedOpsService: injectedOps = null } = {}) {
  const start = Date.now();
  const activeOps = injectedOps || failedOpsService;
  const ops = await activeOps.getPendingOps();

  if (ops.length === 0) {
    logger.info(
      {
        event: "wallet.retry_failed_ops.completed",
        operation: "retry-failed-ops",
        status: "success",
        processedCount: 0,
        durationMs: Date.now() - start,
      },
      "No pending failed wallet operations to retry"
    );
    return 0;
  }

  let successCount = 0;
  let failureCount = 0;
  let abandonedCount = 0;

  for (const op of ops) {
    try {
      await replayOperation(op, { walletService });
      await activeOps.markCompleted(op.id);
      successCount++;
      logger.info(
        {
          event: "wallet.op_replayed",
          operation: "retry-failed-ops",
          status: "replayed",
          operationType: op.operation_type,
          referenceId: op.reference_id,
          retryCount: op.retry_count,
        },
        `Successfully replayed ${op.operation_type} for reference ${op.reference_id}`
      );
    } catch (err) {
      const newRetryCount = op.retry_count + 1;

      if (newRetryCount >= op.max_retries) {
        await activeOps.markAbandoned(op.id, err.message);
        abandonedCount++;
        logger.error(
          {
            event: "wallet.op_abandoned",
            operation: "retry-failed-ops",
            status: "abandoned",
            operationType: op.operation_type,
            referenceId: op.reference_id,
            maxRetries: op.max_retries,
            error: err.message,
          },
          `Abandoned ${op.operation_type} for reference ${op.reference_id} after ${newRetryCount} retries`
        );
      } else {
        await activeOps.markRetryScheduled(op.id, newRetryCount);
        failureCount++;
        logger.warn(
          {
            event: "wallet.op_retry_scheduled",
            operation: "retry-failed-ops",
            status: "retry_scheduled",
            operationType: op.operation_type,
            referenceId: op.reference_id,
            newRetryCount,
            error: err.message,
          },
          `Scheduled retry ${newRetryCount} for ${op.operation_type} reference ${op.reference_id}`
        );
      }
    }
  }

  logger.info(
    {
      event: "wallet.retry_failed_ops.completed",
      operation: "retry-failed-ops",
      status: "success",
      processedCount: ops.length,
      successCount,
      failureCount,
      abandonedCount,
      durationMs: Date.now() - start,
    },
    `Retried ${ops.length} failed operations (success: ${successCount}, failed: ${failureCount}, abandoned: ${abandonedCount})`
  );

  return successCount;
}

/**
 * Replay a single failed wallet operation.
 * Throws on failure (caller handles backoff/abandon logic).
 */
export async function replayOperation(op, { walletService: injectedWallet = null } = {}) {
  const activeWallet = injectedWallet || walletService;
  const { operation_type, reference_id, user_id, amount, payload } = op;

  switch (operation_type) {
    case "COMMIT":
      await activeWallet.commitHoldIdempotent(reference_id);
      break;

    case "ROLLBACK":
      await activeWallet.rollback(reference_id);
      break;

    case "CREDIT": {
      const { referenceId, metadata } = payload || {};
      await activeWallet.credit({
        userId: user_id,
        amount: Number(amount),
        referenceId: referenceId || reference_id,
        metadata: metadata || { source: "failed_op_retry" },
      });
      break;
    }

    case "DEBIT": {
      const { referenceId, metadata } = payload || {};
      await activeWallet.hold({
        userId: user_id,
        amount: Number(amount),
        referenceId: referenceId || reference_id,
        metadata: metadata || { source: "failed_op_retry" },
      });
      break;
    }

    default:
      throw new Error(`Unknown operation_type: ${operation_type}`);
  }
}

/**
 * reconcile-wallets
 * Compares each wallet's current balance against the sum of its completed
 * transactions. Logs a structured ERROR for every mismatch found.
 * Alert-only — no automatic correction (requires human review).
 */
export async function handleReconcileWallets({ supabaseClient = null } = {}) {
  const start = Date.now();
  const client = supabaseClient || supabase;

  if (!client) {
    throw new Error("[reconcile-wallets] Database client is not wired");
  }

  const { data: wallets, error: walletsError } = await client
    .from("wallets")
    .select("id, user_id, balance");

  if (walletsError) {
    throw new Error(`[reconcile-wallets] Failed to fetch wallets: ${walletsError.message}`);
  }

  const mismatches = [];

  for (const wallet of wallets || []) {
    const { data: txData, error: txError } = await client
      .from("transactions")
      .select("type, amount, status")
      .eq("wallet_id", wallet.id)
      .eq("status", "COMPLETED");

    if (txError) {
      logger.warn(
        {
          event: "wallet.reconcile_skip",
          operation: "reconcile-wallets",
          walletId: wallet.id,
          error: txError.message,
        },
        `Skipped wallet ${wallet.id} during reconciliation`
      );
      continue;
    }

    const computedBalance = (txData || []).reduce((sum, tx) => {
      const amount = Number(tx.amount);
      return tx.type === "CREDIT" ? sum + amount : sum - amount;
    }, 0);

    const ledgerBalance = Number(wallet.balance);
    const delta = Math.round((ledgerBalance - computedBalance) * 100) / 100;

    if (Math.abs(delta) > 0.01) {
      mismatches.push({
        walletId: wallet.id,
        userId: wallet.user_id,
        ledgerBalance,
        computedBalance: Math.round(computedBalance * 100) / 100,
        delta,
      });

      logger.error(
        {
          event: "wallet.mismatch_detected",
          operation: "reconcile-wallets",
          status: "mismatch_detected",
          walletId: wallet.id,
          userId: wallet.user_id,
          ledgerBalance,
          computedBalance: Math.round(computedBalance * 100) / 100,
          delta,
          alert: "FINANCIAL_MISMATCH_REQUIRES_INVESTIGATION",
        },
        `Financial mismatch detected on wallet ${wallet.id}`
      );
    }
  }

  const summary = {
    runAt: new Date().toISOString(),
    status: mismatches.length > 0 ? "MISMATCHES_FOUND" : "CLEAN",
    mismatchCount: mismatches.length,
    mismatches,
    durationMs: Date.now() - start,
  };

  try {
    await redisConnection.set("reconcile:latest", JSON.stringify(summary));
  } catch (redisErr) {
    logger.warn(
      {
        event: "wallet.reconcile_redis_error",
        error: redisErr?.message,
      },
      "[reconcile-wallets] Could not persist result to Redis"
    );
  }

  logger.info(
    {
      event: "wallet.reconcile_completed",
      operation: "reconcile-wallets",
      status: summary.status,
      mismatchCount: mismatches.length,
      durationMs: summary.durationMs,
    },
    `Reconciliation completed with status ${summary.status}`
  );

  return summary;
}

// ── Worker ───────────────────────────────────────────────────────────────────

export const walletWorker = process.env.NODE_ENV === "test"
  ? { on: () => {}, close: async () => {} }
  : new Worker(
      WALLET_QUEUE_NAME,
      async (job) => {
        switch (job.name) {
          case "expire-stale-holds":
            return handleExpireStaleHolds();

          case "retry-failed-ops":
            return handleRetryFailedOps();

          case "reconcile-wallets":
            return handleReconcileWallets();

          default:
            throw new Error(`[WalletWorker] Unknown job name: ${job.name}`);
        }
      },
      {
        connection: workerRedisConnection,
        concurrency: 1, // Wallet ops are sensitive — run one at a time
        stalledInterval: 60_000,
        maxStalledCount: 1,
        lockDuration: 2 * 60 * 1000, // 2-minute lock (jobs are fast)
        lockRenewTime: 30_000,
      }
    );

if (process.env.NODE_ENV !== "test") {
  walletWorker.on("completed", (job, result) => {
    logger.info(
      {
        event: "wallet.job_completed",
        operation: "job-completed",
        jobName: job.name,
        jobId: job.id,
        result: typeof result === "number" ? result : undefined,
      },
      `Job ${job.name} completed`
    );
  });

  walletWorker.on("failed", (job, err) => {
    logger.error(
      {
        event: "wallet.job_failed",
        operation: "job-failed",
        jobName: job?.name,
        jobId: job?.id,
        error: err?.message,
      },
      `Job ${job?.name} failed: ${err?.message}`
    );
  });

  walletWorker.on("error", (err) => {
    logger.error(
      {
        event: "wallet.worker_error",
        error: err?.message,
      },
      `[WalletWorker] Worker error: ${err?.message}`
    );
  });

  (async () => {
    await scheduleWalletJobs();
    logger.info({ event: "worker.start" }, "[WalletWorker] Wallet maintenance worker started.");
  })();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: "worker.shutdown", signal }, `[WalletWorker] ${signal} — shutting down gracefully...`);
    try {
      await walletWorker.close();
      logger.info({ event: "worker.stopped" }, "[WalletWorker] Stopped cleanly.");
    } catch (err) {
      logger.error({ event: "worker.close_error", error: err?.message }, `[WalletWorker] close() error: ${err?.message}`);
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
