import "dotenv/config";
import { EventEmitter } from "node:events";
import { Worker } from "bullmq";
import {
  createLogger,
  LogEvents,
  envConfig,
} from "#shared";
import { workerRedisConnection, redisConnection } from "#shared/redis";
import { WALLET_QUEUE_NAME, scheduleWalletJobs } from "./walletQueue.js";
import {
  getWalletService,
  getFailedOpsService,
  getWalletRepository,
  getTransactionRepository,
} from "../services/serviceAccessor.js";
import { runReservationReaper } from "../services/ReservationReaperService.js";
import {
  BillingError,
  BillingValidationError,
  BillingConfigurationError,
} from "../errors.js";

const logger = createLogger("wallet-worker");
export const RECONCILIATION_CACHE_KEY = "reconciliation:latest";

/**
 * Wallet Maintenance Worker (System 3: Billing & Wallet)
 * ─────────────────────────────────────────────────────────────────────────────
 * Dedicated BullMQ worker for wallet housekeeping jobs.
 * Pure module on import — ZERO top-level worker creation, scheduling, or signal hooks.
 * Must be started explicitly via `startWalletWorker()` from root `worker.js`.
 */

function resolveDefaultWalletService() {
  if (!envConfig.rawSupabaseUrl || !envConfig.supabaseServiceRoleKey) {
    return null;
  }
  return getWalletService();
}

function resolveDefaultFailedOpsService() {
  if (!envConfig.rawSupabaseUrl || !envConfig.supabaseServiceRoleKey) {
    return null;
  }
  return getFailedOpsService();
}

export async function handleExpireStaleHolds({
  walletService: injectedWallet = null,
  lifecycleService: injectedLifecycle = undefined,
} = {}) {
  const start = Date.now();
  const activeWallet = injectedWallet || resolveDefaultWalletService();
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
  const activeOps = injectedOps || resolveDefaultFailedOpsService();
  const activeReplay =
    replayFn ||
    ((operation) => replayOperation(operation, { walletService: injectedWallet || resolveDefaultWalletService() }));
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
  const activeWallet = injectedWallet || resolveDefaultWalletService();
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
      throw new BillingValidationError(`Unknown operation_type: ${operation_type}`);
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
      throw new BillingError("BILLING_RECONCILE_ERROR", `[reconcile-wallets] Failed to fetch wallets: ${walletsError.message}`);
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

async function processWalletJob(job) {
  switch (job.name) {
    case "expire-stale-holds":
      return handleExpireStaleHolds();

    case "retry-failed-ops":
      return handleRetryFailedOps();

    case "reconcile-wallets":
      return handleReconcileWallets();

    default:
      throw new BillingValidationError(`[WalletWorker] Unknown job name: ${job.name}`);
  }
}

let activeWorker = null;
let sigintHandler = null;
let sigtermHandler = null;

/**
 * Live reference to the active wallet worker instance (null until `startWalletWorker()` is called).
 */
export let walletWorker = null;

/**
 * Explicitly starts the dedicated BullMQ wallet maintenance worker (idempotent).
 * Must ONLY be called from root `worker.js` — never at module import time or from `index.js`.
 *
 * @param {Object} [options]
 * @param {Function} [options.WorkerClass] - Optional BullMQ Worker constructor override for testing.
 * @param {Function} [options.scheduleJobs] - Optional scheduler override for testing.
 * @param {Object} [options.connection] - Optional Redis connection override.
 * @param {boolean} [options.registerShutdownHooks] - Whether to attach SIGINT/SIGTERM hooks.
 * @returns {Promise<Object>} Active worker instance
 */
export async function startWalletWorker({
  WorkerClass = null,
  scheduleJobs = scheduleWalletJobs,
  connection = workerRedisConnection,
  registerShutdownHooks = !envConfig.isTest,
} = {}) {
  if (activeWorker) {
    return activeWorker;
  }

  if (!envConfig.isTest && !WorkerClass) {
    const supabaseUrl = envConfig.rawSupabaseUrl;
    const supabaseServiceKey = envConfig.supabaseServiceRoleKey;
    if (!supabaseUrl || !supabaseServiceKey) {
      logger.error(
        { event: "worker.boot_failed" },
        "[WalletWorker] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — cannot start wallet worker."
      );
      throw new BillingConfigurationError("[WalletWorker] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
  }

  const workerInstance =
    WorkerClass
      ? new WorkerClass(WALLET_QUEUE_NAME, processWalletJob, {
          connection,
          concurrency: 1,
          stalledInterval: 60_000,
          maxStalledCount: 1,
          lockDuration: 2 * 60 * 1000,
          lockRenewTime: 30_000,
        })
      : envConfig.isTest
        ? Object.assign(new EventEmitter(), {
            name: WALLET_QUEUE_NAME,
            close: async () => {},
          })
        : new Worker(WALLET_QUEUE_NAME, processWalletJob, {
            connection,
            concurrency: 1,
            stalledInterval: 60_000,
            maxStalledCount: 1,
            lockDuration: 2 * 60 * 1000,
            lockRenewTime: 30_000,
          });

  workerInstance.on("completed", (job, result) => {
    logger.info(
      {
        event: "wallet.job_completed",
        operation: "job-completed",
        jobName: job?.name,
        jobId: job?.id,
        result: typeof result === "number" ? result : undefined,
      },
      `Job ${job?.name} completed`
    );
  });

  workerInstance.on("failed", (job, err) => {
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

  workerInstance.on("error", (err) => {
    logger.error(
      {
        event: "wallet.worker_error",
        error: err?.message,
      },
      `[WalletWorker] Worker error: ${err?.message}`
    );
  });

  activeWorker = workerInstance;
  walletWorker = workerInstance;

  try {
    await scheduleJobs();
  } catch (err) {
    activeWorker = null;
    walletWorker = null;
    await workerInstance.close?.().catch(() => {});
    throw err;
  }

  logger.info({ event: "worker.start" }, "[WalletWorker] Wallet maintenance worker started.");

  if (registerShutdownHooks) {
    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ event: "worker.shutdown", signal }, `[WalletWorker] ${signal} — shutting down gracefully...`);
      try {
        await stopWalletWorker();
        logger.info({ event: "worker.stopped" }, "[WalletWorker] Stopped cleanly.");
      } catch (err) {
        logger.error({ event: "worker.close_error", error: err?.message }, `[WalletWorker] close() error: ${err?.message}`);
      } finally {
        process.exit(0);
      }
    };

    sigintHandler = () => shutdown("SIGINT");
    sigtermHandler = () => shutdown("SIGTERM");
    process.once("SIGINT", sigintHandler);
    process.once("SIGTERM", sigtermHandler);
  }

  return activeWorker;
}

/**
 * Stops the active wallet worker and detaches any registered signal handlers.
 */
export async function stopWalletWorker() {
  const workerToClose = activeWorker;
  activeWorker = null;
  walletWorker = null;

  if (sigintHandler) {
    process.removeListener("SIGINT", sigintHandler);
    sigintHandler = null;
  }
  if (sigtermHandler) {
    process.removeListener("SIGTERM", sigtermHandler);
    sigtermHandler = null;
  }

  if (workerToClose && typeof workerToClose.close === "function") {
    await workerToClose.close();
  }
}
