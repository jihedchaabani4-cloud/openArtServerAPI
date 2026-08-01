/**
 * Structured CRUD operation logging for domain service owners.
 */
export function crudOperationLog({
    traceId = null,
    operation,
    durationMs = null,
    status = "ok",
    errorCode = null,
    message = null,
    ...extra
} = {}) {
    const payload = {
        traceId,
        operation,
        status,
        ...(durationMs != null ? { durationMs } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(message ? { message } : {}),
        ...extra,
    };
    const line = JSON.stringify(payload);
    if (status === "error") {
        console.error(`[CRUD] ${line}`);
    } else {
        console.log(`[CRUD] ${line}`);
    }
    return payload;
}

export class CrudServiceError extends Error {
    constructor(message, { statusCode = 500, errorCode = "CRUD_ERROR", ...fields } = {}) {
        super(message);
        this.name = "CrudServiceError";
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        Object.assign(this, fields);
    }
}
