/** @owns Manages user credit balance, two-phase holds, settlements, and refunds. */
import { createClient } from "@supabase/supabase-js";
import { createLogger, LogEvents } from "../../infrastructure/logging/index.js";

const walletLogger = createLogger("wallet");
const billingLogger = createLogger("billing");

import { WalletError, BillingConfigurationError } from "./BillingErrors.js";
import { WalletRepository } from "./repositories/WalletRepository.js";
import { TransactionRepository } from "./repositories/TransactionRepository.js";
export { WalletError, BillingConfigurationError };

export class WalletService {
  HOLD_TTL_SECONDS = 10 * 60; // 10 minutes TTL per specification clarification
  METADATA_MAX_BYTES = 4096; // FIX: was undefined — validateMetadata() silently skipped size check

  // ═══════════════════════════════════════════════════════════════════════
  // DEPLOYED SUPABASE RPCs (copy-paste these into Supabase SQL Editor)
  // ═══════════════════════════════════════════════════════════════════════
  // hold_credits, commit_transaction, rollback_transaction,
  // credit_wallet, expire_stale_holds
  //
  // See bottom of this file for full CREATE OR REPLACE FUNCTION scripts.
  // ═══════════════════════════════════════════════════════════════════════

  constructor(supabaseUrlOrDeps, supabaseServiceKey = null, { usageEventRepo = null, walletRepo = null, txRepo = null, defaultInitialBalance = null } = {}) {
    this._supabase = null;
    if (typeof supabaseUrlOrDeps === "object" && supabaseUrlOrDeps !== null) {
      const deps = supabaseUrlOrDeps;
      this.walletRepo = deps.walletRepo || null;
      this.txRepo = deps.txRepo || deps.transactionRepo || null;
      this.usageEventRepo = deps.usageEventRepo || usageEventRepo || null;
      this.defaultInitialBalance = deps.defaultInitialBalance !== undefined
        ? deps.defaultInitialBalance
        : Number(process.env.INITIAL_WALLET_BALANCE || process.env.DEFAULT_WALLET_BALANCE || 0);
      this.supabase = deps.supabase || null;
    } else if (typeof supabaseUrlOrDeps === "string") {
      const client = createClient(supabaseUrlOrDeps, supabaseServiceKey);
      this.walletRepo = walletRepo || new WalletRepository(client);
      this.txRepo = txRepo || new TransactionRepository(client);
      this.usageEventRepo = usageEventRepo || null;
      this.defaultInitialBalance = defaultInitialBalance !== undefined
        ? defaultInitialBalance
        : Number(process.env.INITIAL_WALLET_BALANCE || process.env.DEFAULT_WALLET_BALANCE || 0);
      this.supabase = client;
    } else {
      this.walletRepo = null;
      this.txRepo = null;
      this.usageEventRepo = null;
      this.defaultInitialBalance = 0;
      this.supabase = null;
    }
  }

  get supabase() {
    return this._supabase;
  }

  set supabase(client) {
    this._supabase = client;
    if (this.walletRepo) this.walletRepo.supabase = client;
    if (this.txRepo) this.txRepo.supabase = client;
  }

  // ─────────────────────────────────────────────
  // WALLET MANAGEMENT
  // ─────────────────────────────────────────────

  /**
   * FIX: استعمل upsert بدل check+insert لتفادي race condition
   */
  async createWallet(userId, initialBalance = this.defaultInitialBalance) {
    if (!this.walletRepo) throw new WalletError("WalletRepository is not configured", "DB_ERROR");
    return this.walletRepo.createOrEnsureWallet(userId, initialBalance);
  }

  async ensureWallet(userId, initialBalance = this.defaultInitialBalance) {
    return this.createWallet(userId, initialBalance);
  }

  // ─────────────────────────────────────────────
  // BILLING RESERVATION API (Unified Entry Point)
  // ─────────────────────────────────────────────
  // Callers use reserve() / settle() / release() without knowing
  // whether the cost is zero (NO_CHARGE) or non-zero (CHARGEABLE).
  // WalletService is the dispatcher — the caller stays clean.

