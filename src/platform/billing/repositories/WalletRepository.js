/**
 * @owns Persistence and atomic RPC operations for public.wallets table.
 */
import { WalletError } from "../BillingErrors.js";
import { createLogger } from "../../../infrastructure/logging/index.js";

const logger = createLogger("wallet_repo");

export class WalletRepository {
    /**
     * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
     */
    constructor(supabaseClient) {
        if (!supabaseClient) {
            throw new Error("[WalletRepository] supabaseClient is required");
        }
        this.supabase = supabaseClient;
    }

    /**
     * Creates a wallet row, handling 23505 race condition by reading the existing row.
     * @param {string} userId
     * @param {number} initialBalance
     * @returns {Promise<object>}
     */
    async createOrEnsureWallet(userId, initialBalance = 0) {
        const { data, error } = await this.supabase
            .from("wallets")
            .insert({ user_id: userId, balance: initialBalance })
            .select("*")
            .maybeSingle();

        if (error) {
            if (error.code === "23505" || error.code === "23503") {
                const { data: existing, error: selectErr } = await this.supabase
                    .from("wallets")
                    .select("*")
                    .eq("user_id", userId)
                    .single();
                if (selectErr) throw new WalletError(selectErr.message, "DB_ERROR");
                return existing;
            }
            throw new WalletError(error.message, "DB_ERROR");
        }

        logger.info({ userId }, `Wallet ensured for user ${userId}`);
        return data;
    }

    /**
     * Finds a wallet by user_id or returns null.
     * @param {string} userId
     * @returns {Promise<object|null>}
     */
    async findByUserId(userId) {
        const { data, error } = await this.supabase
            .from("wallets")
            .select("*")
            .eq("user_id", userId)
            .maybeSingle();

        if (error) throw new WalletError(error.message, "DB_ERROR");
        return data;
    }

    /**
     * Finds a wallet by primary key id or returns null.
     * @param {string} walletId
     * @returns {Promise<object|null>}
     */
    async findById(walletId) {
        const { data, error } = await this.supabase
            .from("wallets")
            .select("*")
            .eq("id", walletId)
            .maybeSingle();

        if (error) throw new WalletError(error.message, "DB_ERROR");
        return data;
    }

    /**
     * Credits a wallet via the atomic credit_wallet RPC.
     * @param {{ walletId: string, amount: number, referenceId: string, metadata?: object }} params
     * @returns {Promise<{ tx: object|null, error: any }>}
     */
    async creditWalletRpc({ walletId, amount, referenceId, metadata = {} }) {
        const { data: tx, error } = await this.supabase.rpc("credit_wallet", {
            p_wallet_id: walletId,
            p_amount: amount,
            p_reference_id: referenceId,
            p_metadata: metadata,
        });

        return { tx, error };
    }

    /**
     * Decrements wallet balance atomically if balance is sufficient (for table fallback).
     * @param {string} walletId
     * @param {number} amount
     * @param {number} currentBalance
     * @returns {Promise<{ ok: boolean, newBalance?: number, error?: any }>}
     */
    async decrementBalanceOptimistic(walletId, amount, currentBalance) {
        const newBalance = currentBalance - amount;
        const { error, count } = await this.supabase
            .from("wallets")
            .update({ balance: newBalance })
            .eq("id", walletId)
            .eq("balance", currentBalance);

        if (error || count === 0) {
            return { ok: false, error: error || new Error("Optimistic lock failure") };
        }
        return { ok: true, newBalance };
    }

    /**
     * Increments wallet balance (for table fallback refund/credit).
     * @param {string} walletId
     * @param {number} amount
     * @param {number} currentBalance
     * @returns {Promise<{ ok: boolean, newBalance?: number, error?: any }>}
     */
    async incrementBalanceOptimistic(walletId, amount, currentBalance) {
        const newBalance = currentBalance + amount;
        const { error, count } = await this.supabase
            .from("wallets")
            .update({ balance: newBalance })
            .eq("id", walletId)
            .eq("balance", currentBalance);

        if (error || count === 0) {
            return { ok: false, error: error || new Error("Optimistic lock failure") };
        }
        return { ok: true, newBalance };
    }

    /**
     * Unconditional balance increment (for rollback fallback error recovery).
     * @param {string} walletId
     * @param {number} amount
     * @param {number} currentBalance
     * @returns {Promise<void>}
     */
    async restoreBalance(walletId, amount, currentBalance) {
        const { error } = await this.supabase
            .from("wallets")
            .update({ balance: currentBalance + amount })
            .eq("id", walletId);

        if (error) {
            throw new WalletError(`Critical: Failed to restore wallet balance: ${error.message}`, "DB_ERROR");
        }
    }

    /**
     * Lists all wallets with basic balance info (for reconciliation job).
     * @returns {Promise<Array<{ id: string, user_id: string, balance: number }>>}
     */
    async listAll() {
        const { data, error } = await this.supabase
            .from("wallets")
            .select("id, user_id, balance");

        if (error) throw new WalletError(error.message, "DB_ERROR");
        return data || [];
    }
}
