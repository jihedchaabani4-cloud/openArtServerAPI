/**
 * System 6: Characters — Typed Errors (Rule 8)
 *
 * Base error extends AppError from #shared following platform conventions.
 * Every error carries standard code, statusCode, category, and safe public messages.
 */
import { AppError } from "#shared";

export class CharactersError extends AppError {
    constructor(code = "CHARACTERS_ERROR", message = "Internal characters error", {
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

export class CharactersValidationError extends CharactersError {
    constructor(message = "Invalid character parameters", { field = null, context = {} } = {}) {
        super("CHARACTERS_VALIDATION_ERROR", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 400,
            retryable: false,
            billingAction: "NONE",
            context: { field, ...context },
        });
        this.name = "CharactersValidationError";
        this.errorCode = "VALIDATION_ERROR";
        this.safeMessage = message;
        this.field = field;
    }
}

export class CharactersNotFoundError extends CharactersError {
    constructor(message = "Character not found", { characterId = null, context = {} } = {}) {
        super("CHARACTERS_NOT_FOUND", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 404,
            retryable: false,
            billingAction: "NONE",
            context: { characterId, ...context },
        });
        this.name = "CharactersNotFoundError";
        this.errorCode = "NOT_FOUND";
        this.safeMessage = message;
        this.characterId = characterId;
    }
}

export class CharactersConflictError extends CharactersError {
    constructor(message = "Character conflict or limit reached", { context = {} } = {}) {
        super("CHARACTERS_CONFLICT", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 409,
            retryable: false,
            billingAction: "NONE",
            context,
        });
        this.name = "CharactersConflictError";
        this.errorCode = "CONFLICT";
        this.safeMessage = message;
    }
}

export class CharactersUnauthorizedError extends CharactersError {
    constructor(message = "Unauthorized access to character", { characterId = null, userId = null, context = {} } = {}) {
        super("CHARACTERS_UNAUTHORIZED", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 403,
            retryable: false,
            billingAction: "NONE",
            context: { characterId, userId, ...context },
        });
        this.name = "CharactersUnauthorizedError";
        this.errorCode = "UNAUTHORIZED";
        this.safeMessage = "You do not have access to this character";
    }
}

export default {
    CharactersError,
    CharactersValidationError,
    CharactersNotFoundError,
    CharactersConflictError,
    CharactersUnauthorizedError,
};
