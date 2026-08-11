import "dotenv/config";
import { Worker } from "bullmq";
import { createClient } from "@supabase/supabase-js";
import { workerRedisConnection, redisConnection } from "../queue/redis.js";
import { walletMaintenanceQueue, WALLET_QUEUE_NAME, scheduleWalletJobs } from "../queue/walletQueue.js";
import { WalletService } from "#platform/billing/WalletService.js";
import { FailedOpsService } from "#platform/billing/FailedOpsService.js";

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
  console.error("[WalletWorker] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — exiting.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const walletService = new WalletService(supabaseUrl, supabaseServiceKey);
const failedOpsService = new FailedOpsService(supabaseUrl, supabaseServiceKey);

// ── Job Handlers ─────────────────────────────────────────────────────────────

/**
 * expire-stale-holds
 * Calls the expire_stale_holds Supabase RPC which atomically:
 *   1. Finds PENDING transactions where expires_at < NOW()
 *   2. Marks them FAILED
 *   3. Restores the corresponding wallet balances
 */
async function handleExpireStaleHolds() {
  const start = Date.now();
  const releasedCount = await walletService.expireStaleHolds();
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    operation: "expire-stale-holds",
    status: "success",
    releasedCount,
    durationMs: Date.now() - start,
  }));
  return releasedCount;
}

/**
 * retry-failed-ops
 * Fetches all PENDING rows from failed_wallet_operations where
 * next_retry_at is NULL or in the past, then replays each operation.
 * Uses exponential backoff on failure and marks ABANDONED after max_retries.
 */
async function handleRetryFailedOps() {
  const start = Date.now();
  const ops = await failedOpsService.getPendingOps();

  if (ops.length === 0) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      operation: "retry-failed-ops",
      status: "success",
      processedCount: 0,
      durationMs: Date.now() - start,
    }));
    return 0;
  }

  let successCount = 0;
  let failureCount = 0;
  let abandonedCount = 0;

  for (const op of ops) {
    try {
      await replayOperation(op);
      await failedOpsService.markCompleted(op.id);
      successCount++;
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        operation: "retry-failed-ops",
        status: "replayed",
        operationType: op.operation_type,
        referenceId: op.reference_id,
        retryCount: op.retry_count,
      }));
    } catch (err) {
      const newRetryCount = op.retry_count + 1;

      if (newRetryCount >= op.max_retries) {
        await failedOpsService.markAbandoned(op.id, err.message);
        abandonedCount++;
      } else {
        await failedOpsService.markRetryScheduled(op.id, newRetryCount);
        failureCount++;
        console.warn(JSON.stringify({
          timestamp: new Date().toISOString(),
          operation: "retry-failed-ops",
          status: "retry_scheduled",
          operationType: op.operation_type,
          referenceId: op.reference_id,
          newRetryCount,
          error: err.message,
        }));
      }
    }
  }

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    operation: "retry-failed-ops",
    status: "success",
    processedCount: ops.length,
    successCount,
    failureCount,
    abandonedCount,
    durationMs: Date.now() - start,
  }));

  return successCount;
}

/**
 * Replay a single failed wallet operation.
 * Throws on failure (caller handles backoff/abandon logic).
 */
async function replayOperation(op) {
  const { operation_type, reference_id, user_id, amount, payload } = op;

  switch (operation_type) {
    case "COMMIT":
      await walletService.commitHoldIdempotent(reference_id);
      break;

    case "ROLLBACK":
      await walletService.rollback(reference_id);
      break;

    case "CREDIT": {
      const { referenceId, metadata } = payload;
      await walletService.credit({
        userId: user_id,
        amount: Number(amount),
        referenceId: referenceId || reference_id,
        metadata: metadata || { source: "failed_op_retry" },
      });
      break;
    }

    case "DEBIT": {
      const { referenceId, metadata } = payload;
      await walletService.hold({
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
async function handleReconcileWallets() {
  const start = Date.now();

  // Raw SQL via Supabase RPC or direct query
  // Using a direct Supabase query with computed fields
  const { data: wallets, error: walletsError } = await supabase
    .from("wallets")
    .select("id, user_id, balance");

  if (walletsError) {
    throw new Error(`[reconcile-wallets] Failed to fetch wallets: ${walletsError.message}`);
  }

  const mismatches = [];

  for (const wallet of wallets || []) {
    const { data: txData, error: txError } = await supabase
      .from("transactions")
      .select("type, amount, status")
      .eq("wallet_id", wallet.id)
      .eq("status", "COMPLETED");

    if (txError) {
      console.warn(JSON.stringify({
        timestamp: new Date().toISOString(),
        operation: "reconcile-wallets",
        status: "wallet_skip",
        walletId: wallet.id,
        error: txError.message,
      }));
      continue;
    }

    const computedBalance = (txData || []).reduce((sum, tx) => {
      const amount = Number(tx.amount);
      return tx.type === "CREDIT" ? sum + amount : sum - amount;
    }, 0);

    const ledgerBalance = Number(wallet.balance);
    const delta = Math.round((ledgerBalance - computedBalance) * 100) / 100;

    if (Math.abs(delta) > 0.01) {
      // Store latest result in Redis for the admin endpoint
      mismatches.push({
        walletId: wallet.id,
        userId: wallet.user_id,
        ledgerBalance,
        computedBalance: Math.round(computedBalance * 100) / 100,
        delta,
      });

      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        operation: "reconcile-wallets",
        status: "mismatch_detected",
        walletId: wallet.id,
        userId: wallet.user_id,
        ledgerBalance,
        computedBalance: Math.round(computedBalance * 100) / 100,
        delta,
        alert: "FINANCIAL_MISMATCH_REQUIRES_INVESTIGATION",
      }));
    }
  }

  const summary = {
    runAt: new Date().toISOString(),
    status: mismatches.length > 0 ? "MISMATCHES_FOUND" : "CLEAN",
    mismatchCount: mismatches.length,
    mismatches,
    durationMs: Date.now() - start,
  };

  // Persist latest reconciliation result in Redis for the admin endpoint
  try {
    await redisConnection.set("reconcile:latest", JSON.stringify(summary));
  } catch (redisErr) {
    console.warn("[reconcile-wallets] Could not persist result to Redis:", redisErr?.message);
  }

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    operation: "reconcile-wallets",
    status: summary.status,
    mismatchCount: mismatches.length,
    durationMs: summary.durationMs,
  }));

  return summary;
}

// ── Worker ───────────────────────────────────────────────────────────────────

const walletWorker = new Worker(
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
    lockDuration: 2 * 60 * 1000,   // 2-minute lock (jobs are fast)
    lockRenewTime: 30_000,
  }
);

walletWorker.on("completed", (job, result) => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    operation: "job-completed",
    jobName: job.name,
    jobId: job.id,
    result: typeof result === "number" ? result : undefined,
  }));
});

walletWorker.on("failed", (job, err) => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    operation: "job-failed",
    jobName: job?.name,
    jobId: job?.id,
    error: err?.message,
  }));
});

walletWorker.on("error", (err) => {
  console.error("[WalletWorker] Worker error:", err?.message);
});

// ── Startup ──────────────────────────────────────────────────────────────────

(async () => {
  await scheduleWalletJobs();
  console.log("[WalletWorker] Wallet maintenance worker started.");
})();

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[WalletWorker] ${signal} — shutting down gracefully...`);
  try {
    await walletWorker.close();
    console.log("[WalletWorker] Stopped cleanly.");
  } catch (err) {
    console.error("[WalletWorker] close() error:", err?.message);
  } finally {
    process.exit(0);
  }
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
