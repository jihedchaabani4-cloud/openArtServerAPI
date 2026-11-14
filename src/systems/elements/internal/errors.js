/**
 * System 7: Elements — Typed Errors (Rule 8)
 *
 * Base error extends AppError from #shared following platform conventions.
 * Every error carries standard code, statusCode, category, and safe public messages.
 */
import { AppError } from "#shared";

export class ElementsError extends AppError {
    constructor(code = "ELEMENTS_ERROR", message = "Internal elements error", {
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

export class ElementsValidationError extends ElementsError {
    constructor(message = "Invalid element parameters", { field = null, context = {} } = {}) {
        super("ELEMENTS_VALIDATION_ERROR", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 400,
            retryable: false,
            billingAction: "NONE",
            context: { field, ...context },
        });
        this.name = "ElementsValidationError";
        this.errorCode = "VALIDATION_ERROR";
        this.safeMessage = message;
        this.field = field;
    }
}

export class ElementsNotFoundError extends ElementsError {
    constructor(message = "Element not found", { elementId = null, context = {} } = {}) {
        super("ELEMENTS_NOT_FOUND", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 404,
            retryable: false,
            billingAction: "NONE",
            context: { elementId, ...context },
        });
        this.name = "ElementsNotFoundError";
        this.errorCode = "NOT_FOUND";
        this.safeMessage = message;
        this.elementId = elementId;
    }
}

export class ElementsConflictError extends ElementsError {
    constructor(message = "Element conflict or quota reached", { context = {} } = {}) {
        super("ELEMENTS_CONFLICT", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 409,
            retryable: false,
            billingAction: "NONE",
            context,
        });
        this.name = "ElementsConflictError";
        this.errorCode = "CONFLICT";
        this.safeMessage = message;
    }
}

export class ElementsUnauthorizedError extends ElementsError {
    constructor(message = "Unauthorized access to element", { elementId = null, userId = null, context = {} } = {}) {
        super("ELEMENTS_UNAUTHORIZED", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 403,
            retryable: false,
            billingAction: "NONE",
            context: { elementId, userId, ...context },
        });
        this.name = "ElementsUnauthorizedError";
        this.errorCode = "UNAUTHORIZED";
        this.safeMessage = "You do not have access to this element";
    }
}

export default {
    ElementsError,
    ElementsValidationError,
    ElementsNotFoundError,
    ElementsConflictError,
    ElementsUnauthorizedError,
};
