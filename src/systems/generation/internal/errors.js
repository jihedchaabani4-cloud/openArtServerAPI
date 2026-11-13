/**
 * System 1: Generation & Workflows — Typed Errors (Rule 8)
 *
 * Base error extends AppError from #shared following platform conventions.
 * Standard code, statusCode, category, and safe public messages.
 */
import { AppError } from "#shared";

export class GenerationError extends AppError {
    constructor(codeOrMessage = "GENERATION_ERROR", messageOrOptions = "Internal generation error", opts = {}) {
        let code = "GENERATION_ERROR";
        let message = "Internal generation error";
        let options = {};

        if (typeof messageOrOptions === "string") {
            code = codeOrMessage;
            message = messageOrOptions;
            options = opts || {};
        } else if (typeof messageOrOptions === "number") {
            message = codeOrMessage;
            options = { statusCode: messageOrOptions, ...(opts || {}) };
        } else if (typeof messageOrOptions === "object" && messageOrOptions !== null) {
            message = codeOrMessage;
            options = messageOrOptions;
        } else {
            message = codeOrMessage;
        }

        const statusCode = options.statusCode || 500;
        super(code, message, {
            type: options.type || "OPERATIONAL",
            category: options.category || "SERVER_FAULT",
            statusCode,
            retryable: options.retryable || false,
            billingAction: options.billingAction || "NONE",
            context: options.context || {},
        });
        this.name = this.constructor.name;
        this.errorCode = code;
    }
}

export class GenerationValidationError extends GenerationError {
    constructor(message = "Invalid generation parameters", { field = null, context = {} } = {}) {
        super("GENERATION_VALIDATION_ERROR", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 400,
            retryable: false,
            billingAction: "NONE",
            context: { field, ...context },
        });
        this.name = "GenerationValidationError";
        this.errorCode = "GENERATION_VALIDATION_ERROR";
        this.safeMessage = message;
        this.field = field;
    }
}

export class GenerationNotFoundError extends GenerationError {
    constructor(message = "Workflow or generation resource not found", { resourceId = null, context = {} } = {}) {
        super("GENERATION_NOT_FOUND", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 404,
            retryable: false,
            billingAction: "NONE",
            context: { resourceId, ...context },
        });
        this.name = "GenerationNotFoundError";
        this.errorCode = "GENERATION_NOT_FOUND";
        this.safeMessage = message;
        this.resourceId = resourceId;
    }
}

export class GenerationCompilationError extends GenerationError {
    constructor(message = "Workflow compilation failed", { errors = [], context = {} } = {}) {
        super("GENERATION_COMPILATION_FAILED", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 422,
            retryable: false,
            billingAction: "NONE",
            context: { errors, ...context },
        });
        this.name = "GenerationCompilationError";
        this.errorCode = "COMPILATION_FAILED";
        this.errors = errors;
    }
}

export class GenerationQueueDispatchError extends GenerationError {
    constructor(message = "Job dispatch failed", { attempts = 1, cause = null, context = {} } = {}) {
        super("QUEUE_DISPATCH_FAILED", message, {
            type: "OPERATIONAL",
            category: "SERVER_FAULT",
            statusCode: 503,
            retryable: true,
            billingAction: "REFUND_HOLD",
            context: { attempts, cause: cause?.message || String(cause), ...context },
        });
        this.name = "GenerationQueueDispatchError";
        this.errorCode = "QUEUE_DISPATCH_FAILED";
        this.attempts = attempts;
        this.cause = cause;
    }
}

export default {
    GenerationError,
    GenerationValidationError,
    GenerationNotFoundError,
    GenerationCompilationError,
    GenerationQueueDispatchError,
};
