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

export function createPayloadTooLargeError(actualBytes, limitBytes, prefix = "[SourceReader] File size") {
    const maxMB = (limitBytes / (1024 * 1024)).toFixed(1);
    const actualMB = (actualBytes / (1024 * 1024)).toFixed(1);
    return new ValidationError(
        `${prefix} is too large (${actualMB}MB). Maximum allowed is ${maxMB}MB.`,
        { statusCode: 413, code: "PAYLOAD_TOO_LARGE" }
    );
}
