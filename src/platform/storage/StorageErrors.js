/**
 * Storage Business System Typed Errors (Rule 8)
 *
 * Base error extends AppError following platform conventions.
 * StorageValidationError sets code "STORAGE_VALIDATION_ERROR", statusCode 400,
 * and maintains errorCode "VALIDATION_ERROR" for backward compatibility with
 * safePublicRouteError and legacy test harnesses.
 */
import { AppError } from "../../errors/AppError.js";

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
        /** @deprecated Legacy compatibility field for safePublicRouteError and test assertions */
        this.errorCode = "VALIDATION_ERROR";
        this.safeMessage = message;
    }
}
