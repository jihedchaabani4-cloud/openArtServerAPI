/**
 * System 1: Generation & Workflows — Typed Errors (Rule 8)
 *
 * Base error extends AppError from #shared following platform conventions.
 * Standard code, statusCode, category, and safe public messages.
 */
import { AppError } from "#shared";

// ─── Error codes ─────────────────────────────────────────────────────────────
export const ERROR_CODES = {
    // Step 1 — Safety
    PROMPT_VIOLATION:          "PROMPT_VIOLATION",

    // Step 2 — Enhance
    PROMPT_ENHANCE_FAILED:     "PROMPT_ENHANCE_FAILED",

    // Step 3 — API Submit
    API_SUBMIT_FAILED:         "API_SUBMIT_FAILED",
    API_AUTH_FAILED:           "API_AUTH_FAILED",
    API_QUOTA_EXCEEDED:        "API_QUOTA_EXCEEDED",
    PROVIDER_CREDITS_EXCEEDED: "PROVIDER_CREDITS_EXCEEDED",

    // Step 4 — Poll
    GENERATION_TIMEOUT:        "GENERATION_TIMEOUT",
    GENERATION_FAILED:         "GENERATION_FAILED",

    // Step 5 — Upload
    UPLOAD_FAILED:             "UPLOAD_FAILED",

    // Step 6 — DB
    DB_ERROR:                  "DB_ERROR",

    // Generic
    SERVER_ERROR:              "SERVER_ERROR",
    UNKNOWN_ERROR:             "UNKNOWN_ERROR",
};

export class GenerationError extends AppError {
    constructor(codeOrMessage = "GENERATION_ERROR", messageOrOptions = "Internal generation error", opts = {}) {
        // Support legacy object constructor: new GenerationError({ code, message, userMessage, status, step, isInternal })
        if (typeof codeOrMessage === "object" && codeOrMessage !== null) {
            const {
                code = "GENERATION_ERROR",
                message = "Internal generation error",
                userMessage = null,
                status = 500,
                statusCode = status,
                step = null,
                isInternal = false,
                type = "OPERATIONAL",
                category = isInternal ? "SERVER_FAULT" : "USER_FAULT",
                retryable = false,
                billingAction = "NONE",
                context = {},
            } = codeOrMessage;

            super(code, message, {
                type,
                category,
                statusCode,
                retryable,
                billingAction,
                context,
            });
            this.name = this.constructor.name;
            this.code = code;
            this.errorCode = code;
            this.status = status;
            this.statusCode = statusCode;
            this.step = step;
            this.isInternal = isInternal;
            this.userMessage = userMessage;
            return;
        }

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

    getDisplayMessage() {
        if (this.isInternal) {
            return "sorry famam mouchkla 7awel a fuie momment";
        }
        return this.message;
    }
}

// ─── Error factories ─────────────────────────────────────────────────────────
export const Errors = {
    promptViolation: (reason) => new GenerationError({
        code:        ERROR_CODES.PROMPT_VIOLATION,
        message:     `Prompt violation: ${reason}`,
        userMessage: `Your prompt violates content policy: ${reason}`,
        status:      400,
        step:        "safety",
        isInternal:  false,
    }),

    promptEnhanceFailed: (reason) => new GenerationError({
        code:        ERROR_CODES.PROMPT_ENHANCE_FAILED,
        message:     `Prompt enhance failed: ${reason}`,
        userMessage: "Failed to process your prompt. Please try again.",
        status:      500,
        step:        "enhance",
        isInternal:  true,
    }),

    apiSubmitFailed: (reason) => new GenerationError({
        code:        ERROR_CODES.API_SUBMIT_FAILED,
        message:     `Provider API submit failed: ${reason}`,
        userMessage: "Generation failed. Please try again later.",
        status:      500,
        step:        "submit",
        isInternal:  true,
    }),

    apiAuthFailed: () => new GenerationError({
        code:        ERROR_CODES.API_AUTH_FAILED,
        message:     "Provider API authentication failed. Check API key.",
        userMessage: "Generation failed. Please try again later.",
        status:      500,
        step:        "submit",
        isInternal:  true,
    }),

    apiQuotaExceeded: () => new GenerationError({
        code:        ERROR_CODES.API_QUOTA_EXCEEDED,
        message:     "Provider API quota exceeded.",
        userMessage: "Generation failed. Please try again later.",
        status:      500,
        step:        "submit",
        isInternal:  true,
    }),

    providerCreditsExceeded: (reason) => new GenerationError({
        code:        ERROR_CODES.PROVIDER_CREDITS_EXCEEDED,
        message:     `Provider out of credits: ${reason}`,
        userMessage: "Generation failed. Please try again later.",
        status:      500,
        step:        "submit",
        isInternal:  true,
    }),

    generationTimeout: (taskId, attempts) => new GenerationError({
        code:        ERROR_CODES.GENERATION_TIMEOUT,
        message:     `Generation timed out: task ${taskId} after ${attempts} attempts.`,
        userMessage: "Generation took too long. Please try again.",
        status:      500,
        step:        "poll",
        isInternal:  true,
    }),

    generationFailed: (reason, taskId) => new GenerationError({
        code:        ERROR_CODES.GENERATION_FAILED,
        message:     `Generation failed on provider: ${reason} (task: ${taskId})`,
        userMessage: "Generation failed. Please try again.",
        status:      500,
        step:        "poll",
        isInternal:  true,
    }),

    uploadFailed: (fileName, reason) => new GenerationError({
        code:        ERROR_CODES.UPLOAD_FAILED,
        message:     `Storage upload failed: ${fileName} — ${reason}`,
        userMessage: "Failed to save your image. Please try again.",
        status:      500,
        step:        "upload",
        isInternal:  true,
    }),

    dbError: (reason) => new GenerationError({
        code:        ERROR_CODES.DB_ERROR,
        message:     `Database error: ${reason}`,
        userMessage: "Something went wrong. Please try again.",
        status:      500,
        step:        "db",
        isInternal:  true,
    }),

    unknown: (reason) => new GenerationError({
        code:        ERROR_CODES.UNKNOWN_ERROR,
        message:     `Unknown error: ${reason}`,
        userMessage: "Something went wrong. Please try again.",
        status:      500,
        step:        null,
        isInternal:  true,
    }),
};

export function parseProviderError(err) {
    const msg = err?.message || "";

    if (msg.includes("401") || msg.toLowerCase().includes("unauthorized"))
        return Errors.apiAuthFailed();

    if (msg.includes("429") || msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("rate limit"))
        return Errors.apiQuotaExceeded();

    if (msg.toLowerCase().includes("insufficient credits") || msg.toLowerCase().includes("top up") || msg.toLowerCase().includes("balance too low"))
        return Errors.providerCreditsExceeded(msg);

    if (msg.toLowerCase().includes("timeout"))
        return Errors.generationTimeout(null, 0);

    if (msg.toLowerCase().includes("failed"))
        return Errors.generationFailed(msg, null);

    return Errors.apiSubmitFailed(msg);
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
    ERROR_CODES,
    GenerationError,
    Errors,
    parseProviderError,
    GenerationValidationError,
    GenerationNotFoundError,
    GenerationCompilationError,
    GenerationQueueDispatchError,
};