  /**
   * Unified reservation entry point.
   *
   * amount = 0 → NO_CHARGE: records audit event in usage_events,
   *              zero financial movement, no row in transactions.
   * amount > 0 → CHARGEABLE: two-phase commit via hold_credits RPC.
   *
   * @param {{ userId: string, amount: number, referenceId: string, metadata?: object }} params
   * @returns {Promise<BillingReservation>}
   *   { kind: "NO_CHARGE"|"CHARGEABLE", status: "ACTIVE"|"HELD", referenceId, amount, ... }
   */
  async reserve({ userId, amount, referenceId, metadata = {} }) {
    if (typeof amount !== "number" || Number.isNaN(amount) || !Number.isFinite(amount) || amount < 0) {
      const err = new Error(`Invalid billing amount: ${amount}. Amount must be a finite, non-negative number.`);
      err.code = "PRICING_CONFIG_ERROR";
      err.category = "SERVER_FAULT";
      err.statusCode = 500;
      throw err;
    }

    if (amount === 0) {
      // ── Free usage path ───────────────────────────────────────────────────
      // DESIGN DECISION: usage_events is a Best-Effort audit trail.
      //
      //   Financial truth  → transactions table (MUST not fail silently)
      //   Operational audit → usage_events table (MAY fail gracefully)
      //
      // A usage_events failure MUST NOT block execution, because:
      //   1. The user's financial state (credits) is unaffected (no hold placed).
      //   2. Blocking execution would punish the user for an observability failure.
      //   3. The Models Management System logs provider calls independently.
      //
      // If you need authoritative metering, promote usage_events to a
      // separate critical service with its own retry queue.
      if (this.usageEventRepo) {
        await this.usageEventRepo
          .recordActive({ referenceId, userId, metadata })
          .catch((err) => walletLogger.warn({ event: "billing.usage_event.failed", err }, `usage_events recordActive failed (non-fatal): ${err.message}`));
      }
      billingLogger.info({ event: LogEvents.BILLING_COST_CALCULATED, referenceId, amount: 0 }, "Free tier reservation (NO_CHARGE)");
      return {
        kind: "NO_CHARGE",
        status: "ACTIVE",
        referenceId,
        amount: 0,
      };
    }

    // Paid usage path — existing financial hold
    const wallet = await this.getWalletOrThrow(userId);
    const tx = await this._holdForWallet({ wallet, userId, amount, referenceId, metadata });
    walletLogger.info({ event: LogEvents.WALLET_HOLD_CREATED, referenceId, amount: tx.amount ?? amount, userId }, `Placed credit hold of ${tx.amount ?? amount} credits`);
    return {
      kind: "CHARGEABLE",
      status: "HELD",
      referenceId: tx.reference_id || referenceId,
      amount: tx.amount ?? amount,
      walletId: wallet.id,
      transaction: tx,
    };
  }

  /**
   * Settle a reservation after successful execution.
   *
   * NO_CHARGE → marks usage_events row COMPLETED (no-op on wallet)
   * CHARGEABLE → commitHoldIdempotent (finalises financial debit)
   *
   * @param {BillingReservation} reservation
   * @returns {Promise<BillingReservation>}
   */
  async settle(reservation, extraMetadata = null) {
    if (!reservation) return null;

    if (reservation.kind === "NO_CHARGE") {
      if (this.usageEventRepo) {
        await this.usageEventRepo
          .markCompleted(reservation.referenceId)
          .catch((err) => walletLogger.warn({ event: "billing.usage_event.failed", err }, `usage_events markCompleted failed (non-fatal): ${err.message}`));
      }
      return { ...reservation, status: "COMPLETED" };
    }

    // CHARGEABLE — commit the financial hold
    await this.commitHoldIdempotent(reservation.referenceId, extraMetadata);
    walletLogger.info({ event: LogEvents.WALLET_CHARGE_COMPLETED, referenceId: reservation.referenceId }, `Committed credit hold for ${reservation.referenceId}`);
    return { ...reservation, status: "COMMITTED" };
  }

