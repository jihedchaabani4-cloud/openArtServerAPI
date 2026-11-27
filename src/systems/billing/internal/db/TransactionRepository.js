/**
 * @owns Persistence and atomic RPC operations for public.transactions table.
 *
 * TransactionRepository (System 3: Billing & Wallet)
 */
import { WalletError, BillingConfigurationError } from "../errors.js";

export class TransactionRepository {
    /**
     * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
     */
    constructor(supabaseClient) {
        if (!supabaseClient) {
            throw new BillingConfigurationError("[TransactionRepository] supabaseClient is required");
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
     * Executes the single-hop atomic hold_credits_for_user RPC (resolves wallet by user_id in DB).
     */
    async holdCreditsForUserRpc({ userId, amount, referenceId, metadata = {}, expiresAt }) {
        const { data: tx, error } = await this.supabase.rpc("hold_credits_for_user", {
            p_user_id: userId,
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
     * Passes p_extra_metadata atomically when provided, falling back to the 1-arg RPC
     * if a pre-migration PostgREST schema cache returns PGRST202.
     */
    async resolveTransactionRpc(fnName, referenceId, extraMetadata = null) {
        const hasExtra = Boolean(
            extraMetadata && typeof extraMetadata === "object" && Object.keys(extraMetadata).length > 0
        );
        const params = hasExtra
            ? { p_reference_id: referenceId, p_extra_metadata: extraMetadata }
            : { p_reference_id: referenceId };

        const { data: tx, error } = await this.supabase.rpc(fnName, params);

        if (
            error &&
            hasExtra &&
            (error.code === "PGRST202" || String(error.message || "").toLowerCase().includes("schema cache"))
        ) {
            const fallback = await this.supabase.rpc(fnName, { p_reference_id: referenceId });
            return { tx: fallback.data, error: fallback.error, metadataAppliedAtomically: false };
        }

        return { tx, error, metadataAppliedAtomically: hasExtra && !error };
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
            const safeBefore = String(before);
            const safeBeforeId = String(beforeId);
            if (/^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/i.test(safeBefore) && /^[A-Za-z0-9_-]{1,128}$/.test(safeBeforeId)) {
                query = query.or(
                    `created_at.lt.${safeBefore},and(created_at.eq.${safeBefore},id.lt.${safeBeforeId})`
                );
            }
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

    /**
     * Direct table fallback for extendHold when extend_hold RPC is unavailable.
     */
    async extendHoldDirect(referenceId, additionalSeconds = 300) {
        const { data: currentTx, error: fetchErr } = await this.supabase
            .from("transactions")
            .select("*")
            .eq("reference_id", referenceId)
            .maybeSingle();

        if (fetchErr) throw new WalletError(fetchErr.message, "DB_ERROR");
        if (!currentTx) {
            throw new WalletError(`Transaction not found for reference ${referenceId}`, "TRANSACTION_NOT_FOUND");
        }
        if (currentTx.status !== "PENDING") {
            throw new WalletError(`Cannot extend transaction with status ${currentTx.status}`, "INVALID_STATUS");
        }

        const currentExpiresMs = currentTx.expires_at ? new Date(currentTx.expires_at).getTime() : Date.now();
        const newExpiresAt = new Date(Math.max(Date.now(), currentExpiresMs) + additionalSeconds * 1000).toISOString();

        const { data: updatedTx, error: updateErr } = await this.supabase
            .from("transactions")
            .update({ expires_at: newExpiresAt })
            .eq("reference_id", referenceId)
            .eq("status", "PENDING")
            .select()
            .maybeSingle();

        if (updateErr) throw new WalletError(updateErr.message, "DB_ERROR");
        return updatedTx;
    }
}

export default TransactionRepository;
