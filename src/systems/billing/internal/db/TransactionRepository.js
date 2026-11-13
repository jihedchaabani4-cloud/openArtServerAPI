/**
 * @owns Persistence and atomic RPC operations for public.transactions table.
 *
 * TransactionRepository (System 3: Billing & Wallet)
 */
import { WalletError } from "../errors.js";
import { getBillingSupabaseAdminClient } from "./billingClient.js";

export class TransactionRepository {
    /**
     * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
     */
    constructor(supabaseClient) {
        if (!supabaseClient) {
            throw new Error("[TransactionRepository] supabaseClient is required");
        }
        this.supabase = supabaseClient;
    }

    /**
     * Executes the atomic hold_credits RPC.
     */
    async holdCreditsRpc({ walletId, amount, referenceId, metadata = {}, expiresAt }) {
        const { data: tx, error } = await this.supabase.rpc("hold_credits", {
            p_wallet_id: walletId,
            p_amount: amount,
            p_reference_id: referenceId,
            p_metadata: metadata,
            p_expires_at: expiresAt,
        });
        return { tx, error };
    }

    /**
     * Executes the atomic extend_hold RPC.
     */
    async extendHoldRpc({ referenceId, additionalSeconds = 300 }) {
        const { data: tx, error } = await this.supabase.rpc("extend_hold", {
            p_reference_id: referenceId,
            p_additional_seconds: additionalSeconds,
        });
        return { tx, error };
    }

    /**
     * Executes the atomic expire_stale_holds RPC.
     */
    async expireStaleHoldsRpc() {
        const { data, error } = await this.supabase.rpc("expire_stale_holds");
        return { data, error };
    }

    /**
     * Executes either commit_transaction or rollback_transaction RPC.
     */
    async resolveTransactionRpc(fnName, referenceId) {
        const { data: tx, error } = await this.supabase.rpc(fnName, {
            p_reference_id: referenceId,
        });
        return { tx, error };
    }

    /**
     * Finds a single transaction by reference_id or returns null.
     */
    async findByReference(referenceId) {
        const { data, error } = await this.supabase
            .from("transactions")
            .select("*")
            .eq("reference_id", referenceId)
            .maybeSingle();

        if (error) throw new WalletError(error.message, "DB_ERROR");
        return data;
    }

    /**
     * Queries paginated transactions for a given walletId with cursor support.
     */
    async getTransactionsByWalletId(walletId, { limit = 20, before = null, beforeId = null } = {}) {
        let query = this.supabase
            .from("transactions")
            .select("*")
            .eq("wallet_id", walletId)
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .limit(limit + 1);

        if (before && beforeId) {
            query = query.or(
                `created_at.lt.${before},and(created_at.eq.${before},id.lt.${beforeId})`
            );
        }

        const { data, error } = await query;
        if (error) throw new WalletError(error.message, "DB_ERROR");
        return data ?? [];
    }

    /**
     * Merges extraMetadata into existing transaction metadata.
     */
    async mergeMetadata(referenceId, extraMetadata) {
        const { data: current } = await this.supabase
            .from("transactions")
            .select("metadata")
            .eq("reference_id", referenceId)
            .maybeSingle();

        const merged = { ...(current?.metadata || {}), ...extraMetadata };
        await this.supabase
            .from("transactions")
            .update({ metadata: merged })
            .eq("reference_id", referenceId);
    }

    /**
     * Updates transaction fields by reference_id.
     */
    async updateByReference(referenceId, fields) {
        const { data, error } = await this.supabase
            .from("transactions")
            .update(fields)
            .eq("reference_id", referenceId)
            .select("*")
            .maybeSingle();

        return { data, error };
    }

    /**
     * Updates transaction status with optimistic lock on fromStatus.
     */
    async updateStatusWithOptimisticLock({ id, fromStatus = "PENDING", toStatus }) {
        const { data, error } = await this.supabase
            .from("transactions")
            .update({ status: toStatus })
            .eq("id", id)
            .eq("status", fromStatus)
            .select("*")
            .single();

        return { data, error };
    }

    /**
     * Inserts a transaction record (for optimistic fallback).
     */
    async insertTransaction(txData) {
        const { data: tx, error: txError } = await this.supabase
            .from("transactions")
            .insert(txData)
            .select("*")
            .single();

        return { tx, txError };
    }

    /**
     * Deletes a transaction record by id (for optimistic fallback rollback).
     */
    async deleteById(id) {
        await this.supabase
            .from("transactions")
            .delete()
            .eq("id", id);
    }

    /**
     * Deletes a transaction record by reference_id (for optimistic fallback rollback).
     */
    async deleteByReference(referenceId) {
        await this.supabase
            .from("transactions")
            .delete()
            .eq("reference_id", referenceId);
    }

    /**
     * Finds expired PENDING transactions (for optimistic fallback reaper).
     */
    async findExpiredPending(nowIso) {
        const { data, error } = await this.supabase
            .from("transactions")
            .select("*")
            .eq("status", "PENDING")
            .lt("expires_at", nowIso);

        return { data, error };
    }

    /**
     * Atomic claim: updates status to FAILED where status is PENDING and expires_at < now.
     */
    async expireStaleHoldsDirect(nowIso) {
        const { data: expired, error } = await this.supabase
            .from("transactions")
            .update({ status: "FAILED" })
            .eq("status", "PENDING")
            .lt("expires_at", nowIso)
            .select("*");

        return { expired, error };
    }

    /**
     * Finds completed transactions for a wallet (for reconciliation).
     */
    async findCompletedByWalletId(walletId) {
        const { data, error } = await this.supabase
            .from("transactions")
            .select("type, amount, status")
            .eq("wallet_id", walletId)
            .eq("status", "COMPLETED");

        return { data, error };
    }
}

export default TransactionRepository;
