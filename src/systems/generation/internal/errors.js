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
        this.code = code;
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

export class GenerationUpstreamError extends GenerationError {
    constructor(message = "Upstream provider error", { code = "GENERATION_UPSTREAM_ERROR", category = "UPSTREAM_FAULT", statusCode = 502, retryable = true, context = {} } = {}) {
        super(code, message, {
            type: "OPERATIONAL",
            category,
            statusCode,
            retryable,
            billingAction: "REFUND_HOLD",
            context,
        });
        this.name = "GenerationUpstreamError";
        this.errorCode = code;
    }
}

export class GenerationSafetyError extends GenerationValidationError {
    constructor(message = "Prompt violates content safety policy", { field = "prompt", context = {} } = {}) {
        super(message, {
            field,
            context: { is_safe: false, safety_reason: message, ...context },
        });
        this.name = "GenerationSafetyError";
        this.code = "CONTENT_SAFETY_VIOLATION";
        this.errorCode = "CONTENT_SAFETY_VIOLATION";
        this.category = "USER_FAULT";
        this.safetyCategory = "CONTENT_SAFETY_VIOLATION";
        this.statusCode = 422;
        this.status = 422;
        this.retryable = false;
        this.is_safe = false;
        this.safeMessage = message;
        this.userMessage = message;
    }
}

export class GenerationHoldExpiredError extends GenerationError {
    constructor(message = "Cannot complete media because its credit hold has expired", { mediaId = null, context = {} } = {}) {
        super("HOLD_EXPIRED", message, {
            type: "OPERATIONAL",
            category: "HOLD_EXPIRED",
            statusCode: 409,
            retryable: false,
            billingAction: "NONE",
            context: { mediaId, ...context },
        });
        this.name = "GenerationHoldExpiredError";
        this.code = "HOLD_EXPIRED";
        this.errorCode = "HOLD_EXPIRED";
        this.category = "HOLD_EXPIRED";
        this.statusCode = 409;
        this.status = 409;
        this.retryable = false;
        this.isInternal = false;
        this.mediaId = mediaId;
    }
}

const INTERNAL_LEAK_REGEX =
    /\b(wavespeed|ltx|google|gemini|vertex|openai|anthropic|replicate|fal\.ai|supabase|postgrest|pg_|postgres|redis|bullmq|ioredis)\b/gi;
