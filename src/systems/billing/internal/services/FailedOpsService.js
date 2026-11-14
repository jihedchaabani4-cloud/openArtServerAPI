/**
 * @owns System 3: Billing & Wallet
 *
 * FailedOpsService
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages the failed_wallet_operations table — the persistence layer for
 * wallet operations that failed and need automatic retry with exponential backoff.
 */
import { createLogger } from "#shared";
import { FailedOpsRepository } from "../db/FailedOpsRepository.js";
import { getBillingSupabaseAdminClient } from "../db/billingClient.js";

const billingLogger = createLogger("billing");

export const FAILED_OPS_BACKOFF_BASE_MS = 60_000;
export const FAILED_OPS_BACKOFF_MULTIPLIER = 2;
export const FAILED_OPS_DEFAULT_MAX_RETRIES = 5;

export class FailedOpsService {
  constructor(supabaseUrlOrDeps = null, supabaseServiceKey = null) {
    if (supabaseUrlOrDeps && typeof supabaseUrlOrDeps === "object" && (supabaseUrlOrDeps.failedOpsRepo || supabaseUrlOrDeps.repo)) {
      this.repo = supabaseUrlOrDeps.failedOpsRepo || supabaseUrlOrDeps.repo;
    } else if (typeof supabaseUrlOrDeps === "string") {
      const client = getBillingSupabaseAdminClient();
      this.repo = new FailedOpsRepository(client);
    } else {
      const client = getBillingSupabaseAdminClient();
      this.repo = client ? new FailedOpsRepository(client) : null;
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
   */
  async markRetryScheduled(id, retryCount) {
    if (!this.repo) return;
    const delayMs = FAILED_OPS_BACKOFF_BASE_MS * Math.pow(FAILED_OPS_BACKOFF_MULTIPLIER, retryCount);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    return this.repo.markRetryScheduled(id, retryCount, nextRetryAt);
  }

  /**
   * Mark an operation as permanently abandoned after exhausting max retries.
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

export default FailedOpsService;
