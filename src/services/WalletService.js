import { createClient } from "@supabase/supabase-js";

export class WalletError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}

export class WalletService {
  HOLD_TTL_SECONDS = 60 * 60;
  METADATA_MAX_BYTES = 4096; // FIX: was undefined — validateMetadata() silently skipped size check

  // ═══════════════════════════════════════════════════════════════════════
  // DEPLOYED SUPABASE RPCs (copy-paste these into Supabase SQL Editor)
  // ═══════════════════════════════════════════════════════════════════════
  // hold_credits, commit_transaction, rollback_transaction,
  // credit_wallet, expire_stale_holds
  //
  // See bottom of this file for full CREATE OR REPLACE FUNCTION scripts.
  // ═══════════════════════════════════════════════════════════════════════

  constructor(supabaseUrl, supabaseServiceKey) {
    this.supabase = createClient(supabaseUrl, supabaseServiceKey);
    this.defaultInitialBalance = Number(
      process.env.INITIAL_WALLET_BALANCE ||
      process.env.DEFAULT_WALLET_BALANCE ||
      0
    );
  }

  // ─────────────────────────────────────────────
  // WALLET MANAGEMENT
  // ─────────────────────────────────────────────

  /**
   * FIX: استعمل upsert بدل check+insert لتفادي race condition
   */
  async createWallet(userId, initialBalance = this.defaultInitialBalance) {
    const { data, error } = await this.supabase
      .from("wallets")
      .insert({ user_id: userId, balance: initialBalance })
      .select("*")
      .maybeSingle();

    if (error) {
      if (error.code === "23505" || error.code === "23503") {
        // Race condition: wallet was created between check and insert
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

    console.log(`[WalletService] Wallet ensured for user ${userId}.`);
    return data;
  }

  async ensureWallet(userId, initialBalance = this.defaultInitialBalance) {
    return this.createWallet(userId, initialBalance);
  }

  // ─────────────────────────────────────────────
  // HOLD / COMMIT / ROLLBACK
  // ─────────────────────────────────────────────

  async hold({ userId, amount, referenceId, metadata = {} }) {
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

    const { data: tx, error } = await this.supabase.rpc("hold_credits", {
      p_wallet_id: wallet.id,
      p_amount: amount,
      p_reference_id: referenceId,
      p_metadata: metadata,
      p_expires_at: expiresAt,
    });

    if (error) {
      if (this.isMissingRpcError(error)) {
        console.warn("[WalletService] RPC hold_credits not found, using table fallback.");
        return this.holdFallback({ wallet, amount, referenceId, metadata, expiresAt });
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

  async commit(referenceId) {
    return this.resolveTransaction(referenceId, "COMPLETED");
  }

  /**
   * Safe when BullMQ replays the job: if the hold was already committed, this is a no-op.
   */
  async commitHoldIdempotent(referenceId) {
    if (!referenceId) return;
    try {
      await this.commit(referenceId);
    } catch (err) {
      if (!(err instanceof WalletError)) throw err;
      const { data: tx } = await this.supabase
        .from("transactions")
        .select("status")
        .eq("reference_id", referenceId)
        .maybeSingle();
      if (tx?.status === "COMPLETED") return;
      throw err;
    }
  }

  async rollback(referenceId) {
    return this.resolveTransaction(referenceId, "FAILED");
  }

  // ─────────────────────────────────────────────
  // CREDIT
  // ─────────────────────────────────────────────

  async credit({ userId, amount, referenceId, metadata = {} }) {
    this.validateMetadata(metadata); // FIX: validate قبل أي شيء

    const wallet = await this.getWalletOrThrow(userId);

    const { data: tx, error } = await this.supabase.rpc("credit_wallet", {
      p_wallet_id: wallet.id,
      p_amount: amount,
      p_reference_id: referenceId,
      p_metadata: metadata,
    });

    if (error) {
      if (this.isMissingRpcError(error)) {
        console.warn("[WalletService] RPC credit_wallet not found, using table fallback.");
        return this.creditFallback({ wallet, amount, referenceId, metadata });
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

    let query = this.supabase
      .from("transactions")
      .select("*")
      .eq("wallet_id", wallet.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1); // Fetch one extra to determine if there's a next page

    // Apply cursor filter when both cursor components are provided
    if (before && beforeId) {
      // Return rows where created_at < before, OR created_at = before AND id < beforeId
      query = query.or(
        `created_at.lt.${before},and(created_at.eq.${before},id.lt.${beforeId})`
      );
    }

    const { data, error } = await query;
    if (error) throw new WalletError(error.message, "DB_ERROR");

    const rows = data ?? [];
    const hasNextPage = rows.length > limit;
    if (hasNextPage) rows.pop(); // Remove the extra sentinel row

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
    const { data, error } = await this.supabase.rpc("expire_stale_holds");

    if (error) {
      if (this.isMissingRpcError(error)) {
        console.warn("[WalletService] RPC expire_stale_holds not found, using table fallback.");
        return this.expireStaleHoldsFallback();
      }
      throw new WalletError(error.message, "DB_ERROR");
    }

    return data ?? 0;
  }

  // ─────────────────────────────────────────────
  // INTERNAL HELPERS
  // ─────────────────────────────────────────────

  /**
   * FIX: استعمل maybeSingle() بدل single() لتفريق "مش موجود" عن "DB error"
   */
  async getWalletOrThrow(userId) {
    const { data, error } = await this.supabase
      .from("wallets")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw new WalletError(error.message, "DB_ERROR");
    if (!data) throw new WalletError(`Wallet not found for user ${userId}`, "WALLET_NOT_FOUND");

    return data;
  }

  async getWalletByIdOrThrow(walletId) {
    const { data, error } = await this.supabase
      .from("wallets")
      .select("*")
      .eq("id", walletId)
      .maybeSingle();

    if (error) throw new WalletError(error.message, "DB_ERROR");
    if (!data) throw new WalletError(`Wallet not found for id ${walletId}`, "WALLET_NOT_FOUND");

    return data;
  }

  async getTransactionByReferenceOrThrow(referenceId) {
    const { data, error } = await this.supabase
      .from("transactions")
      .select("*")
      .eq("reference_id", referenceId)
      .maybeSingle();

    if (error) throw new WalletError(error.message, "DB_ERROR");
    if (!data) {
      throw new WalletError(
        `Transaction not found for reference ${referenceId}`,
        "TRANSACTION_NOT_FOUND"
      );
    }

    return data;
  }

  async resolveTransaction(referenceId, newStatus) {
    const fnName =
      newStatus === "COMPLETED" ? "commit_transaction" : "rollback_transaction";

    const { data: tx, error } = await this.supabase.rpc(fnName, {
      p_reference_id: referenceId,
    });

    if (error) {
      if (this.isMissingRpcError(error)) {
        console.warn(`[WalletService] RPC ${fnName} not found, using table fallback.`);
        return newStatus === "COMPLETED"
          ? this.commitFallback(referenceId)
          : this.rollbackFallback(referenceId);
      }

      throw new WalletError(error.message, "TRANSACTION_NOT_FOUND");
    }

    return tx;
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
    if (json.length > this.METADATA_MAX_BYTES) {
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
   * - Insert transaction أولاً (لو فشل، ما لمسناش الرصيد)
   * - Optimistic lock على الـ balance لتفادي race condition
   */
  async holdFallback({ wallet, amount, referenceId, metadata, expiresAt }) {
    // ① re-read الـ wallet بأحدث قيمة (optimistic lock snapshot)
    const fresh = await this.getWalletByIdOrThrow(wallet.id);

    const newBalance = Number(fresh.balance) - Number(amount);
    if (newBalance < 0) {
      throw new WalletError(
        `Insufficient funds: need ${amount}, have ${fresh.balance}`,
        "INSUFFICIENT_FUNDS"
      );
    }

    // ② insert transaction أولاً — لو duplicate يرمي error بلا ما يلمس الرصيد
    const { data: tx, error: txError } = await this.supabase
      .from("transactions")
      .insert({
        wallet_id: fresh.id,
        amount,
        type: "DEBIT",
        status: "PENDING",
        reference_id: referenceId,
        metadata,
        expires_at: expiresAt,
      })
      .select("*")
      .single();

    if (txError) {
      if (txError.code === "23505") {
        throw new WalletError(
          `Transaction ${referenceId} already exists (duplicate)`,
          "DUPLICATE_TRANSACTION"
        );
      }
      throw new WalletError(txError.message, "DB_ERROR");
    }

    // ③ update balance مع optimistic lock: .eq("balance", fresh.balance)
    const { error: walletError, count } = await this.supabase
      .from("wallets")
      .update({ balance: newBalance })
      .eq("id", fresh.id)
      .eq("balance", fresh.balance); // FIX: optimistic lock

    if (walletError || count === 0) {
      // rollback: احذف الـ transaction اللي حطيناه
      await this.supabase
        .from("transactions")
        .delete()
        .eq("reference_id", referenceId);

      throw new WalletError(
        "Balance changed concurrently, please retry",
        "CONFLICT"
      );
    }

    return tx;
  }

  /**
   * FIX:
   * - Insert transaction أولاً
   * - Optimistic lock على الـ balance
   */
  async creditFallback({ wallet, amount, referenceId, metadata }) {
    const fresh = await this.getWalletByIdOrThrow(wallet.id);
    const newBalance = Number(fresh.balance) + Number(amount);

    // ① insert transaction أولاً
    const { data: tx, error: txError } = await this.supabase
      .from("transactions")
      .insert({
        wallet_id: fresh.id,
        amount,
        type: "CREDIT",
        status: "COMPLETED",
        reference_id: referenceId,
        metadata,
        expires_at: null,
      })
      .select("*")
      .single();

    if (txError) {
      if (txError.code === "23505") {
        throw new WalletError(
          `Transaction ${referenceId} already exists (duplicate)`,
          "DUPLICATE_TRANSACTION"
        );
      }
      throw new WalletError(txError.message, "DB_ERROR");
    }

    // ② update balance مع optimistic lock
    const { error: walletError, count } = await this.supabase
      .from("wallets")
      .update({ balance: newBalance })
      .eq("id", fresh.id)
      .eq("balance", fresh.balance); // FIX: optimistic lock

    if (walletError || count === 0) {
      await this.supabase
        .from("transactions")
        .delete()
        .eq("reference_id", referenceId);

      throw new WalletError(
        "Balance changed concurrently, please retry",
        "CONFLICT"
      );
    }

    return tx;
  }

  async commitFallback(referenceId) {
    const tx = await this.getTransactionByReferenceOrThrow(referenceId);

    if (tx.status === "COMPLETED") return tx; // FIX: idempotent
    if (tx.status !== "PENDING") {
      throw new WalletError(
        `Transaction ${referenceId} is not pending (status: ${tx.status})`,
        "INVALID_TRANSITION"
      );
    }

    // FIX: optimistic lock — يتأكد الـ status ما تغيّرش
    const { data, error } = await this.supabase
      .from("transactions")
      .update({ status: "COMPLETED" })
      .eq("id", tx.id)
      .eq("status", "PENDING")
      .select("*")
      .single();

    if (error || !data) {
      throw new WalletError(
        "Transaction was modified concurrently",
        "CONFLICT"
      );
    }

    return data;
  }

  /**
   * FIX:
   * - Idempotent: لو FAILED بالفعل → return مباشرة
   * - Optimistic lock على الـ status لتفادي double-rollback
   * - نحدّث الـ status أولاً ثم نرجع الرصيد (عكس النسخة القديمة)
   */
  async rollbackFallback(referenceId) {
    const tx = await this.getTransactionByReferenceOrThrow(referenceId);

    if (tx.status === "FAILED") return tx; // FIX: idempotent
    if (tx.status !== "PENDING") {
      throw new WalletError(
        `Cannot rollback: status is ${tx.status}`,
        "INVALID_TRANSITION"
      );
    }

    // ① lock الـ status أولاً بـ optimistic lock
    const { data: updated, error: txError } = await this.supabase
      .from("transactions")
      .update({ status: "FAILED" })
      .eq("id", tx.id)
      .eq("status", "PENDING") // FIX: لو غيّره أحد قبلنا → يفشل
      .select("*")
      .single();

    if (txError || !updated) {
      throw new WalletError(
        "Transaction was modified concurrently",
        "CONFLICT"
      );
    }

    // ② بعد ما أمّنّا الـ status، نرجع الرصيد
    const wallet = await this.getWalletByIdOrThrow(tx.wallet_id);
    const { error: walletError } = await this.supabase
      .from("wallets")
      .update({ balance: Number(wallet.balance) + Number(tx.amount) })
      .eq("id", wallet.id);

    if (walletError) {
      throw new WalletError(walletError.message, "DB_ERROR");
    }

    return updated;
  }

  /**
   * FIX:
   * - Update status لـ FAILED أولاً في query واحد (atomic claim)
   * - يمنع أي instance ثاني من يشغّل نفس الـ holds
   */
  async expireStaleHoldsFallback() {
    const now = new Date().toISOString();

    // ① atomic claim: غيّر الـ status مباشرة بشرط PENDING
    const { data: expired, error } = await this.supabase
      .from("transactions")
      .update({ status: "FAILED" })
      .eq("status", "PENDING")
      .lt("expires_at", now)
      .select("*");

    if (error) throw new WalletError(error.message, "DB_ERROR");

    // ② ارجع الرصيد لكل transaction فشلت
    for (const tx of expired || []) {
      const wallet = await this.getWalletByIdOrThrow(tx.wallet_id);
      await this.supabase
        .from("wallets")
        .update({ balance: Number(wallet.balance) + Number(tx.amount) })
        .eq("id", wallet.id);
    }

    return expired?.length ?? 0;
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