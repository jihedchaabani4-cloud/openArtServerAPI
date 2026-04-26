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

  constructor(supabaseUrl, supabaseServiceKey) {
    this.supabase = createClient(supabaseUrl, supabaseServiceKey);
    this.defaultInitialBalance = Number(
      process.env.INITIAL_WALLET_BALANCE ||
      process.env.DEFAULT_WALLET_BALANCE ||
      100
    );
  }

  async createWallet(userId, initialBalance = this.defaultInitialBalance) {
    const { data: existingWallet, error: existingWalletError } = await this.supabase
      .from("wallets")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (existingWalletError) {
      throw new WalletError(existingWalletError.message, "DB_ERROR");
    }

    if (existingWallet) {
      console.log(`[WalletService] Wallet already exists for user ${userId} with balance ${existingWallet.balance}.`);
      return existingWallet;
    }

    const { data, error } = await this.supabase
      .from("wallets")
      .insert({ user_id: userId, balance: initialBalance })
      .select("*")
      .single();

    if (error) {
      throw new WalletError(error.message, "DB_ERROR");
    }

    console.log(`[WalletService] Wallet ensured for user ${userId} with balance ${initialBalance}.`);

    return data;
  }

  async ensureWallet(userId, initialBalance = this.defaultInitialBalance) {
    return this.createWallet(userId, initialBalance);
  }

  async hold({ userId, amount, referenceId, metadata = {} }) {
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
        return this.holdFallback({
          wallet,
          amount,
          referenceId,
          metadata,
          expiresAt,
        });
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

  async rollback(referenceId) {
    return this.resolveTransaction(referenceId, "FAILED");
  }

  async credit({ userId, amount, referenceId, metadata = {} }) {
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

  async getBalance(userId) {
    const wallet = await this.getWalletOrThrow(userId);
    return wallet.balance;
  }

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

  async getWalletOrThrow(userId) {
    const { data, error } = await this.supabase
      .from("wallets")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (error || !data) {
      throw new WalletError(`Wallet not found for user ${userId}`, "WALLET_NOT_FOUND");
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

  async getTransactionByReferenceOrThrow(referenceId) {
    const { data, error } = await this.supabase
      .from("transactions")
      .select("*")
      .eq("reference_id", referenceId)
      .single();

    if (error || !data) {
      throw new WalletError(
        `Transaction not found for reference ${referenceId}`,
        "TRANSACTION_NOT_FOUND"
      );
    }

    return data;
  }

  async holdFallback({ wallet, amount, referenceId, metadata, expiresAt }) {
    const { data: existingTx } = await this.supabase
      .from("transactions")
      .select("*")
      .eq("reference_id", referenceId)
      .maybeSingle();

    if (existingTx) {
      throw new WalletError(
        `Transaction ${referenceId} already exists (duplicate)`,
        "DUPLICATE_TRANSACTION"
      );
    }

    const newBalance = Number(wallet.balance) - Number(amount);
    if (newBalance < 0) {
      throw new WalletError(
        `Insufficient funds: need ${amount}, have ${wallet.balance}`,
        "INSUFFICIENT_FUNDS"
      );
    }

    const { error: walletError } = await this.supabase
      .from("wallets")
      .update({ balance: newBalance })
      .eq("id", wallet.id);

    if (walletError) {
      throw new WalletError(walletError.message, "DB_ERROR");
    }

    const payload = {
      wallet_id: wallet.id,
      amount,
      type: "DEBIT",
      status: "PENDING",
      reference_id: referenceId,
      metadata,
      expires_at: expiresAt,
    };

    const { data: tx, error: txError } = await this.supabase
      .from("transactions")
      .insert(payload)
      .select("*")
      .single();

    if (txError) {
      await this.supabase
        .from("wallets")
        .update({ balance: wallet.balance })
        .eq("id", wallet.id);

      if (txError.code === "23505") {
        throw new WalletError(
          `Transaction ${referenceId} already exists (duplicate)`,
          "DUPLICATE_TRANSACTION"
        );
      }

      throw new WalletError(txError.message, "DB_ERROR");
    }

    return tx;
  }

  async creditFallback({ wallet, amount, referenceId, metadata }) {
    const { data: existingTx } = await this.supabase
      .from("transactions")
      .select("*")
      .eq("reference_id", referenceId)
      .maybeSingle();

    if (existingTx) {
      throw new WalletError(
        `Transaction ${referenceId} already exists (duplicate)`,
        "DUPLICATE_TRANSACTION"
      );
    }

    const newBalance = Number(wallet.balance) + Number(amount);
    const { error: walletError } = await this.supabase
      .from("wallets")
      .update({ balance: newBalance })
      .eq("id", wallet.id);

    if (walletError) {
      throw new WalletError(walletError.message, "DB_ERROR");
    }

    const { data: tx, error: txError } = await this.supabase
      .from("transactions")
      .insert({
        wallet_id: wallet.id,
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
      await this.supabase
        .from("wallets")
        .update({ balance: wallet.balance })
        .eq("id", wallet.id);

      if (txError.code === "23505") {
        throw new WalletError(
          `Transaction ${referenceId} already exists (duplicate)`,
          "DUPLICATE_TRANSACTION"
        );
      }

      throw new WalletError(txError.message, "DB_ERROR");
    }

    return tx;
  }

  async commitFallback(referenceId) {
    const tx = await this.getTransactionByReferenceOrThrow(referenceId);

    if (tx.status !== "PENDING") {
      throw new WalletError(
        `Transaction ${referenceId} is not pending`,
        "INVALID_TRANSITION"
      );
    }

    const { data, error } = await this.supabase
      .from("transactions")
      .update({ status: "COMPLETED" })
      .eq("id", tx.id)
      .select("*")
      .single();

    if (error) {
      throw new WalletError(error.message, "DB_ERROR");
    }

    return data;
  }

  async rollbackFallback(referenceId) {
    const tx = await this.getTransactionByReferenceOrThrow(referenceId);

    if (tx.status !== "PENDING") {
      throw new WalletError(
        `Transaction ${referenceId} is not pending`,
        "INVALID_TRANSITION"
      );
    }

    const wallet = await this.getWalletByIdOrThrow(tx.wallet_id);
    const refundedBalance = Number(wallet.balance) + Number(tx.amount);

    const { error: walletError } = await this.supabase
      .from("wallets")
      .update({ balance: refundedBalance })
      .eq("id", wallet.id);

    if (walletError) {
      throw new WalletError(walletError.message, "DB_ERROR");
    }

    const { data, error } = await this.supabase
      .from("transactions")
      .update({ status: "FAILED" })
      .eq("id", tx.id)
      .select("*")
      .single();

    if (error) {
      await this.supabase
        .from("wallets")
        .update({ balance: wallet.balance })
        .eq("id", wallet.id);

      throw new WalletError(error.message, "DB_ERROR");
    }

    return data;
  }

  async expireStaleHoldsFallback() {
    const now = new Date().toISOString();
    const { data: stale, error } = await this.supabase
      .from("transactions")
      .select("*")
      .eq("status", "PENDING")
      .lt("expires_at", now);

    if (error) {
      throw new WalletError(error.message, "DB_ERROR");
    }

    let expiredCount = 0;
    for (const tx of stale || []) {
      await this.rollbackFallback(tx.reference_id);
      expiredCount += 1;
    }

    return expiredCount;
  }

  async getWalletByIdOrThrow(walletId) {
    const { data, error } = await this.supabase
      .from("wallets")
      .select("*")
      .eq("id", walletId)
      .single();

    if (error || !data) {
      throw new WalletError(`Wallet not found for id ${walletId}`, "WALLET_NOT_FOUND");
    }

    return data;
  }
}
