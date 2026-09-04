import { createLogger } from "../infrastructure/logging/index.js";

const dbLogger = createLogger("database");

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
    if (status === "error") {
        dbLogger.error(payload, `CRUD ${operation} failed: ${message || errorCode || "error"}`);
    } else {
        dbLogger.debug(payload, `CRUD ${operation} (${durationMs != null ? durationMs + "ms" : "ok"})`);
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
