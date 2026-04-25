const { createClient } = require("@supabase/supabase-js");

// ============================================================
// ERRORS
// ============================================================

class WalletError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}

// ============================================================
// WALLET SERVICE
// ============================================================

class WalletService {
  // كل DEBIT يعيش مدة محدودة قبل ما يتلغى آليا
  HOLD_TTL_SECONDS = 60 * 60; // ساعة كاملة

  constructor(supabaseUrl, supabaseServiceKey) {
    // Service Key ضروري باش نتجاوزو الـ RLS
    this.supabase = createClient(supabaseUrl, supabaseServiceKey);
  }

  // ──────────────────────────────────────────────────────────
  // 1. HOLD (PHASE 1)
  //    يقص الفلوس من الـ balance ويسجل العملية كـ PENDING
  //    يُستدعى من الـ API قبل ما يبعث الـ Job للـ Redis
  // ──────────────────────────────────────────────────────────

  async hold({ userId, amount, referenceId, metadata = {} }) {
    // نشدو الـ Wallet ونتفقدو الرصيد
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

    // نخدمو الـ Debit والـ Transaction في عملية أتومية واحدة
    // باش إما الاثنين يتسجلوا أو حتى واحد منهم ما يتسجلش
    const { data: tx, error } = await this.supabase.rpc("hold_credits", {
      p_wallet_id: wallet.id,
      p_amount: amount,
      p_reference_id: referenceId,
      p_metadata: metadata,
      p_expires_at: expiresAt,
    });

    if (error) {
      // الـ DB يرفض لو reference_id موجودة بالفعل (UNIQUE constraint)
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

  // ──────────────────────────────────────────────────────────
  // 2. COMMIT (PHASE 2 - SUCCESS)
  //    يبدّل الـ PENDING لـ COMPLETED
  //    يُستدعى من الـ Worker بعد ما تنجح الخدمة
  // ──────────────────────────────────────────────────────────

  async commit(referenceId) {
    return this.resolveTransaction(referenceId, "COMPLETED");
  }

  // ──────────────────────────────────────────────────────────
  // 3. ROLLBACK (PHASE 2 - FAILURE)
  //    يبدّل الـ PENDING لـ FAILED ويرجّع الفلوس للـ balance
  //    يُستدعى من الـ Worker لو فشل الـ Job
  // ──────────────────────────────────────────────────────────

  async rollback(referenceId) {
    return this.resolveTransaction(referenceId, "FAILED");
  }

  // ──────────────────────────────────────────────────────────
  // 4. CREDIT
  //    يزيد فلوس في الـ balance (مثلا بعد شراء Credits)
  //    مباشرة COMPLETED من أول وهلة
  // ──────────────────────────────────────────────────────────

  async credit({ userId, amount, referenceId, metadata = {} }) {
    const wallet = await this.getWalletOrThrow(userId);

    const { data: tx, error } = await this.supabase.rpc("credit_wallet", {
      p_wallet_id: wallet.id,
      p_amount: amount,
      p_reference_id: referenceId,
      p_metadata: metadata,
    });

    if (error) {
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

  // ──────────────────────────────────────────────────────────
  // 5. GET BALANCE
  // ──────────────────────────────────────────────────────────

  async getBalance(userId) {
    const wallet = await this.getWalletOrThrow(userId);
    return wallet.balance;
  }

  // ──────────────────────────────────────────────────────────
  // 6. GET TRANSACTION HISTORY
  // ──────────────────────────────────────────────────────────

  async getTransactions(userId, limit = 20, offset = 0) {
    const wallet = await this.getWalletOrThrow(userId);

    const { data, error } = await this.supabase
      .from("transactions")
      .select("*")
      .eq("wallet_id", wallet.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new WalletError(error.message, "DB_ERROR");

    return data ?? [];
  }

  // ──────────────────────────────────────────────────────────
  // 7. EXPIRE STALE HOLDS (للـ Cron Job)
  //    يلوق كل الـ PENDING المنتهية الصلاحية ويرجع الفلوس
  // ──────────────────────────────────────────────────────────

  async expireStaleHolds() {
    const { data, error } = await this.supabase.rpc("expire_stale_holds");

    if (error) throw new WalletError(error.message, "DB_ERROR");

    // يرجع عدد العمليات اللي تلغات
    return data ?? 0;
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  async getWalletOrThrow(userId) {
    const { data, error } = await this.supabase
      .from("wallets")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (error || !data) {
      throw new WalletError(
        `Wallet not found for user ${userId}`,
        "WALLET_NOT_FOUND"
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
      // الـ Function ترمي Exception لو الـ Transaction مش موجودة أو مش PENDING
      throw new WalletError(error.message, "TRANSACTION_NOT_FOUND");
    }

    return tx;
  }
}

module.exports = { WalletService, WalletError };