/**
 * System 8: Workspace — Typed Errors (Rule 8)
 *
 * Base error extends AppError from #shared following platform conventions.
 * Every error carries standard code, statusCode, category, and safe public messages.
 */
import { AppError } from "#shared";

export class WorkspaceError extends AppError {
    constructor(codeOrMessage = "WORKSPACE_ERROR", messageOrOptions = "Internal workspace error", opts = {}) {
        let code = "WORKSPACE_ERROR";
        let message = "Internal workspace error";
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
        this.errorCode = code;
    }
}

export class WorkspaceValidationError extends WorkspaceError {
    constructor(message = "Invalid workspace parameters", { field = null, context = {} } = {}) {
        super("WORKSPACE_VALIDATION_ERROR", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 400,
            retryable: false,
            billingAction: "NONE",
            context: { field, ...context },
        });
        this.name = "WorkspaceValidationError";
        this.errorCode = "WORKSPACE_VALIDATION_ERROR";
        this.safeMessage = message;
        this.field = field;
    }
}

export class WorkspaceNotFoundError extends WorkspaceError {
    constructor(message = "Workspace resource not found", { resourceId = null, context = {} } = {}) {
        super("WORKSPACE_NOT_FOUND", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 404,
            retryable: false,
            billingAction: "NONE",
            context: { resourceId, ...context },
        });
        this.name = "WorkspaceNotFoundError";
        this.errorCode = "WORKSPACE_NOT_FOUND";
        this.safeMessage = message;
        this.resourceId = resourceId;
    }
}

export class WorkspaceConflictError extends WorkspaceError {
    constructor(message = "Workspace conflict or quota reached", { context = {} } = {}) {
        super("WORKSPACE_CONFLICT", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 409,
            retryable: false,
            billingAction: "NONE",
            context,
        });
        this.name = "WorkspaceConflictError";
        this.errorCode = "WORKSPACE_CONFLICT";
        this.safeMessage = message;
    }
}

export class WorkspaceUnauthorizedError extends WorkspaceError {
    constructor(message = "Unauthorized access to workspace resource", { resourceId = null, userId = null, context = {} } = {}) {
        super("WORKSPACE_UNAUTHORIZED", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 403,
            retryable: false,
            billingAction: "NONE",
            context: { resourceId, userId, ...context },
        });
        this.name = "WorkspaceUnauthorizedError";
        this.errorCode = "WORKSPACE_UNAUTHORIZED";
        this.safeMessage = "You do not have access to this workspace resource";
    }
}

import { FolderError } from "./services/FolderService.js";
export { FolderError };

export default {
    WorkspaceError,
    WorkspaceValidationError,
    WorkspaceNotFoundError,
    WorkspaceConflictError,
    WorkspaceUnauthorizedError,
    FolderError,
};
