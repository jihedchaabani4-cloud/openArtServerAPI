/**
 * @owns Lightweight repository for the usage_events audit table.
 *
 * UsageEventRepository (System 3: Billing & Wallet)
 *
 * Tracks free / zero-credit model usage intentionally SEPARATE from
 * the financial transactions ledger. It never touches wallet balances.
 */
import { createLogger } from "#shared";
import { getBillingSupabaseAdminClient } from "./billingClient.js";

const logger = createLogger("usage-event-repo");

export class UsageEventRepository {
    /**
     * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
     */
    constructor(supabaseClient) {
        if (!supabaseClient) {
            throw new Error("[UsageEventRepository] supabaseClient is required.");
        }
        this.supabase = supabaseClient;
    }

    /**
     * Record a new ACTIVE usage event (idempotent via UNIQUE reference_id).
     * @param {Object} params
     * @param {string} params.referenceId
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
            logger.warn({ event: "usage.record_active_failed", referenceId, error: error.message }, "[UsageEventRepository] recordActive failed");
            return { reference_id: referenceId, status: "ACTIVE", kind, _persisted: false };
        }

        return data ?? { reference_id: referenceId, status: "ACTIVE", kind, _persisted: false };
    }

    /**
     * Transition a usage event to COMPLETED.
     * @param {string} referenceId
     * @returns {Promise<Object|null>}
     */
    async markCompleted(referenceId) {
        return this._updateStatus(referenceId, "COMPLETED");
    }

    /**
     * Transition a usage event to RELEASED.
     * @param {string} referenceId
     * @returns {Promise<Object|null>}
     */
    async markReleased(referenceId) {
        return this._updateStatus(referenceId, "RELEASED");
    }

    /**
     * Find a usage event by reference_id.
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
            logger.warn({ event: "usage.find_by_reference_failed", referenceId, error: error.message }, "[UsageEventRepository] findByReference failed");
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
            logger.warn({ event: "usage.update_status_failed", referenceId, newStatus, error: error.message }, "[UsageEventRepository] _updateStatus failed");
            return null;
        }
        return data;
    }
}

export default UsageEventRepository;
