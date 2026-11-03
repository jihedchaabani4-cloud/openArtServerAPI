/**
 * Identity Business System Typed Errors (Rule 8)
 *
 * Base error extends AppError following platform conventions.
 * Every error carries standard code, statusCode, category, and safe public messages.
 */
import { AppError } from "../../errors/AppError.js";

export class IdentityError extends AppError {
    constructor(code = "IDENTITY_ERROR", message = "Internal identity error", {
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

export class IdentityAuthenticationError extends IdentityError {
    constructor(message = "Authentication required", { context = {} } = {}) {
        super("UNAUTHORIZED", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 401,
            retryable: false,
            billingAction: "NONE",
            context,
        });
        this.name = "IdentityAuthenticationError";
        this.errorCode = "UNAUTHORIZED";
        this.safeMessage = message;
    }
}

export class IdentityForbiddenError extends IdentityError {
    constructor(message = "Access forbidden", { context = {} } = {}) {
        super("FORBIDDEN", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 403,
            retryable: false,
            billingAction: "NONE",
            context,
        });
        this.name = "IdentityForbiddenError";
        this.errorCode = "FORBIDDEN";
        this.safeMessage = message;
    }
}

export class IdentityNotFoundError extends IdentityError {
    constructor(message = "Resource not found", { context = {} } = {}) {
        super("NOT_FOUND", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 404,
            retryable: false,
            billingAction: "NONE",
            context,
        });
        this.name = "IdentityNotFoundError";
        this.errorCode = "NOT_FOUND";
        this.safeMessage = message;
    }
}

export class IdentityValidationError extends IdentityError {
    constructor(message, { context = {} } = {}) {
        super("IDENTITY_VALIDATION_ERROR", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 400,
            retryable: false,
            billingAction: "NONE",
            context,
        });
        this.name = "IdentityValidationError";
        this.errorCode = "VALIDATION_ERROR";
        this.safeMessage = message;
    }
}
