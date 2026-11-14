/**
 * System 3: Billing & Wallet — Public Tools Gateway (Rule 1, Rule 8)
 *
 * @description Exposes clean language-level async DTO operations for credit reservation,
 * holds, settlements, refunds, balances, and credit package resolution.
 */

import {
    BillingError,
    BillingValidationError,
    BillingNotFoundError,
    BillingInsufficientFundsError,
    BillingConflictError,
    BillingConfigurationError,
    WalletError,
} from "../internal/errors.js";

import {
    WalletRepository,
    TransactionRepository,
    CreditPackageRepository,
    FailedOpsRepository,
    UsageEventRepository,
    createBillingRepositories,
    getBillingSupabaseAdminClient,
} from "../internal/db/index.js";

import {
    WalletService,
    FailedOpsService,
    reconcileExpiredHolds,
    handleExpireStaleHolds,
    FAILED_OPS_BACKOFF_BASE_MS,
    FAILED_OPS_BACKOFF_MULTIPLIER,
    FAILED_OPS_DEFAULT_MAX_RETRIES,
} from "../internal/services/index.js";

import {
    configureBilling,
    getPricingService,
    getRedisConnection,
    getDefaultWalletService,
    getWalletService,
    getBillingService,
    getCreditPackageRepository,
    getFailedOpsService,
    getWalletRepository,
    getTransactionRepository,
    getUsageEventRepository,
    listCreditPackages,
    getCreditPackage,
    resolvePackageCredits,
} from "../internal/serviceAccessor.js";

export {
    configureBilling,
    getPricingService,
    getRedisConnection,
    getWalletService,
    getBillingService,
    getCreditPackageRepository,
    getFailedOpsService,
    getWalletRepository,
    getTransactionRepository,
    getUsageEventRepository,
    listCreditPackages,
    getCreditPackage,
    resolvePackageCredits,
};

function _resolveWalletService(ctx = {}) {
    const service = ctx?.walletService || getDefaultWalletService();
    if (!service) {
        throw new BillingConfigurationError("WalletService is not configured in Billing system");
    }
    return service;
}

// ── Pure DTO Tool Functions (Rule 8) ──────────────────────────────────────────

/**
 * Retrieves the credit balance for a user.
 *
 * @param {{ userId?: string }} [input]
 * @param {{ userId?: string, walletService?: any }} [ctx]
 * @returns {Promise<{ userId: string, balance: number }>}
 */
export async function getCreditBalance(input = {}, ctx = {}) {
    const userId = input?.userId || ctx?.userId;
    if (!userId || typeof userId !== "string") {
        throw new BillingValidationError("userId is required to fetch credit balance");
    }
    const service = _resolveWalletService(ctx);
    const balance = await service.getBalance(userId);
    return {
        userId,
        balance: Number(balance) || 0,
    };
}

/**
 * Places a two-phase credit reservation (hold) for a user.
 *
 * @param {{ userId?: string, amount: number, referenceId: string, metadata?: object }} input
 * @param {{ userId?: string, walletService?: any }} [ctx]
 * @returns {Promise<Object>} BillingReservationDto
 */
export async function reserveCredits(input, ctx = {}) {
    if (!input || typeof input !== "object") {
        throw new BillingValidationError("Input parameters are required for credit reservation");
    }

    const userId = input.userId || ctx?.userId;
    if (!userId || typeof userId !== "string") {
        throw new BillingValidationError("userId is required for credit reservation");
    }

    const amount = input.amount;
    if (typeof amount !== "number" || Number.isNaN(amount) || !Number.isFinite(amount) || amount < 0) {
        throw new BillingValidationError(`Invalid billing amount: ${amount}. Amount must be a finite, non-negative number.`);
    }

    const referenceId = input.referenceId;
    if (!referenceId || typeof referenceId !== "string") {
        throw new BillingValidationError("referenceId is required for credit reservation");
    }

    const service = _resolveWalletService(ctx);

    try {
        const result = await service.reserve({
            userId,
            amount,
            referenceId,
            metadata: input.metadata || {},
        });
        return result;
    } catch (err) {
        if (err.code === "INSUFFICIENT_FUNDS" || err.name === "InsufficientCreditsError") {
            const available = err.available ?? err.context?.available ?? 0;
            throw new BillingInsufficientFundsError(amount, available);
        }
        throw err;
    }
}

/**
 * Settles a reservation after successful completion (commits debit).
 *
 * @param {string|object} inputOrRef
 * @param {{ walletService?: any }} [ctx]
 * @returns {Promise<{ status: string, referenceId?: string }>}
 */
export async function settleCredits(inputOrRef, ctx = {}) {
    const service = _resolveWalletService(ctx);

    const target = (typeof inputOrRef === "string" || (inputOrRef && typeof inputOrRef === "object" && inputOrRef.kind))
        ? inputOrRef
        : (inputOrRef?.reservation || inputOrRef?.referenceId);

    const extraMetadata = (inputOrRef && typeof inputOrRef === "object") ? (inputOrRef.metadata || null) : null;

    if (!target) {
        throw new BillingValidationError("referenceId or reservation object is required to settle credits");
    }

    if (typeof service.settle === "function") {
        return service.settle(target, extraMetadata);
    }

    const refId = typeof target === "string" ? target : target.referenceId;
    return service.commitHoldIdempotent
        ? service.commitHoldIdempotent(refId, extraMetadata)
        : service.commit(refId, extraMetadata);
}

