import { createClient } from "@supabase/supabase-js";

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
  constructor(supabaseUrl, supabaseServiceKey) {
    this.supabase = createClient(supabaseUrl, supabaseServiceKey);
  }

  /**
   * Record a failed wallet operation for later retry.
   * Skips silently if a record with the same reference_id and operation_type
   * already exists (avoids duplicate entries on BullMQ job replays).
   */
  async record({ operationType, referenceId, walletId, userId, amount, payload = {}, failureReason }) {
    const timestamp = new Date().toISOString();

    try {
      // Check for existing record (idempotent)
      const { data: existing } = await this.supabase
        .from("failed_wallet_operations")
        .select("id")
        .eq("reference_id", referenceId)
        .eq("operation_type", operationType)
        .maybeSingle();

      if (existing) {
        console.log(JSON.stringify({
          timestamp,
          operation: "record-failed-op",
          status: "skipped_duplicate",
          operationType,
          referenceId,
        }));
        return;
      }

      const { error } = await this.supabase
        .from("failed_wallet_operations")
        .insert({
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
        console.error(JSON.stringify({
          timestamp,
          operation: "record-failed-op",
          status: "error",
          operationType,
          referenceId,
          error: error.message,
        }));
        return;
      }

      console.log(JSON.stringify({
        timestamp,
        operation: "record-failed-op",
        status: "recorded",
        operationType,
        referenceId,
        userId,
      }));
    } catch (err) {
      // Never throw from record() — a recording failure must not mask the original error
      console.error(JSON.stringify({
        timestamp,
        operation: "record-failed-op",
        status: "exception",
        operationType,
        referenceId,
        error: err?.message,
      }));
    }
  }

  /**
   * Fetch all pending operations ready for retry.
   * Limits to 50 per run to bound job execution time.
   */
  async getPendingOps() {
    const now = new Date().toISOString();

    const { data, error } = await this.supabase
      .from("failed_wallet_operations")
      .select("*")
      .eq("status", "PENDING")
      .or(`next_retry_at.is.null,next_retry_at.lte.${now}`)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) throw new Error(`[FailedOpsService] getPendingOps failed: ${error.message}`);
    return data || [];
  }

  /** Mark an operation as successfully completed. */
  async markCompleted(id) {
    const { error } = await this.supabase
      .from("failed_wallet_operations")
      .update({ status: "COMPLETED" })
      .eq("id", id);

    if (error) throw new Error(`[FailedOpsService] markCompleted(${id}) failed: ${error.message}`);
  }

  /**
   * Schedule the next retry attempt using exponential backoff.
   * next_retry_at = now + (1 minute × 2^retryCount)
   */
  async markRetryScheduled(id, retryCount) {
    const delayMs = 60_000 * Math.pow(2, retryCount);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();

    const { error } = await this.supabase
      .from("failed_wallet_operations")
      .update({
        retry_count: retryCount,
        next_retry_at: nextRetryAt,
      })
      .eq("id", id);

    if (error) throw new Error(`[FailedOpsService] markRetryScheduled(${id}) failed: ${error.message}`);
  }

  /**
   * Mark an operation as permanently abandoned after exhausting max retries.
   * Emits a structured ERROR log for admin alerting.
   */
  async markAbandoned(id, reason) {
    const { error } = await this.supabase
      .from("failed_wallet_operations")
      .update({ status: "ABANDONED", failure_reason: reason })
      .eq("id", id);

    if (error) throw new Error(`[FailedOpsService] markAbandoned(${id}) failed: ${error.message}`);

    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      operation: "wallet-op-abandoned",
      failedOpId: id,
      reason,
      alert: "MANUAL_INTERVENTION_REQUIRED",
    }));
  }
}
