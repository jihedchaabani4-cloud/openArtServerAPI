/**
 * System 3: Billing & Wallet — Typed Errors (Rule 8)
 *
 * Base error extends AppError from #shared following platform conventions.
 * Every error carries standard code, statusCode, category, and safe public messages.
 */
import { AppError } from "#shared";

export class BillingError extends AppError {
    constructor(code = "BILLING_ERROR", message = "Internal billing error", {
        type = "OPERATIONAL",
        category = "SERVER_FAULT",
        statusCode = 500,
        retryable = false,
        billingAction = "NONE",
        context = {},
    } = {}) {
        super(code, message, {
            type,
            category,
            statusCode,
            retryable,
            billingAction,
            context,
        });
        this.name = this.constructor.name;
    }
}

export class BillingValidationError extends BillingError {
    constructor(message, { context = {} } = {}) {
        super("BILLING_VALIDATION_ERROR", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 400,
            retryable: false,
            context,
        });
        this.name = "BillingValidationError";
        this.safeMessage = message;
    }
}

export class BillingNotFoundError extends BillingError {
    constructor(message = "Resource not found", { context = {} } = {}) {
        super("NOT_FOUND", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 404,
            retryable: false,
            context,
        });
        this.name = "BillingNotFoundError";
        this.safeMessage = "Resource not found";
    }
}

export class BillingInsufficientFundsError extends BillingError {
    constructor(required, available, { context = {} } = {}) {
        const message = `Insufficient credits: required ${required}, available ${available}`;
        super("INSUFFICIENT_FUNDS", message, {
            type: "OPERATIONAL",
            category: "BILLING_FAULT",
            statusCode: 402,
            retryable: false,
            context: { required, available, ...context },
        });
        this.name = "BillingInsufficientFundsError";
        this.required = required;
        this.available = available;
        this.safeMessage = "Insufficient credits for this generation";
    }
}

export class BillingConflictError extends BillingError {
    constructor(message = "Transaction state conflict", { context = {} } = {}) {
        super("CONFLICT", message, {
            type: "OPERATIONAL",
            category: "BILLING_FAULT",
            statusCode: 409,
            retryable: false,
            context,
        });
        this.name = "BillingConflictError";
        this.safeMessage = message;
    }
}

export class BillingConfigurationError extends BillingError {
    constructor(message = "Billing service is not configured", { context = {} } = {}) {
        super("BILLING_CONFIG_ERROR", message, {
            type: "OPERATIONAL",
            category: "SERVER_FAULT",
            statusCode: 500,
            retryable: false,
            context,
        });
        this.name = "BillingConfigurationError";
        this.safeMessage = "Billing service temporarily unavailable";
    }
}

/**
 * Backward compatibility class for legacy callers inspecting `err instanceof WalletError` or `err.code`
 */
export class WalletError extends BillingError {
    constructor(message, code = "BILLING_ERROR", options = {}) {
        const statusCode = code === "WALLET_NOT_FOUND" ? 404
            : code === "INSUFFICIENT_FUNDS" ? 402
            : (code === "DUPLICATE_TRANSACTION" || code === "INVALID_TRANSITION" || code === "CONFLICT") ? 409
            : code === "INVALID_METADATA" ? 400
            : 500;
        super(code, message, { statusCode, ...options });
        this.name = "WalletError";
        this.code = code;
    }
}

export default {
    BillingError,
    BillingValidationError,
    BillingNotFoundError,
    BillingInsufficientFundsError,
    BillingConflictError,
    BillingConfigurationError,
    WalletError,
};