  /**
   * Release / rollback a reservation on failure or cancellation.
   *
   * NO_CHARGE → marks usage_events row RELEASED (no-op on wallet)
   * CHARGEABLE → rollback (refunds credits to user wallet)
   *
   * @param {BillingReservation} reservation
   * @param {Object} [extraMetadata=null]
   * @returns {Promise<BillingReservation>}
   */
  async release(reservation, extraMetadata = null) {
    if (!reservation) return null;

    if (reservation.kind === "NO_CHARGE") {
      if (this.usageEventRepo) {
        await this.usageEventRepo
          .markReleased(reservation.referenceId)
          .catch((err) => walletLogger.warn({ event: "billing.usage_event.failed", err }, `usage_events markReleased failed (non-fatal): ${err.message}`));
      }
      return { ...reservation, status: "RELEASED" };
    }

    // CHARGEABLE — rollback the financial hold
    await this.rollback(reservation.referenceId, extraMetadata);
    walletLogger.info({ event: LogEvents.WALLET_HOLD_RELEASED, referenceId: reservation.referenceId }, `Released credit hold for ${reservation.referenceId}`);
    return { ...reservation, status: "RELEASED" };
  }

  // ─────────────────────────────────────────────
  // HOLD / COMMIT / ROLLBACK
  // ─────────────────────────────────────────────

  /**
   * Internal helper: executes the financial hold given an already-fetched wallet.
   * Used by both hold() and reserve() to avoid duplicating the RPC logic.
   */
  async _holdForWallet({ wallet, amount, referenceId, metadata }) {
    this.validateMetadata(metadata);

    if (wallet.balance < amount) {
      throw new WalletError(
        `Insufficient funds: need ${amount}, have ${wallet.balance}`,
        "INSUFFICIENT_FUNDS"
      );
    }

    const expiresAt = new Date(Date.now() + this.HOLD_TTL_SECONDS * 1000).toISOString();

    const { tx, error } = await this.txRepo.holdCreditsRpc({
      walletId: wallet.id,
      amount,
      referenceId,
      metadata,
      expiresAt,
    });

    if (error) {
      if (this.isMissingRpcError(error)) {
        throw new BillingConfigurationError("[WalletService] RPC hold_credits missing (PGRST202 / schema cache): fail closed");
      }
      if (error.code === "23505") {
        throw new WalletError(
          `Transaction ${referenceId} already exists (duplicate)`,
          "DUPLICATE_TRANSACTION"
        );
      }
      throw new WalletError(error.message, "DB_ERROR");
    }

    return tx;
  }

  async hold({ userId, amount, referenceId, metadata = {} }) {
    if (typeof amount !== "number" || Number.isNaN(amount) || !Number.isFinite(amount) || amount <= 0) {
      const err = new Error(`Invalid hold amount: ${amount}. Hold amount must be a positive finite number.`);
      err.code = "PRICING_CONFIG_ERROR";
      err.category = "SERVER_FAULT";
      err.statusCode = 500;
      throw err;
    }
    this.validateMetadata(metadata); // FIX: validate قبل أي شيء

    const wallet = await this.getWalletOrThrow(userId);

    if (wallet.balance < amount) {
      throw new WalletError(
        `Insufficient funds: need ${amount}, have ${wallet.balance}`,
        "INSUFFICIENT_FUNDS"
      );
    }

    const expiresAt = new Date(
      Date.now() + this.HOLD_TTL_SECONDS * 1000
    ).toISOString();

    const { tx, error } = await this.txRepo.holdCreditsRpc({
      walletId: wallet.id,
      amount,
      referenceId,
      metadata,
      expiresAt,
    });

    if (error) {
      if (this.isMissingRpcError(error)) {
        throw new BillingConfigurationError("[WalletService] RPC hold_credits missing (PGRST202 / schema cache): fail closed");
      }

      if (error.code === "23505") {
        throw new WalletError(
          `Transaction ${referenceId} already exists (duplicate)`,
          "DUPLICATE_TRANSACTION"
        );
      }

      throw new WalletError(error.message, "DB_ERROR");
    }

    return tx;
  }

  async commit(referenceId, extraMetadata = null) {
    return this.resolveTransaction(referenceId, "COMPLETED", extraMetadata);
  }