const URL_LEAK_REGEX = /https?:\/\/[^\s"'<>]+/gi;
const SQL_LEAK_REGEX = /\b(SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|relation\s+"[^"]+"\s+does\s+not\s+exist|syntax\s+error\s+at\s+or\s+near)\b/gi;
const STACK_TRACE_REGEX = /\n\s*at\s+[^\n]+/g;

function scrubSensitiveText(text, fallback = "Generation failed. Please try again.") {
    if (!text || typeof text !== "string") return fallback;
    let cleaned = text.replace(STACK_TRACE_REGEX, "").trim();
    if (SQL_LEAK_REGEX.test(cleaned)) {
        SQL_LEAK_REGEX.lastIndex = 0;
        return fallback;
    }
    cleaned = cleaned.replace(URL_LEAK_REGEX, "[redacted-url]");
    cleaned = cleaned.replace(INTERNAL_LEAK_REGEX, "provider");
    cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
    return cleaned || fallback;
}

/**
 * Classifies and sanitizes any error into one of the 4 canonical V3 error categories:
 *   1. USER_FAULT (400/403/404 — input or ownership errors; never retried)
 *   2. CONTENT_SAFETY_VIOLATION (422 — LLM or provider safety rejection; never retried)
 *   3. UPSTREAM_FAULT / RATE_LIMIT (502/503/429 — transient provider failures; retryable)
 *   4. HOLD_EXPIRED / SERVER_FAULT (409/500 — expired hold or internal fault; never retried)
 *
 * Ensures no stack trace, SQL detail, internal URL, or internal provider name leaks to client/DB.
 */
export function sanitizeClientError(err) {
    const rawCode = String(err?.code || err?.errorCode || "").trim();
    const rawMsg = typeof err?.message === "string" ? err.message : String(err || "");
    const rawCategory = String(err?.category || "").toUpperCase();
    const rawStatus = Number(err?.statusCode || err?.status || 0);

    // 0. SAFETY_CHECK_UNAVAILABLE (429 / 502 / 503 — transient safety provider fault; fail-closed, NOT user policy violation)
    if (rawCode === "SAFETY_CHECK_UNAVAILABLE") {
        const isRateLimit = rawCategory === "RATE_LIMIT" || rawStatus === 429;
        const category = isRateLimit ? "RATE_LIMIT" : "UPSTREAM_FAULT";
        const statusCode = isRateLimit ? 429 : rawStatus === 503 ? 503 : 502;
        const userMessage = isRateLimit
            ? "Safety check service is temporarily busy. Please try again in a moment."
            : "Safety check service is temporarily unavailable. Your credits have been refunded. Please try again shortly.";
        return {
            code: "SAFETY_CHECK_UNAVAILABLE",
            category,
            statusCode,
            retryable: err?.retryable !== undefined ? Boolean(err.retryable) : true,
            message: userMessage,
            userMessage,
        };
    }

    // 0b. SAFETY_CHECK_FAILED (422 — static user-safe message; never leak internal route/model keys)
    if (rawCode === "SAFETY_CHECK_FAILED") {
        const staticMsg = "Unable to verify prompt safety. Please revise your prompt and try again.";
        return {
            code: "SAFETY_CHECK_FAILED",
            category: "CONTENT_SAFETY_VIOLATION",
            statusCode: 422,
            retryable: false,
            message: staticMsg,
            userMessage: staticMsg,
        };
    }

    // 1. CONTENT_SAFETY_VIOLATION (422)
    if (
        rawCode === "CONTENT_SAFETY_VIOLATION" ||
        rawCode === "PROMPT_VIOLATION" ||
        rawCode === "PROVIDER_CONTENT_POLICY_ERROR" ||
        rawCategory === "CONTENT_SAFETY_VIOLATION" ||
        err?.is_safe === false ||
        /content safety|content policy|safety violation|nsfw/i.test(rawMsg)
    ) {
        const cleanReason = scrubSensitiveText(
            err?.userMessage || err?.safeMessage || rawMsg,
            "Your prompt violates our content safety policy."
        );
        return {
            code: "CONTENT_SAFETY_VIOLATION",
            category: "CONTENT_SAFETY_VIOLATION",
            statusCode: 422,
            retryable: false,
            message: cleanReason,
            userMessage: cleanReason,
        };
    }

    // 2. HOLD_EXPIRED (409)
    if (rawCode === "HOLD_EXPIRED" || rawCategory === "HOLD_EXPIRED" || rawStatus === 409) {
        const msg = "Generation session expired before completion. Your credits have been refunded.";
        return {
            code: "HOLD_EXPIRED",
            category: "HOLD_EXPIRED",
            statusCode: 409,
            retryable: false,
            message: msg,
            userMessage: msg,
        };
    }

    // 3. USER_FAULT (400 / 403 / 404)
    if (
        rawCategory === "USER_FAULT" ||
        rawStatus === 400 ||
        rawStatus === 403 ||
        rawStatus === 404 ||
        rawCode === "GENERATION_VALIDATION_ERROR" ||
        rawCode === "GENERATION_NOT_FOUND" ||
        rawCode === "USE_CASE_NOT_FOUND" ||
        rawCode === "FORBIDDEN" ||
        rawCode === "OWNERSHIP_VERIFICATION_FAILED" ||
        rawCode === "TARGET_VERIFICATION_FAILED"
    ) {
        const statusCode = rawStatus === 403 || rawStatus === 404 ? rawStatus : 400;
        const cleanMsg = scrubSensitiveText(
            err?.userMessage || err?.safeMessage || rawMsg,
            "Invalid request parameters."
        );
        return {
            code: rawCode || "GENERATION_VALIDATION_ERROR",
            category: "USER_FAULT",
            statusCode,
            retryable: false,
            message: cleanMsg,
            userMessage: cleanMsg,
        };
    }

    // 4. UPSTREAM_FAULT / RATE_LIMIT (429 / 502 / 503)
    if (
        rawCode === "PROVIDER_QUOTA_EXCEEDED" ||
        rawCode === "CIRCUIT_BREAKER_OPEN" ||
        rawCategory === "UPSTREAM_FAULT" ||
        rawCategory === "RATE_LIMIT" ||
        rawStatus === 429 ||
        rawStatus === 502 ||
        rawStatus === 503 ||
        /rate limit|quota|timeout|timed out|upstream/i.test(rawCode) ||
        /rate limit|quota|timed out/i.test(rawMsg)
    ) {
        const isProviderQuota = rawCode === "PROVIDER_QUOTA_EXCEEDED";
        const isRateLimit =
            !isProviderQuota &&
            (rawCategory === "RATE_LIMIT" || rawStatus === 429 || /rate limit|quota/i.test(rawCode));
        const category = isRateLimit ? "RATE_LIMIT" : "UPSTREAM_FAULT";
        const statusCode = isProviderQuota
            ? 503
            : isRateLimit
              ? 429
              : rawStatus === 503 || rawCode === "CIRCUIT_BREAKER_OPEN"
                ? 503
                : 502;
        const userMessage = isProviderQuota
            ? "This model is temporarily unavailable due to upstream provider maintenance. Your credits have been refunded. Please select a different model."
            : isRateLimit
              ? "Generation service is currently busy. Please try again in a moment."
              : "Generation failed due to a temporary service issue. Your credits have been refunded.";
        return {
            code: rawCode || (isRateLimit ? "RATE_LIMIT_EXCEEDED" : "GENERATION_UPSTREAM_ERROR"),
            category,
            statusCode,
            retryable: isProviderQuota || rawCode === "CIRCUIT_BREAKER_OPEN"
                ? false
                : err?.retryable !== undefined
                  ? Boolean(err.retryable)
                  : true,
            message: userMessage,
            userMessage,
        };
    }

    // 5. SERVER_FAULT (500 — default fail-closed internal category)
    const fallbackMessage = "Generation failed due to an unexpected internal error. Your credits have been refunded.";
    return {
        code: rawCode || "SERVER_ERROR",
        category: "SERVER_FAULT",
        statusCode: 500,
        retryable: false,
        message: fallbackMessage,
        userMessage: fallbackMessage,
    };
}

export class CompilationError extends Error {
    constructor(rule, message, details = {}) {
        super(message);
        this.name = "CompilationError";
        this.rule = rule;
        this.details = details;
    }

    toJSON() {
        return { rule: this.rule, message: this.message, details: this.details };
    }
}

export function throwCompilationErrors(errors) {
    if (errors.length > 0) {
        const err = new Error(`Workflow compilation failed with ${errors.length} error(s).`);
        err.name = "CompilationFailed";
        err.errors = errors.map((e) => e.toJSON());
        throw err;
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
    GenerationUpstreamError,
    GenerationSafetyError,
    GenerationHoldExpiredError,
    sanitizeClientError,
    CompilationError,
    throwCompilationErrors,
};
