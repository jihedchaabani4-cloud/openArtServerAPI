import { createClient } from "@supabase/supabase-js";

/**
 * UsageEventRepository
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight repository for the `usage_events` audit table.
 *
 * This table tracks free / zero-credit model usage and is intentionally
 * SEPARATE from the financial `transactions` ledger. It never touches
 * wallet balances — it is purely an audit / observability trail.
 *
 * Status state machine per usage event:
 *   ACTIVE → COMPLETED  (node / workflow finished successfully)
 *   ACTIVE → RELEASED   (node / workflow cancelled or failed)
 * ─────────────────────────────────────────────────────────────────────────────
 */
export class UsageEventRepository {
  constructor(supabaseClient) {
    if (!supabaseClient) {
      throw new Error("[UsageEventRepository] supabaseClient is required.");
    }
    this.supabase = supabaseClient;
  }

  /**
   * Record a new ACTIVE usage event (idempotent via UNIQUE reference_id).
   * Called when a free/zero-cost node starts execution.
   *
   * @param {Object} params
   * @param {string} params.referenceId - Unique billing reference (e.g. "v2:runId:nodeId:1")
   * @param {string} params.userId
   * @param {string} [params.kind="free_model_usage"]
   * @param {Object} [params.metadata={}]
   * @returns {Promise<Object>} The inserted usage_event row
   */
  async recordActive({ referenceId, userId, kind = "free_model_usage", metadata = {} }) {
    const { data, error } = await this.supabase
      .from("usage_events")
      .upsert(
        { reference_id: referenceId, user_id: userId, kind, status: "ACTIVE", metadata },
        { onConflict: "reference_id", ignoreDuplicates: true }
      )
      .select("*")
      .maybeSingle();

    if (error) {
      console.warn(`[UsageEventRepository] recordActive failed for ${referenceId}:`, error.message);
      // Non-fatal: audit trail failure should not block execution
      return { reference_id: referenceId, status: "ACTIVE", kind, _persisted: false };
    }

    return data ?? { reference_id: referenceId, status: "ACTIVE", kind, _persisted: false };
  }

  /**
   * Transition a usage event to COMPLETED.
   * Called on successful node/workflow completion.
   *
   * @param {string} referenceId
   * @returns {Promise<Object|null>}
   */
  async markCompleted(referenceId) {
    return this._updateStatus(referenceId, "COMPLETED");
  }

  /**
   * Transition a usage event to RELEASED.
   * Called when a node/workflow fails or is cancelled.
   *
   * @param {string} referenceId
   * @returns {Promise<Object|null>}
   */
  async markReleased(referenceId) {
    return this._updateStatus(referenceId, "RELEASED");
  }

  /**
   * Find a usage event by reference_id.
   *
   * @param {string} referenceId
   * @returns {Promise<Object|null>}
   */
  async findByReference(referenceId) {
    const { data, error } = await this.supabase
      .from("usage_events")
      .select("*")
      .eq("reference_id", referenceId)
      .maybeSingle();

    if (error) {
      console.warn(`[UsageEventRepository] findByReference failed for ${referenceId}:`, error.message);
      return null;
    }
    return data;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  async _updateStatus(referenceId, newStatus) {
    const { data, error } = await this.supabase
      .from("usage_events")
      .update({ status: newStatus })
      .eq("reference_id", referenceId)
      .eq("status", "ACTIVE") // Only transition from ACTIVE (idempotency guard)
      .select("*")
      .maybeSingle();

    if (error) {
      console.warn(`[UsageEventRepository] _updateStatus(${newStatus}) failed for ${referenceId}:`, error.message);
      return null;
    }
    return data;
  }
}