  /**
   * Safe when BullMQ replays the job: if the hold was already committed, this is a no-op.
   */
  async commitHoldIdempotent(referenceId, extraMetadata = null) {
    if (!referenceId) return;
    try {
      return await this.commit(referenceId, extraMetadata);
    } catch (err) {
      const isStatusErr = err.message?.includes("COMPLETED") || err.message?.includes("not PENDING");
      let tx = null;
      try {
        if (this.txRepo) {
          tx = await this.txRepo.findByReference(referenceId);
        } else if (this.supabase) {
          const res = await this.supabase
            .from("transactions")
            .select("status")
            .eq("reference_id", referenceId)
            .maybeSingle();
          tx = res?.data;
        }
      } catch (findErr) {
        walletLogger.warn(
          { event: "wallet.idempotent_lookup_failed", referenceId, err: findErr?.message },
          `Failed to lookup transaction status during commit recovery for reference ${referenceId}: ${findErr?.message}`
        );
      }

      if (tx?.status === "COMPLETED") {
        if (extraMetadata && typeof extraMetadata === "object") {
          await this._mergeTransactionMetadata(referenceId, extraMetadata).catch(() => {});
        }
        return { status: "COMPLETED", reference_id: referenceId };
      }
      throw err;
    }
  }

  async rollback(referenceId, extraMetadata = null) {
    return this.resolveTransaction(referenceId, "FAILED", extraMetadata);
  }

  /**
   * Safe when BullMQ retries, crashes, or times out: if the hold was already rolled back, this is a no-op.
   */
  async rollbackHoldIdempotent(referenceId, extraMetadata = null) {
    if (!referenceId) return;
    try {
      return await this.rollback(referenceId, extraMetadata);
    } catch (err) {
      let tx = null;
      try {
        if (this.txRepo) {
          tx = await this.txRepo.findByReference(referenceId);
        } else if (this.supabase) {
          const res = await this.supabase
            .from("transactions")
            .select("status")
            .eq("reference_id", referenceId)
            .maybeSingle();
          tx = res?.data;
        }
      } catch (findErr) {
        walletLogger.warn(
          { event: "wallet.idempotent_lookup_failed", referenceId, err: findErr?.message },
          `Failed to lookup transaction status during rollback recovery for reference ${referenceId}: ${findErr?.message}`
        );
      }

      if (tx?.status === "FAILED") {
        if (extraMetadata && typeof extraMetadata === "object") {
          await this._mergeTransactionMetadata(referenceId, extraMetadata).catch(() => {});
        }
        return { status: "FAILED", reference_id: referenceId };
      }
      throw err;
    }
  }

  /**
   * Extends the TTL of an active PENDING reservation (heartbeat).
   *
   * @param {string} referenceId - The hold reference ID
   * @param {number} [additionalSeconds=300] - Seconds to extend the hold
   * @returns {Promise<Object>}
   */
  async extendHold(referenceId, additionalSeconds = 300) {
    if (!referenceId || typeof referenceId !== "string" || !referenceId.trim()) return null;
    const seconds = Number(additionalSeconds) || 300;

    const { tx, error } = await this.txRepo.extendHoldRpc({
      referenceId,
      additionalSeconds: seconds,
    });

    if (error) {
      if (this.isMissingRpcError(error)) {
        walletLogger.warn({ rpc: "extend_hold" }, "RPC extend_hold not found, using table fallback");
        return this.extendHoldFallback(referenceId, seconds);
      }
      throw new WalletError(error.message, "DB_ERROR");
    }

    return tx;
  }

