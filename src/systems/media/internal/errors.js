/**
 * Media & Storage System Error Hierarchy (Rule 9)
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

export default {
    MediaError,
    MediaValidationError,
    MediaNotFoundError,
    MediaStorageError,
    MediaUploadError,
    MediaQuotaError,
};
