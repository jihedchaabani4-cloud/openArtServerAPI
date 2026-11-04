/**
 * Models Business System Typed Errors (Rule 8)
 *
 * Base error extends AppError following platform conventions.
 * Every error carries standard code, statusCode, category, and safe public messages.
 */
import { AppError } from "../../errors/AppError.js";

export class ModelsError extends AppError {
    constructor(code = "MODELS_ERROR", message = "Internal models error", {
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

export class ModelsValidationError extends ModelsError {
    constructor(message = "Invalid model parameters", { field = null, context = {} } = {}) {
        super("MODELS_VALIDATION_ERROR", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 400,
            retryable: false,
            billingAction: "NONE",
            context: { field, ...context },
        });
        this.name = "ModelsValidationError";
        this.errorCode = "VALIDATION_ERROR";
        this.safeMessage = message;
        this.field = field;
    }
}

export class ModelsNotFoundError extends ModelsError {
    constructor(message = "Model or operation not found", { modelFamily = null, operation = null, context = {} } = {}) {
        super("MODELS_NOT_FOUND", message, {
            type: "OPERATIONAL",
            category: "USER_FAULT",
            statusCode: 404,
            retryable: false,
            billingAction: "NONE",
            context: { modelFamily, operation, ...context },
        });
        this.name = "ModelsNotFoundError";
        this.errorCode = "NOT_FOUND";
        this.safeMessage = message;
        this.modelFamily = modelFamily;
        this.operation = operation;
    }
}

export class ModelsConfigurationError extends ModelsError {
    constructor(message = "Model configuration or binding integrity error", { context = {} } = {}) {
        super("MODELS_CONFIGURATION_ERROR", message, {
            type: "OPERATIONAL",
            category: "SERVER_FAULT",
            statusCode: 500,
            retryable: false,
            billingAction: "NONE",
            context,
        });
        this.name = "ModelsConfigurationError";
        this.errorCode = "CONFIG_ERROR";
        this.safeMessage = "Internal model configuration error";
    }
}

export class ModelsProviderError extends ModelsError {
    constructor(message = "Upstream model provider error", { provider = null, retryable = false, context = {} } = {}) {
        super("MODELS_PROVIDER_ERROR", message, {
            type: "OPERATIONAL",
            category: "UPSTREAM_FAULT",
            statusCode: 502,
            retryable,
            billingAction: retryable ? "NONE" : "ROLLBACK",
            context: { provider, ...context },
        });
        this.name = "ModelsProviderError";
        this.errorCode = "PROVIDER_ERROR";
        this.safeMessage = "Upstream provider error";
        this.provider = provider;
    }
}

// Re-export legacy error hierarchy from src/models/errors for backward compatibility
export {
    ModelsSystemError,
    ValidationError,
    InvalidEnumValueError,
    UnknownParameterError,
    MissingOptionError,
    ProviderTransientError,
    ProviderRequestError,
    ProviderContentPolicyError,
    ProviderMalformedResponseError,
    OutputContractViolationError,
    UnsupportedCapabilityError,
    UnknownModelFamilyError,
    ModelNotFoundError,
    UnknownOperationError,
    OperationNotFoundError,
    BindingNotFoundError,
    BindingModelMismatchError,
    BindingOperationMismatchError,
    ConfigIntegrityError,
    NoEligibleBindingError,
} from "../../models/errors/index.js";
