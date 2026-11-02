/**
 * Billing Business System Entry Point (Rule 3, Rule 4)
 *
 * Exposes the canonical public capabilities, typed errors, and container exports
 * for credit management, two-phase holds, settlements, and credit packages.
 */

import {
    BillingError,
    BillingValidationError,
    BillingNotFoundError,
    BillingInsufficientFundsError,
    BillingConflictError,
    BillingConfigurationError,
    WalletError,
} from "./BillingErrors.js";

export {
    BillingError,
    BillingValidationError,
    BillingNotFoundError,
    BillingInsufficientFundsError,
    BillingConflictError,
    BillingConfigurationError,
    WalletError,
};

export { WalletService } from "./WalletService.js";
export { PricingService } from "./PricingService.js";
export { FailedOpsService } from "./FailedOpsService.js";
export { UsageEventRepository } from "./UsageEventRepository.js";

let _defaultWalletService = null;
let _defaultPackageFetcher = null;

/**
 * Configures the Billing system's shared service instances.
 * Called at boot time by container.js or in test suites.
 *
 * @param {Object} params
 * @param {any} [params.walletService]
 * @param {Function} [params.packageFetcher]
 */
export function configureBilling({ walletService = null, packageFetcher = null } = {}) {
    if (walletService) _defaultWalletService = walletService;
    if (packageFetcher) _defaultPackageFetcher = packageFetcher;
}

/**
 * Returns the currently configured default WalletService instance.
 * @returns {any}
 */
export function getBillingService() {
    return _defaultWalletService;
}

function _resolveWalletService(ctx = {}) {
    const service = ctx?.walletService || _defaultWalletService;
    if (!service) {
        throw new BillingConfigurationError("WalletService is not configured in Billing system");
    }
    return service;
}

/**
 * @typedef {{ userId?: string }} GetCreditBalanceInput
 * @typedef {{ userId: string, balance: number }} CreditBalanceDto
 *
 * @param {GetCreditBalanceInput} [input]
 * @param {{ userId?: string, walletService?: any }} [ctx]
 * @returns {Promise<CreditBalanceDto>}
 * @throws {BillingValidationError | BillingConfigurationError | BillingError}
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
 * @typedef {{ userId?: string, amount: number, referenceId: string, metadata?: object }} ReserveCreditsInput
 * @typedef {{ kind: 'NO_CHARGE' | 'CHARGEABLE', status: 'ACTIVE' | 'HELD', referenceId: string, amount: number, transaction?: object }} BillingReservationDto
 *
 * @param {ReserveCreditsInput} input
 * @param {{ userId?: string, walletService?: any }} [ctx]
 * @returns {Promise<BillingReservationDto>}
 * @throws {BillingValidationError | BillingInsufficientFundsError | BillingConfigurationError | BillingError}
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
 * @typedef {{ referenceId?: string, reservation?: object, metadata?: object }} SettleCreditsInput
 * @typedef {{ status: string, referenceId?: string }} BillingSettlementDto
 *
 * @param {SettleCreditsInput|string|object} inputOrRef
 * @param {{ walletService?: any }} [ctx]
 * @returns {Promise<BillingSettlementDto>}
 * @throws {BillingValidationError | BillingConfigurationError | BillingError}
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
 * @typedef {{ referenceId?: string, reservation?: object, metadata?: object }} RollbackCreditsInput
 * @typedef {{ status: string, referenceId?: string }} BillingRollbackDto
 *
 * @param {RollbackCreditsInput|string|object} inputOrRef
 * @param {{ walletService?: any }} [ctx]
 * @returns {Promise<BillingRollbackDto>}
 * @throws {BillingValidationError | BillingConfigurationError | BillingError}
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
 * @typedef {{ userId?: string, amount: number, referenceId: string, metadata?: object }} AddCreditsInput
 * @typedef {{ id: string, userId: string, amount: number, balance: number }} CreditResultDto
 *
 * @param {AddCreditsInput} input
 * @param {{ userId?: string, walletService?: any }} [ctx]
 * @returns {Promise<CreditResultDto>}
 * @throws {BillingValidationError | BillingConfigurationError | BillingError}
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
 * @typedef {{ userId?: string, limit?: number, before?: string, beforeId?: string }} ListTransactionsInput
 *
 * @param {ListTransactionsInput} [input]
 * @param {{ userId?: string, walletService?: any }} [ctx]
 * @returns {Promise<object>}
 * @throws {BillingValidationError | BillingConfigurationError | BillingError}
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

/**
 * Lists available credit packages.
 *
 * @param {object} [options]
 * @param {{ packageFetcher?: Function }} [ctx]
 * @returns {Promise<Array>}
 */
export async function listCreditPackages(options = {}, ctx = {}) {
    if (typeof ctx?.packageFetcher === "function") {
        return ctx.packageFetcher(options);
    }
    if (typeof _defaultPackageFetcher === "function") {
        return _defaultPackageFetcher(options);
    }
    const { fetchPackagesFromDB } = await import("../../../controllers/payments/paymentsUtils.js");
    return fetchPackagesFromDB();
}