  async extendHoldFallback(referenceId, additionalSeconds = 300) {
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

  // ─────────────────────────────────────────────
  // CREDIT
  // ─────────────────────────────────────────────

  async credit({ userId, amount, referenceId, metadata = {} }) {
    this.validateMetadata(metadata); // FIX: validate قبل أي شيء

    const wallet = await this.getWalletOrThrow(userId);

    const { tx, error } = await this.walletRepo.creditWalletRpc({
      walletId: wallet.id,
      amount,
      referenceId,
      metadata,
    });

    if (error) {
      if (this.isMissingRpcError(error)) {
        throw new BillingConfigurationError("[WalletService] RPC credit_wallet missing (PGRST202 / schema cache): fail closed");
      }

      if (error.code === "23505") {
        throw new WalletError(
          `Transaction ${referenceId} already exists (duplicate)`,
          "DUPLICATE_TRANSACTION"
        );
      }

      throw new WalletError(error.message, "DB_ERROR");
    }

    return tx;
  }

  // ─────────────────────────────────────────────
  // QUERIES
  // ─────────────────────────────────────────────

  async getBalance(userId) {
    const wallet = await this.getWalletOrThrow(userId);
    return wallet.balance;
  }

  async checkSufficientFunds(userId, amount) {
    const wallet = await this.getWalletOrThrow(userId);

    if (wallet.balance < amount) {
      throw new WalletError(
        `Insufficient funds: need ${amount}, have ${wallet.balance}`,
        "INSUFFICIENT_FUNDS"
      );
    }

    return true;
  }

  /**
   * Get paginated transaction history for a user.
   *
   * Uses cursor-based pagination (stable on a live append-only table):
   *   - Cursor = { before: ISO-8601 timestamp, beforeId: UUID }
   *   - Returns limit+1 rows to detect if a next page exists
   *
   * Falls back to offset pagination if before/beforeId are not provided
   * (for backwards compatibility with internal callers).
   *
   * @returns {{ transactions: Array, nextCursor: {before, beforeId} | null }}
   */
  async getTransactions(userId, limit = 20, before = null, beforeId = null) {
    const wallet = await this.getWalletOrThrow(userId);
    const rows = await this.txRepo.getTransactionsByWalletId(wallet.id, { limit, before, beforeId });
    const hasNextPage = rows.length > limit;
    if (hasNextPage) rows.pop();

    const nextCursor = hasNextPage && rows.length > 0
      ? {
          before: rows[rows.length - 1].created_at,
          beforeId: rows[rows.length - 1].id,
        }
      : null;

    return { transactions: rows, nextCursor };
  }

  // ─────────────────────────────────────────────
  // EXPIRE STALE HOLDS
  // ─────────────────────────────────────────────

  async expireStaleHolds() {
    const { data, error } = await this.txRepo.expireStaleHoldsRpc();

    if (error) {
      if (this.isMissingRpcError(error)) {
        walletLogger.warn({ rpc: "expire_stale_holds" }, "RPC expire_stale_holds not found, using table fallback");
        return this.expireStaleHoldsFallback();
      }
      throw new WalletError(error.message, "DB_ERROR");
    }

    if (Array.isArray(data)) return data.length;
    if (typeof data === "number") return data;
    return typeof data?.count === "number" ? data.count : 0;
  }

  /**
   * Sweeps expired holds, refunds balances, and returns the list of expired hold records
   * with their workflowId and mediaId for domain reconciliation.
   *
   * @returns {Promise<Array<{ holdId: string, referenceId: string, workflowId: string|null, mediaId: string|null, amount: number }>>}
   */
  async reapExpiredHolds() {
    const { data, error } = await this.txRepo.expireStaleHoldsRpc();
    let expiredTxs = [];

    if (!error && data) {
      expiredTxs = Array.isArray(data) ? data : (data?.records || []);
    } else if (error) {
      if (this.isMissingRpcError(error)) {
        walletLogger.warn({ rpc: "expire_stale_holds" }, "RPC expire_stale_holds not found, using table fallback");
        expiredTxs = await this.expireStaleHoldsFallback({ returnRows: true });
      } else {
        throw new WalletError(error.message, "DB_ERROR");
      }
    }

    return (expiredTxs || []).map((tx) => ({
      holdId: tx.reference_id || tx.id,
      referenceId: tx.reference_id,
      workflowId: tx.metadata?.workflowId || null,
      mediaId: tx.metadata?.mediaId || null,
      amount: tx.amount,
      walletId: tx.wallet_id,
      transactionId: tx.id,
    }));
  }


  // ─────────────────────────────────────────────
  // INTERNAL HELPERS
  // ─────────────────────────────────────────────

  /**
   * FIX: استعمل maybeSingle() بدل single() لتفريق "مش موجود" عن "DB error"
   */
  async getWalletOrThrow(userId) {
    if (!this.walletRepo) throw new WalletError("WalletRepository is not configured", "DB_ERROR");
    const data = await this.walletRepo.findByUserId(userId);
    if (!data) throw new WalletError(`Wallet not found for user ${userId}`, "WALLET_NOT_FOUND");
    return data;
  }

  async getWalletByIdOrThrow(walletId) {
    if (!this.walletRepo) throw new WalletError("WalletRepository is not configured", "DB_ERROR");
    const data = await this.walletRepo.findById(walletId);
    if (!data) throw new WalletError(`Wallet not found for id ${walletId}`, "WALLET_NOT_FOUND");
    return data;
  }

  async getTransactionByReferenceOrThrow(referenceId) {
    if (!this.txRepo) throw new WalletError("TransactionRepository is not configured", "DB_ERROR");
    const data = await this.txRepo.findByReference(referenceId);
    if (!data) {
      throw new WalletError(
        `Transaction not found for reference ${referenceId}`,
        "TRANSACTION_NOT_FOUND"
      );
    }
    return data;
  }

  async resolveTransaction(referenceId, newStatus, extraMetadata = null) {
    const fnName =
      newStatus === "COMPLETED" ? "commit_transaction" : "rollback_transaction";

    const { tx, error } = await this.txRepo.resolveTransactionRpc(fnName, referenceId);

    if (error) {
      if (this.isMissingRpcError(error)) {
        throw new BillingConfigurationError(`[WalletService] RPC ${fnName} missing (PGRST202 / schema cache): fail closed`);
      }

      throw new WalletError(error.message, "TRANSACTION_NOT_FOUND");
    }

    if (extraMetadata && typeof extraMetadata === "object") {
      await this._mergeTransactionMetadata(referenceId, extraMetadata).catch(() => {});
    }

    return tx;
  }

  async _mergeTransactionMetadata(referenceId, extraMetadata) {
    await this.txRepo.mergeMetadata(referenceId, extraMetadata);
  }

  isMissingRpcError(error) {
    const message = String(error?.message || "").toLowerCase();
    return error?.code === "PGRST202" || message.includes("schema cache");
  }

  /**
   * FIX: validate metadata — plain object, max 4KB
   */
  validateMetadata(metadata) {
    if (typeof metadata !== "object" || Array.isArray(metadata) || metadata === null) {
      throw new WalletError("Metadata must be a plain object", "INVALID_METADATA");
    }
    const json = JSON.stringify(metadata);
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > this.METADATA_MAX_BYTES) {
      throw new WalletError(
        `Metadata too large (max ${this.METADATA_MAX_BYTES} bytes)`,
        "INVALID_METADATA"
      );
    }
  }

