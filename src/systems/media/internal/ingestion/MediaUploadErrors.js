/**
 * Typed error classes for the unified Media Upload module (ADR-0012).
 *
 * Compatible with safePublicRouteError in src/utils/httpErrorResponse.js
 * via statusCode, code, and errorCode properties.
 */

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

/**
 * @deprecated Transitional — relocate to Workflow domain in the Workflow Service phase.
 * Retained here only for direct internal imports in WorkflowMediaRepository, WorkflowMediaService,
 * and scripts/run-disposable-shared-media-test.js; excluded from platform/media-ingestion barrel.
 */
export const WORKFLOW_REFERENCE_QUOTA_PREFIX = "Maximum ";
/** @deprecated Transitional — relocate to Workflow domain in the Workflow Service phase. */
export const WORKFLOW_REFERENCE_QUOTA_PATTERN = /Maximum\s+\d+\s+reference\s+images\s+allowed/i;

/** @deprecated Transitional — relocate to Workflow domain in the Workflow Service phase. */
export function formatWorkflowReferenceQuotaMessage(maxAllowed, currentCount) {
    return `Maximum ${maxAllowed} reference images allowed per element. Current: ${currentCount}`;
}

/** @deprecated Transitional — relocate to Workflow domain in the Workflow Service phase. */
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