/**
 * Releases/refunds a reservation upon failure or cancellation.
 *
 * @param {string|object} inputOrRef
 * @param {{ walletService?: any }} [ctx]
 * @returns {Promise<{ status: string, referenceId?: string }>}
 */
export async function rollbackCredits(inputOrRef, ctx = {}) {
    const service = _resolveWalletService(ctx);

    const target = (typeof inputOrRef === "string" || (inputOrRef && typeof inputOrRef === "object" && inputOrRef.kind))
        ? inputOrRef
        : (inputOrRef?.reservation || inputOrRef?.referenceId);

    const extraMetadata = (inputOrRef && typeof inputOrRef === "object") ? (inputOrRef.metadata || null) : null;

    if (!target) {
        throw new BillingValidationError("referenceId or reservation object is required to rollback credits");
    }

    if (typeof service.release === "function") {
        return service.release(target, extraMetadata);
    }

    const refId = typeof target === "string" ? target : target.referenceId;
    return service.rollbackHoldIdempotent
        ? service.rollbackHoldIdempotent(refId, extraMetadata)
        : service.rollback(refId, extraMetadata);
}

/**
 * Adds credits directly to a user's wallet.
 *
 * @param {{ userId?: string, amount: number, referenceId: string, metadata?: object }} input
 * @param {{ userId?: string, walletService?: any }} [ctx]
 * @returns {Promise<Object>}
 */
export async function addCredits(input, ctx = {}) {
    if (!input || typeof input !== "object") {
        throw new BillingValidationError("Input parameters are required to add credits");
    }

    const userId = input.userId || ctx?.userId;
    if (!userId || typeof userId !== "string") {
        throw new BillingValidationError("userId is required to add credits");
    }

    const amount = input.amount;
    if (typeof amount !== "number" || Number.isNaN(amount) || !Number.isFinite(amount) || amount <= 0) {
        throw new BillingValidationError(`Invalid credit amount: ${amount}. Amount must be a positive number.`);
    }

    const referenceId = input.referenceId;
    if (!referenceId || typeof referenceId !== "string") {
        throw new BillingValidationError("referenceId is required to add credits");
    }

    const service = _resolveWalletService(ctx);
    return service.credit({
        userId,
        amount,
        referenceId,
        metadata: input.metadata || {},
    });
}

/**
 * Lists cursor-paginated transactions for a user.
 *
 * @param {{ userId?: string, limit?: number, before?: string, beforeId?: string }} [input]
 * @param {{ userId?: string, walletService?: any }} [ctx]
 * @returns {Promise<object>}
 */
export async function listTransactions(input = {}, ctx = {}) {
    const userId = input?.userId || ctx?.userId;
    if (!userId || typeof userId !== "string") {
        throw new BillingValidationError("userId is required to list transactions");
    }

    const limit = input?.limit ?? 20;
    const before = input?.before ?? null;
    const beforeId = input?.beforeId ?? null;

    const service = _resolveWalletService(ctx);
    return service.getTransactions(userId, limit, before, beforeId);
}

// ── Factories & Service Builders ──────────────────────────────────────────────

export function createWalletService(options = {}) {
    const activeClient = options.supabase || options.client || getBillingSupabaseAdminClient();
    const activeWalletRepo = options.walletRepo || (activeClient ? new WalletRepository(activeClient) : null);
    const activeTxRepo = options.transactionRepo || options.txRepo || (activeClient ? new TransactionRepository(activeClient) : null);
    const activeUsageRepo = options.usageEventRepo || (activeClient ? new UsageEventRepository(activeClient) : null);

    return new WalletService({
        walletRepo: activeWalletRepo,
        txRepo: activeTxRepo,
        usageEventRepo: activeUsageRepo,
        defaultInitialBalance: options.defaultInitialBalance,
        supabase: activeClient,
    });
}

export function createFailedOpsService(options = {}) {
    const activeClient = options.supabase || options.client || getBillingSupabaseAdminClient();
    const activeRepo = options.failedOpsRepo || (activeClient ? new FailedOpsRepository(activeClient) : null);
    return new FailedOpsService({ failedOpsRepo: activeRepo });
}

// ── Re-exports for Architecture & Compatibility ───────────────────────────────

export {
    // Services
    WalletService,
    FailedOpsService,
    reconcileExpiredHolds,
    handleExpireStaleHolds,
    FAILED_OPS_BACKOFF_BASE_MS,
    FAILED_OPS_BACKOFF_MULTIPLIER,
    FAILED_OPS_DEFAULT_MAX_RETRIES,

    // Repositories
    WalletRepository,
    TransactionRepository,
    CreditPackageRepository,
    FailedOpsRepository,
    UsageEventRepository,
    createBillingRepositories,

    // Typed Errors
    BillingError,
    BillingValidationError,
    BillingNotFoundError,
    BillingInsufficientFundsError,
    BillingConflictError,
    BillingConfigurationError,
    WalletError,
};

export default {
    getCreditBalance,
    reserveCredits,
    settleCredits,
    rollbackCredits,
    addCredits,
    listTransactions,
    listCreditPackages,
    getCreditPackage,
    resolvePackageCredits,
    configureBilling,
    getBillingService,
    getWalletService,
    getCreditPackageRepository,
    getFailedOpsService,
    getWalletRepository,
    createBillingRepositories,
    createWalletService,
    createFailedOpsService,
};
