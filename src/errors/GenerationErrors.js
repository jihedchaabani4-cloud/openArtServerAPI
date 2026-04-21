// ─────────────────────────────────────────
// errors/GenerationErrors.js
// ─────────────────────────────────────────

// ─── Error codes ───
export const ERROR_CODES = {
    // Step 1 — Safety
    PROMPT_VIOLATION:      "PROMPT_VIOLATION",

    // Step 2 — Enhance
    PROMPT_ENHANCE_FAILED: "PROMPT_ENHANCE_FAILED",

    // Step 3 — API Submit
    API_SUBMIT_FAILED:     "API_SUBMIT_FAILED",
    API_AUTH_FAILED:       "API_AUTH_FAILED",
    API_QUOTA_EXCEEDED:    "API_QUOTA_EXCEEDED",
    PROVIDER_CREDITS_EXCEEDED: "PROVIDER_CREDITS_EXCEEDED",

    // Step 4 — Poll
    GENERATION_TIMEOUT:    "GENERATION_TIMEOUT",
    GENERATION_FAILED:     "GENERATION_FAILED",

    // Step 5 — Upload
    UPLOAD_FAILED:         "UPLOAD_FAILED",

    // Step 6 — DB
    DB_ERROR:              "DB_ERROR",

    // Generic
    SERVER_ERROR:          "SERVER_ERROR",
    UNKNOWN_ERROR:         "UNKNOWN_ERROR",
}

// ─── Error class ───
export class GenerationError extends Error {
    constructor({ code, message, userMessage, status = 500, step = null, isInternal = false }) {
        super(message)
        this.code        = code
        this.status      = status
        this.step        = step
        this.isInternal  = isInternal  // true = details hidden from user
        this.userMessage = userMessage // message shown to user
    }

    getDisplayMessage() {
        if (this.isInternal) {
            return "sorry famam mouchkla 7awel a fuie momment";
        }
        return this.message;
    }
}

// ─── Error factories ───
export const Errors = {

    // ─── Step 1: Safety ───
    // isInternal: false — user must know why
    promptViolation: (reason) => new GenerationError({
        code:        ERROR_CODES.PROMPT_VIOLATION,
        message:     `Prompt violation: ${reason}`,
        userMessage: `Your prompt violates content policy: ${reason}`,
        status:      400,
        step:        "safety",
        isInternal:  false
    }),

    // ─── Step 2: Enhance ───
    // isInternal: true — LLM issue, not user's fault
    promptEnhanceFailed: (reason) => new GenerationError({
        code:        ERROR_CODES.PROMPT_ENHANCE_FAILED,
        message:     `Prompt enhance failed: ${reason}`,
        userMessage: "Failed to process your prompt. Please try again.",
        status:      500,
        step:        "enhance",
        isInternal:  true
    }),

    // ─── Step 3: Submit ───
    // isInternal: true — API keys / quota are internal details
    apiSubmitFailed: (reason) => new GenerationError({
        code:        ERROR_CODES.API_SUBMIT_FAILED,
        message:     `Provider API submit failed: ${reason}`,
        userMessage: "Generation failed. Please try again later.",
        status:      500,
        step:        "submit",
        isInternal:  true
    }),

    apiAuthFailed: () => new GenerationError({
        code:        ERROR_CODES.API_AUTH_FAILED,
        message:     "Provider API authentication failed. Check API key.",
        userMessage: "Generation failed. Please try again later.",
        status:      500,
        step:        "submit",
        isInternal:  true
    }),

    apiQuotaExceeded: () => new GenerationError({
        code:        ERROR_CODES.API_QUOTA_EXCEEDED,
        message:     "Provider API quota exceeded.",
        userMessage: "Generation failed. Please try again later.",
        status:      500,
        step:        "submit",
        isInternal:  true
    }),
    providerCreditsExceeded: (reason) => new GenerationError({
        code:        ERROR_CODES.PROVIDER_CREDITS_EXCEEDED,
        message:     `Provider out of credits: ${reason}`,
        userMessage: "Generation failed. Please try again later.",
        status:      500,
        step:        "submit",
        isInternal:  true
    }),

    // ─── Step 4: Poll ───
    // isInternal: true — provider-side issue
    generationTimeout: (taskId, attempts) => new GenerationError({
        code:        ERROR_CODES.GENERATION_TIMEOUT,
        message:     `Generation timed out: task ${taskId} after ${attempts} attempts.`,
        userMessage: "Generation took too long. Please try again.",
        status:      500,
        step:        "poll",
        isInternal:  true
    }),

    generationFailed: (reason, taskId) => new GenerationError({
        code:        ERROR_CODES.GENERATION_FAILED,
        message:     `Generation failed on provider: ${reason} (task: ${taskId})`,
        userMessage: "Generation failed. Please try again.",
        status:      500,
        step:        "poll",
        isInternal:  true
    }),

    // ─── Step 5: Upload ───
    // isInternal: true — storage issue
    uploadFailed: (fileName, reason) => new GenerationError({
        code:        ERROR_CODES.UPLOAD_FAILED,
        message:     `Storage upload failed: ${fileName} — ${reason}`,
        userMessage: "Failed to save your image. Please try again.",
        status:      500,
        step:        "upload",
        isInternal:  true
    }),

    // ─── Step 6: DB ───
    // isInternal: true — db issue
    dbError: (reason) => new GenerationError({
        code:        ERROR_CODES.DB_ERROR,
        message:     `Database error: ${reason}`,
        userMessage: "Something went wrong. Please try again.",
        status:      500,
        step:        "db",
        isInternal:  true
    }),

    // ─── Generic ───
    unknown: (reason) => new GenerationError({
        code:        ERROR_CODES.UNKNOWN_ERROR,
        message:     `Unknown error: ${reason}`,
        userMessage: "Something went wrong. Please try again.",
        status:      500,
        step:        null,
        isInternal:  true
    }),
}

// ─── Parse raw provider error → GenerationError ───
// Used when provider throws a generic Error (not GenerationError)
export function parseProviderError(err) {
    const msg = err?.message || ""

    if (msg.includes("401") || msg.toLowerCase().includes("unauthorized"))
        return Errors.apiAuthFailed()

    if (msg.includes("429") || msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("rate limit"))
        return Errors.apiQuotaExceeded()

    if (msg.toLowerCase().includes("insufficient credits") || msg.toLowerCase().includes("top up") || msg.toLowerCase().includes("balance too low"))
        return Errors.providerCreditsExceeded(msg)

    if (msg.toLowerCase().includes("timeout"))
        return Errors.generationTimeout(null, 0)

    if (msg.toLowerCase().includes("failed"))
        return Errors.generationFailed(msg, null)

    return Errors.apiSubmitFailed(msg)
}
