import "dotenv/config";
import { Worker } from "bullmq";
import {
  workerRedisConnection,
  redisConnection,
  RECONCILIATION_CACHE_KEY,
  createLogger,
  LogEvents,
  envConfig,
} from "#shared";
import { walletMaintenanceQueue, WALLET_QUEUE_NAME, scheduleWalletJobs } from "./walletQueue.js";
import {
  getWalletService,
  getFailedOpsService,
  getWalletRepository,
  getTransactionRepository,
} from "../services/serviceAccessor.js";
import { runReservationReaper } from "../services/ReservationReaperService.js";

const logger = createLogger("wallet-worker");

/**
 * Wallet Maintenance Worker (System 3: Billing & Wallet)
 * ─────────────────────────────────────────────────────────────────────────────
 * Dedicated BullMQ worker for wallet housekeeping jobs.
 * Note: container.js boot assertions are verified before worker startup.
 */

const supabaseUrl = envConfig.rawSupabaseUrl;
const supabaseServiceKey = envConfig.supabaseServiceRoleKey;

if (!supabaseUrl || !supabaseServiceKey) {
  if (!envConfig.isTest) {
    logger.error({ event: "worker.boot_failed" }, "[WalletWorker] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — exiting.");
    process.exit(1);
  }
}

const walletService = supabaseUrl && supabaseServiceKey ? getWalletService() : null;
const failedOpsService = supabaseUrl && supabaseServiceKey ? getFailedOpsService() : null;

export async function handleExpireStaleHolds({
  walletService: injectedWallet = null,
  lifecycleService: injectedLifecycle = undefined,
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

export async function handleRetryFailedOps({
  failedOpsService: injectedOps = null,
  walletService: injectedWallet = null,
  replayFn = null,
} = {}) {
  const start = Date.now();
  const activeOps = injectedOps || failedOpsService;
  const activeReplay = replayFn || ((operation) => replayOperation(operation, { walletService: injectedWallet || walletService }));
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
      await activeReplay(op);
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

export async function handleReconcileWallets({ supabaseClient = null } = {}) {
  const start = Date.now();

  let wallets = [];
  if (supabaseClient) {
    const { data, error: walletsError } = await supabaseClient
      .from("wallets")
      .select("id, user_id, balance");
    if (walletsError) {
      throw new Error(`[reconcile-wallets] Failed to fetch wallets: ${walletsError.message}`);
    }
    wallets = data || [];
  } else {
    const walletRepo = getWalletRepository();
    wallets = await walletRepo.listAll();
  }

  const mismatches = [];
  const txRepo = !supabaseClient ? getTransactionRepository() : null;

  for (const wallet of wallets) {
    let txData;
    let txError;

    if (supabaseClient) {
      const res = await supabaseClient
        .from("transactions")
        .select("type, amount, status")
        .eq("wallet_id", wallet.id)
        .eq("status", "COMPLETED");
      txData = res.data;
      txError = res.error;
    } else {
      const res = await txRepo.findCompletedByWalletId(wallet.id);
      txData = res.data;
      txError = res.error;
    }

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
    await redisConnection.set(RECONCILIATION_CACHE_KEY, JSON.stringify(summary));
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

export const walletWorker = envConfig.isTest
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
        concurrency: 1,
        stalledInterval: 60_000,
        maxStalledCount: 1,
        lockDuration: 2 * 60 * 1000,
        lockRenewTime: 30_000,
      }
    );

if (!envConfig.isTest) {
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