  // ─────────────────────────────────────────────
  // FALLBACK METHODS (when RPCs not available)
  // ─────────────────────────────────────────────



  /**
   * FIX:
   * - Update status لـ FAILED أولاً في query واحد (atomic claim)
   * - يمنع أي instance ثاني من يشغّل نفس الـ holds
   */
  async expireStaleHoldsFallback(options = {}) {
    const returnRows = options?.returnRows === true;
    const now = new Date().toISOString();

    const { expired, error } = await this.txRepo.expireStaleHoldsDirect(now);
    if (error) throw new WalletError(error.message, "DB_ERROR");

    for (const tx of expired || []) {
      const wallet = await this.getWalletByIdOrThrow(tx.wallet_id);
      await this.walletRepo.restoreBalance(wallet.id, tx.amount, wallet.balance);
    }

    return returnRows ? (expired || []) : (expired?.length ?? 0);
  }
}

/* =========================================================================
   SUPABASE RPC MIGRATION SCRIPT (COPY-PASTE INTO SUPABASE SQL EDITOR)
   =========================================================================

-- 1. HOLD CREDITS (CREATE PENDING TRANSACTION)
CREATE OR REPLACE FUNCTION hold_credits(
  p_wallet_id UUID,
  p_amount NUMERIC,
  p_reference_id TEXT,
  p_metadata JSONB,
  p_expires_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance NUMERIC;
  v_transaction RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM transactions WHERE reference_id = p_reference_id) THEN
    RAISE EXCEPTION 'Transaction % already exists', p_reference_id USING ERRCODE = '23505';
  END IF;

  SELECT balance INTO v_balance FROM wallets WHERE id = p_wallet_id FOR UPDATE;
  
  IF v_balance IS NULL THEN RAISE EXCEPTION 'Wallet % not found', p_wallet_id; END IF;
  IF v_balance < p_amount THEN RAISE EXCEPTION 'Insufficient funds: need %, have %', p_amount, v_balance; END IF;

  UPDATE wallets SET balance = balance - p_amount WHERE id = p_wallet_id;

  INSERT INTO transactions (wallet_id, amount, type, status, reference_id, metadata, expires_at)
  VALUES (p_wallet_id, p_amount, 'DEBIT', 'PENDING', p_reference_id, p_metadata, p_expires_at)
  RETURNING * INTO v_transaction;

  RETURN row_to_json(v_transaction)::jsonb;
END;
$$;

-- 2. COMMIT TRANSACTION (MARK COMPLETED)
CREATE OR REPLACE FUNCTION commit_transaction(p_reference_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_transaction RECORD;
BEGIN
  SELECT * INTO v_transaction FROM transactions WHERE reference_id = p_reference_id FOR UPDATE;
  
  IF v_transaction IS NULL THEN RAISE EXCEPTION 'Transaction % not found', p_reference_id; END IF;
  IF v_transaction.status != 'PENDING' THEN RAISE EXCEPTION 'Transaction is not PENDING (current status: %)', v_transaction.status; END IF;

  UPDATE transactions SET status = 'COMPLETED' WHERE id = v_transaction.id RETURNING * INTO v_transaction;
  RETURN row_to_json(v_transaction)::jsonb;
END;
$$;

-- 3. ROLLBACK TRANSACTION (MARK FAILED & REFUND)
CREATE OR REPLACE FUNCTION rollback_transaction(p_reference_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_transaction RECORD;
BEGIN
  SELECT * INTO v_transaction FROM transactions WHERE reference_id = p_reference_id FOR UPDATE;
  
  IF v_transaction IS NULL THEN RAISE EXCEPTION 'Transaction % not found', p_reference_id; END IF;
  IF v_transaction.status != 'PENDING' THEN RAISE EXCEPTION 'Transaction is not PENDING (current status: %)', v_transaction.status; END IF;

  UPDATE wallets SET balance = balance + v_transaction.amount WHERE id = v_transaction.wallet_id;
  UPDATE transactions SET status = 'FAILED' WHERE id = v_transaction.id RETURNING * INTO v_transaction;

  RETURN row_to_json(v_transaction)::jsonb;
END;
$$;

-- 4. CREDIT WALLET (ADD FUNDS DIRECTLY)
CREATE OR REPLACE FUNCTION credit_wallet(
  p_wallet_id UUID,
  p_amount NUMERIC,
  p_reference_id TEXT,
  p_metadata JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_transaction RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM transactions WHERE reference_id = p_reference_id) THEN
    RAISE EXCEPTION 'Transaction % already exists', p_reference_id USING ERRCODE = '23505';
  END IF;

  UPDATE wallets SET balance = balance + p_amount WHERE id = p_wallet_id;

  INSERT INTO transactions (wallet_id, amount, type, status, reference_id, metadata)
  VALUES (p_wallet_id, p_amount, 'CREDIT', 'COMPLETED', p_reference_id, p_metadata)
  RETURNING * INTO v_transaction;

  RETURN row_to_json(v_transaction)::jsonb;
END;
$$;

-- 5. EXPIRE STALE HOLDS
CREATE OR REPLACE FUNCTION expire_stale_holds()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_tx RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR v_tx IN
    SELECT * FROM transactions
    WHERE status = 'PENDING' AND expires_at < NOW()
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE wallets SET balance = balance + v_tx.amount WHERE id = v_tx.wallet_id;
    UPDATE transactions SET status = 'FAILED' WHERE id = v_tx.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

========================================================================= */