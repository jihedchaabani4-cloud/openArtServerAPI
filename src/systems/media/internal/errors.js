/**
 * Media & Storage System Unified Error Hierarchy (Rule 9)
 */
import { AppError } from "#shared";

export class MediaError extends AppError {
    constructor(code, message, {
        statusCode = 500,
        category = "SERVER_FAULT",
        type = "OPERATIONAL",
        retryable = false,
        billingAction = "NONE",
        context = {},
    } = {}) {
        super(code, message, {
            statusCode,
            category,
            type,
            retryable,
            billingAction,
            context,
        });
        this.name = this.constructor.name;
    }
}

export class MediaValidationError extends MediaError {
    constructor(message, { context = {} } = {}) {
        super("MEDIA_VALIDATION_ERROR", message, {
            statusCode: 400,
            category: "USER_FAULT",
            type: "OPERATIONAL",
            retryable: false,
            billingAction: "NONE",
            context,
        });
        this.errorCode = "VALIDATION_ERROR";
        this.safeMessage = message;
    }
}

export class MediaNotFoundError extends MediaError {
    constructor(message = "Media not found", { context = {} } = {}) {
        super("NOT_FOUND", message, {
            statusCode: 404,
            category: "USER_FAULT",
            type: "OPERATIONAL",
            retryable: false,
            billingAction: "NONE",
            context,
        });
        this.errorCode = "NOT_FOUND";
        this.safeMessage = message;
    }
}

export class MediaStorageError extends MediaError {
    constructor(message, { context = {}, retryable = false } = {}) {
        super("MEDIA_STORAGE_ERROR", message, {
            statusCode: 502,
            category: "DOWNSTREAM_FAULT",
            type: "OPERATIONAL",
            retryable,
            billingAction: "NONE",
            context,
        });
        this.errorCode = "STORAGE_UPLOAD_ERROR";
        this.safeMessage = message;
    }
}

export class MediaUploadError extends MediaError {
    constructor(message, { statusCode = 502, code = "STORAGE_UPLOAD_ERROR", context = {} } = {}) {
        super(code, message, {
            statusCode,
            category: "DOWNSTREAM_FAULT",
            type: "OPERATIONAL",
            retryable: false,
            billingAction: "NONE",
            context,
        });
        this.errorCode = code;
        this.safeMessage = message;
    }
}

export class MediaQuotaError extends MediaError {
    constructor(message, { context = {} } = {}) {
        super("LIMIT_EXCEEDED", message, {
            statusCode: 400,
            category: "USER_FAULT",
            type: "OPERATIONAL",
            retryable: false,
            billingAction: "NONE",
            context,
        });
        this.errorCode = "LIMIT_EXCEEDED";
        this.safeMessage = message;
    }
}

// ── Storage Typed Errors (Rule 8) ────────────────────────────────────────────

export class StorageError extends AppError {
    constructor(code, message, {
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

export class StorageValidationError extends StorageError {
    constructor(message, { context = {} } = {}) {
        super("STORAGE_VALIDATION_ERROR", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 400,
            retryable: false,
            billingAction: "NONE",
            context,
        });
        this.name = "StorageValidationError";
        this.errorCode = "VALIDATION_ERROR";
        this.safeMessage = message;
    }
}

// ── Media Upload Ingestion Errors (ADR-0012) ─────────────────────────────────

class MediaUploadBaseError extends Error {
    constructor(name, message, { statusCode, code, ...fields } = {}) {
        super(message, fields.cause ? { cause: fields.cause } : undefined);
        this.name = name;
        this.statusCode = statusCode;
        this.code = code;
        this.errorCode = code;
        Object.assign(this, fields);
    }
}

export class ValidationError extends MediaUploadBaseError {
    constructor(message, { statusCode = 400, code = "VALIDATION_ERROR", ...fields } = {}) {
        super("ValidationError", message, { statusCode, code, ...fields });
    }
}

export class UploadError extends MediaUploadBaseError {
    constructor(message, { statusCode = 502, code = "STORAGE_UPLOAD_ERROR", ...fields } = {}) {
        super("UploadError", message, { statusCode, code, ...fields });
    }
}

export class QuotaError extends MediaUploadBaseError {
    constructor(message, { statusCode = 400, code = "LIMIT_EXCEEDED", ...fields } = {}) {
        super("QuotaError", message, { statusCode, code, ...fields });
    }
}

export const WORKFLOW_REFERENCE_QUOTA_PREFIX = "Maximum ";
export const WORKFLOW_REFERENCE_QUOTA_PATTERN = /Maximum\s+\d+\s+reference\s+images\s+allowed/i;

export function formatWorkflowReferenceQuotaMessage(maxAllowed, currentCount) {
    return `Maximum ${maxAllowed} reference images allowed per element. Current: ${currentCount}`;
}

export function isWorkflowReferenceQuotaError(err) {
    if (!err) return false;
    if (err.errorCode === "LIMIT_EXCEEDED" || err.code === "LIMIT_EXCEEDED") return true;
    if (err.hint === "workflow_media_quota_exceeded") return true;
    const msg = String(err.message || "");
    const stderr = String(err.stderr || "");
    if (msg.includes("workflow_media_quota_exceeded") || stderr.includes("workflow_media_quota_exceeded")) return true;
    if (msg.includes("workflow_media_role_check") || stderr.includes("workflow_media_role_check")) return false;
    if (err.code === "23514" || msg.includes("23514") || WORKFLOW_REFERENCE_QUOTA_PATTERN.test(msg)) {
        return WORKFLOW_REFERENCE_QUOTA_PATTERN.test(msg) || WORKFLOW_REFERENCE_QUOTA_PATTERN.test(stderr);
    }
    return false;
}

export function createPayloadTooLargeError(actualBytes, limitBytes, prefix = "[SourceReader] File size") {
    const maxMB = (limitBytes / (1024 * 1024)).toFixed(1);
    const actualMB = (actualBytes / (1024 * 1024)).toFixed(1);
    return new ValidationError(
        `${prefix} is too large (${actualMB}MB). Maximum allowed is ${maxMB}MB.`,
        { statusCode: 413, code: "PAYLOAD_TOO_LARGE" }
    );
}

export default {
    MediaError,
    MediaValidationError,
    MediaNotFoundError,
    MediaStorageError,
    MediaUploadError,
    MediaQuotaError,
    StorageError,
    StorageValidationError,
    ValidationError,
    UploadError,
    QuotaError,
    WORKFLOW_REFERENCE_QUOTA_PREFIX,
    WORKFLOW_REFERENCE_QUOTA_PATTERN,
    formatWorkflowReferenceQuotaMessage,
    isWorkflowReferenceQuotaError,
    createPayloadTooLargeError,
};
