/** @owns Manages retry scheduling and persistence for failed wallet operations. */
import { createClient } from "@supabase/supabase-js";
import { createLogger } from "../../infrastructure/logging/index.js";
import { FailedOpsRepository } from "./repositories/FailedOpsRepository.js";

const billingLogger = createLogger("billing");

export const FAILED_OPS_BACKOFF_BASE_MS = 60_000;
export const FAILED_OPS_BACKOFF_MULTIPLIER = 2;
export const FAILED_OPS_DEFAULT_MAX_RETRIES = 5;

/**
 * FailedOpsService
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages the failed_wallet_operations table — the persistence layer for
 * wallet operations that failed and need automatic retry.
 *
 * Retry backoff: next_retry_at = NOW() + 1 minute × 2^retry_count
 *   Retry 0: immediate
 *   Retry 1: +1 min
 *   Retry 2: +2 min
 *   Retry 3: +4 min
 *   Retry 4: +8 min
 *   Retry 5: → ABANDONED
 *
 * Called by:
 *   - BaseGenerateImageTreatment — to record failed rollbacks / commits
 *   - walletWorker 'retry-failed-ops' job — to fetch and process pending ops
 * ─────────────────────────────────────────────────────────────────────────────
 */
export class FailedOpsService {
  constructor(supabaseUrlOrDeps, supabaseServiceKey = null) {
    if (supabaseUrlOrDeps && typeof supabaseUrlOrDeps === "object" && (supabaseUrlOrDeps.failedOpsRepo || supabaseUrlOrDeps.repo)) {
      this.repo = supabaseUrlOrDeps.failedOpsRepo || supabaseUrlOrDeps.repo;
    } else if (typeof supabaseUrlOrDeps === "string") {
      const client = createClient(supabaseUrlOrDeps, supabaseServiceKey);
      this.repo = new FailedOpsRepository(client);
    } else {
      this.repo = null;
    }
  }

  /**
   * Record a failed wallet operation for later retry.
   * Skips silently if a record with the same reference_id and operation_type
   * already exists (avoids duplicate entries on BullMQ job replays).
   */
  async record({ operationType, referenceId, walletId, userId, amount, payload = {}, failureReason }) {
    if (!this.repo) return;

    try {
      // Check for existing record (idempotent)
      const existing = await this.repo.findExisting(referenceId, operationType);
      if (existing) {
        billingLogger.debug({
          operation: "record-failed-op",
          status: "skipped_duplicate",
          operationType,
          referenceId,
        }, `Skipped recording duplicate failed op (${operationType}:${referenceId})`);
        return;
      }

      const { error } = await this.repo.insertFailedOp({
        operation_type: operationType,
        reference_id: referenceId,
        wallet_id: walletId || null,
        user_id: userId,
        amount: amount || null,
        payload,
        failure_reason: failureReason || null,
        status: "PENDING",
      });

      if (error) {
        // Log but do not throw — recording a failed op must never crash the caller
        billingLogger.error({
          operation: "record-failed-op",
          status: "error",
          operationType,
          referenceId,
          err: error,
        }, `Failed to record failed op (${operationType}:${referenceId}): ${error.message}`);
        return;
      }

      billingLogger.info({
        operation: "record-failed-op",
        status: "recorded",
        operationType,
        referenceId,
        userId,
      }, `Recorded failed op (${operationType}:${referenceId}) for user ${userId}`);
    } catch (err) {
      // Never throw from record() — a recording failure must not mask the original error
      billingLogger.error({
        operation: "record-failed-op",
        status: "exception",
        operationType,
        referenceId,
        err,
      }, `Exception recording failed op (${operationType}:${referenceId}): ${err?.message}`);
    }
  }

  /**
   * Fetch all pending operations ready for retry.
   * Limits to 50 per run to bound job execution time.
   */
  async getPendingOps() {
    if (!this.repo) return [];
    return this.repo.getPendingOps();
  }

  /** Mark an operation as successfully completed. */
  async markCompleted(id) {
    if (!this.repo) return;
    return this.repo.markCompleted(id);
  }

  /**
   * Schedule the next retry attempt using exponential backoff.
   * next_retry_at = now + (1 minute × 2^retryCount)
   */
  async markRetryScheduled(id, retryCount) {
    if (!this.repo) return;
    const delayMs = FAILED_OPS_BACKOFF_BASE_MS * Math.pow(FAILED_OPS_BACKOFF_MULTIPLIER, retryCount);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    return this.repo.markRetryScheduled(id, retryCount, nextRetryAt);
  }

  /**
   * Mark an operation as permanently abandoned after exhausting max retries.
   * Emits a structured ERROR log for admin alerting.
   */
  async markAbandoned(id, reason) {
    if (!this.repo) return;
    await this.repo.markAbandoned(id, reason);
    billingLogger.error({
      event: "wallet.op_abandoned",
      operation: "wallet-op-abandoned",
      failedOpId: id,
      reason,
      alert: "MANUAL_INTERVENTION_REQUIRED",
    }, `Wallet operation ${id} abandoned: ${reason}`);
  }
}
