/**
 * System 3: Billing & Wallet — Public Tools Gateway (Rule 1, Rule 8)
 *
 * @description Sealed surface exposing ONLY pure async DTO billing operations,
 * composition-root wiring, worker/reaper entrypoints, and typed Billing errors.
 * Zero repositories, zero internal service classes, zero worker internals.
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

import { createDefaultBillingRepositories } from "../internal/db/billingRepositoryFactory.js";
import { WalletService } from "../internal/services/WalletService.js";
import { FailedOpsService } from "../internal/services/FailedOpsService.js";
import { runReservationReaper } from "../internal/services/ReservationReaperService.js";
import { startWalletWorker, stopWalletWorker } from "../internal/workers/walletWorker.js";
import {
    configureBilling,
    getDefaultWalletService,
    listCreditPackages,
} from "../internal/services/serviceAccessor.js";

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

function _normalizeHoldTarget(inputOrRef) {
    if (typeof inputOrRef === "string") {
        const trimmed = inputOrRef.trim();
        if (!trimmed) return null;
        return {
            referenceId: trimmed,
            reservation: { referenceId: trimmed },
            extraMetadata: null,
        };
    }

    if (!inputOrRef || typeof inputOrRef !== "object") {
        return null;
    }

    const extraMetadata = inputOrRef.metadata && typeof inputOrRef.metadata === "object"
        ? inputOrRef.metadata
        : null;

    if (inputOrRef.reservation) {
        if (typeof inputOrRef.reservation === "string") {
            const trimmed = inputOrRef.reservation.trim();
            if (!trimmed) return null;
            return {
                referenceId: trimmed,
                reservation: { referenceId: trimmed },
                extraMetadata,
            };
        }
        if (typeof inputOrRef.reservation === "object") {
            const refId = inputOrRef.reservation.referenceId || inputOrRef.reservation.reservationId;
            if (!refId || typeof refId !== "string" || !refId.trim()) return null;
            const trimmed = refId.trim();
            return {
                referenceId: trimmed,
                reservation: { ...inputOrRef.reservation, referenceId: trimmed },
                extraMetadata,
            };
        }
    }

    const refId = inputOrRef.referenceId || inputOrRef.reservationId;
    if (!refId || typeof refId !== "string" || !refId.trim()) {
        return null;
    }
    const trimmed = refId.trim();
    return {
        referenceId: trimmed,
        reservation: { ...inputOrRef, referenceId: trimmed },
        extraMetadata,
    };
}

/**
 * Settles a reservation after successful completion (commits debit).
 *
 * @param {string|object} inputOrRef
 * @param {{ walletService?: any }} [ctx]
 * @returns {Promise<{ settled: boolean, referenceId: string, status?: string }>}
 */
export async function settleCredits(inputOrRef, ctx = {}) {
    const service = _resolveWalletService(ctx);
    const normalized = _normalizeHoldTarget(inputOrRef);

    if (!normalized) {
        throw new BillingValidationError("referenceId or reservation object is required to settle credits");
    }

    const { referenceId, reservation, extraMetadata } = normalized;
    let result;

    if (typeof service.settle === "function") {
        result = await service.settle(reservation, extraMetadata);
    } else if (typeof service.commitHoldIdempotent === "function") {
        result = await service.commitHoldIdempotent(referenceId, extraMetadata);
    } else if (typeof service.commit === "function") {
        result = await service.commit(referenceId, extraMetadata || undefined);
    } else {
        throw new BillingConfigurationError("WalletService does not implement settle or commit");
    }

    return {
        ...(result && typeof result === "object" ? result : {}),
        settled: true,
        referenceId: result?.referenceId || referenceId,
    };
}

/**
 * Releases/refunds a reservation upon failure or cancellation.
 *
 * @param {string|object} inputOrRef
 * @param {{ walletService?: any }} [ctx]
 * @returns {Promise<{ rolledBack: boolean, referenceId: string, status?: string }>}
 */
export async function rollbackCredits(inputOrRef, ctx = {}) {
    const service = _resolveWalletService(ctx);
    const normalized = _normalizeHoldTarget(inputOrRef);

    if (!normalized) {
        throw new BillingValidationError("referenceId or reservation object is required to rollback credits");
    }

    const { referenceId, reservation, extraMetadata } = normalized;
    let result;

    if (typeof service.settle === "function" && typeof service.release === "function") {
        result = await service.release(reservation, extraMetadata);
    } else if (typeof service.rollbackHoldIdempotent === "function") {
        result = await service.rollbackHoldIdempotent(referenceId, extraMetadata);
    } else if (typeof service.rollback === "function") {
        result = await service.rollback(referenceId, extraMetadata || undefined);
    } else if (typeof service.release === "function") {
        result = await service.release(reservation, extraMetadata);
    } else {
        throw new BillingConfigurationError("WalletService does not implement release or rollback");
    }

    return {
        ...(result && typeof result === "object" ? result : {}),
        rolledBack: true,
        referenceId: result?.referenceId || referenceId,
    };
}

/**
 * Extends the TTL of an active reservation (hold heartbeat).
 *
 * @param {string|object} inputOrRef
 * @param {number|object} [ttlSecondsOrCtx=300]
 * @param {{ walletService?: any }} [ctx]
 * @returns {Promise<Object|null>}
 */
export async function extendHold(inputOrRef, ttlSecondsOrCtx = 300, ctx = {}) {
    const resolvedCtx = (typeof ttlSecondsOrCtx === "object" && ttlSecondsOrCtx !== null) ? ttlSecondsOrCtx : ctx;
    const holdId = typeof inputOrRef === "string"
        ? inputOrRef
        : (inputOrRef?.holdId || inputOrRef?.referenceId || inputOrRef?.reservation?.referenceId);
    const ttlSeconds = typeof ttlSecondsOrCtx === "number"
        ? ttlSecondsOrCtx
        : (inputOrRef?.ttlSeconds ?? inputOrRef?.additionalSeconds ?? 300);

    if (!holdId || typeof holdId !== "string" || !holdId.trim()) {
        throw new BillingValidationError("holdId / referenceId is required to extend hold");
    }

    const service = _resolveWalletService(resolvedCtx);
    return service.extendHold(holdId, Number(ttlSeconds) || 300);
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

// ── Composition-Root Service Builders ─────────────────────────────────────────

export function createWalletService(options = {}) {
    const repos = createDefaultBillingRepositories(options);
    return new WalletService({
        walletRepo: options.walletRepo || repos?.walletRepo || null,
        txRepo: options.transactionRepo || options.txRepo || repos?.txRepo || null,
        usageEventRepo: options.usageEventRepo || repos?.usageEventRepo || null,
        defaultInitialBalance: options.defaultInitialBalance,
        supabase: options.supabase || options.client || repos?.walletRepo?.supabase || null,
    });
}

export function createFailedOpsService(options = {}) {
    const repos = createDefaultBillingRepositories(options);
    const activeRepo = options.failedOpsRepo || repos?.failedOpsRepo || null;
    return new FailedOpsService({ failedOpsRepo: activeRepo });
}

// ── Sealed Public Surface Exports ─────────────────────────────────────────────

export {
    // Composition & Capability Exports
    configureBilling,
    listCreditPackages,

    // Worker & Reaper Lifecycle Entrypoints
    runReservationReaper,
    startWalletWorker,
    stopWalletWorker,

    // Typed Error Hierarchy
    BillingError,
    BillingValidationError,
    BillingNotFoundError,
    BillingInsufficientFundsError,
    BillingConflictError,
    BillingConfigurationError,
    WalletError,
};
