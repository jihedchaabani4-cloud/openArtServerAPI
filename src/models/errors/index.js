export class ModelsSystemError extends Error {
  constructor(message, { retryable = false, safeMessage = "Internal error", statusCode = 500, code = "MODELS_SYSTEM_ERROR" } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.retryable = retryable;
    this.safeMessage = safeMessage;
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class ValidationError extends ModelsSystemError {
  constructor(message = "Invalid input", { field = null, safeMessage = null } = {}) {
    const finalSafeMessage = safeMessage || (field ? `Invalid input: ${field}` : "Invalid input");
    super(message, { retryable: false, safeMessage: finalSafeMessage, statusCode: 400, code: "VALIDATION_ERROR" });
    this.field = field;
  }
}


export class InvalidEnumValueError extends ValidationError {
  constructor(field, value, allowedValues = []) {
    super(`Value '${value}' is not allowed for '${field}'. Allowed: ${allowedValues.join(", ")}`, {
      field,
      safeMessage: `Invalid value for ${field}. Allowed values: ${allowedValues.join(", ")}`
    });
    this.name = "InvalidEnumValueError";
    this.code = "INVALID_ENUM_VALUE";
    this.value = value;
    this.allowedValues = allowedValues;
  }
}

export class UnknownParameterError extends ValidationError {
  constructor(field) {
    super(`Unknown parameter '${field}' not permitted`, {
      field,
      safeMessage: `Unknown parameter '${field}' is not supported`
    });
    this.name = "UnknownParameterError";
    this.code = "UNKNOWN_PARAMETER";
  }
}


export class UnknownModelFamilyError extends ModelsSystemError {
  constructor(modelFamily) {
    super(`Model family "${modelFamily}" not found`, {
      retryable: false,
      safeMessage: "Model or operation not found",
      statusCode: 404,
      code: "UNKNOWN_MODEL_FAMILY"
    });
    this.modelFamily = modelFamily;
  }
}

export const ModelNotFoundError = UnknownModelFamilyError;

export class UnknownOperationError extends ModelsSystemError {
  constructor(modelFamily, operation) {
    super(`Operation "${operation}" not supported for model family "${modelFamily}"`, {
      retryable: false,
      safeMessage: "Model or operation not found",
      statusCode: 404,
      code: "UNKNOWN_OPERATION"
    });
    this.modelFamily = modelFamily;
    this.operation = operation;
  }
}

export const OperationNotFoundError = UnknownOperationError;

export class BindingNotFoundError extends ModelsSystemError {
  constructor(bindingId, modelId = null, operation = null) {
    const detail = modelId && operation ? ` for model "${modelId}" (${operation})` : "";
    super(`Binding "${bindingId}" not found${detail}`, {
      retryable: false,
      safeMessage: "Selected provider binding not found",
      statusCode: 404,
      code: "BINDING_NOT_FOUND"
    });
    this.name = "BindingNotFoundError";
    this.bindingId = bindingId;
    this.modelId = modelId;
    this.operation = operation;
  }
}

export class BindingModelMismatchError extends ModelsSystemError {
  constructor(bindingId, bindingModelId, requestedModelId) {
    super(`Binding "${bindingId}" belongs to model "${bindingModelId}", but model "${requestedModelId}" was requested`, {
      retryable: false,
      safeMessage: "Binding does not match requested model",
      statusCode: 400,
      code: "BINDING_MODEL_MISMATCH"
    });
    this.name = "BindingModelMismatchError";
    this.bindingId = bindingId;
    this.bindingModelId = bindingModelId;
    this.requestedModelId = requestedModelId;
  }
}

export class BindingOperationMismatchError extends ModelsSystemError {
  constructor(bindingId, bindingOperation, requestedOperation) {
    super(`Binding "${bindingId}" is configured for operation "${bindingOperation}", but operation "${requestedOperation}" was requested`, {
      retryable: false,
      safeMessage: "Binding does not match requested operation",
      statusCode: 400,
      code: "BINDING_OPERATION_MISMATCH"
    });
    this.name = "BindingOperationMismatchError";
    this.bindingId = bindingId;
    this.bindingOperation = bindingOperation;
    this.requestedOperation = requestedOperation;
  }
}

export class ConfigIntegrityError extends ModelsSystemError {
  constructor(message) {
    super(message, {
      retryable: false,
      safeMessage: "Service configuration error",
      statusCode: 500,
      code: "CONFIG_INTEGRITY_ERROR"
    });
  }
}

export class CredentialError extends ModelsSystemError {
  constructor(message = "Authentication configuration error") {
    super(message, {
      retryable: false,
      safeMessage: "Authentication configuration error",
      statusCode: 401,
      code: "CREDENTIAL_ERROR"
    });
  }
}

export class ProviderRequestError extends ModelsSystemError {
  constructor(message) {
    super(message, {
      retryable: true,
      safeMessage: "Please try again",
      statusCode: 502,
      code: "PROVIDER_REQUEST_ERROR"
    });
  }
}

export class ProviderTransientError extends ModelsSystemError {
  constructor(message) {
    super(message, {
      retryable: true,
      safeMessage: "Please try again shortly",
      statusCode: 503,
      code: "PROVIDER_TRANSIENT_ERROR"
    });
  }
}

export class ProviderContentPolicyError extends ModelsSystemError {
  constructor(message) {
    super(message, {
      retryable: false,
      safeMessage: "Content couldn't be generated",
      statusCode: 422,
      code: "PROVIDER_CONTENT_POLICY_ERROR"
    });
  }
}

export class ProviderMalformedResponseError extends ModelsSystemError {
  constructor(message) {
    super(message, {
      retryable: false,
      safeMessage: "Unexpected provider response",
      statusCode: 500,
      code: "PROVIDER_MALFORMED_RESPONSE"
    });
  }
}

export class OutputContractViolationError extends ModelsSystemError {
  constructor(message = "Provider response violated output contract") {
    super(message, {
      retryable: false,
      safeMessage: "Output generation failed to meet contract",
      statusCode: 502,
      code: "OUTPUT_CONTRACT_VIOLATION"
    });
  }
}

// --- Dynamic Multi-Provider Error Classes (032) ---

export class UnknownProviderReferenceError extends ConfigIntegrityError {
  constructor(providerId, context = "") {
    super(`Unknown provider reference "${providerId}"${context ? ` in ${context}` : ""}`);
    this.name = "UnknownProviderReferenceError";
    this.code = "UNKNOWN_PROVIDER_REFERENCE";
    this.providerId = providerId;
  }
}

export class UnknownOperationReferenceError extends ConfigIntegrityError {
  constructor(modelId, operation) {
    super(`Binding references unknown operation "${operation}" for model "${modelId}"`);
    this.name = "UnknownOperationReferenceError";
    this.code = "UNKNOWN_OPERATION_REFERENCE";
    this.modelId = modelId;
    this.operation = operation;
  }
}

export class UnknownCanonicalParameterError extends ConfigIntegrityError {
  constructor(modelId, operation, paramKey) {
    super(`Binding for model "${modelId}" (${operation}) maps unknown canonical parameter "${paramKey}"`);
    this.name = "UnknownCanonicalParameterError";
    this.code = "UNKNOWN_CANONICAL_PARAMETER";
    this.modelId = modelId;
    this.operation = operation;
    this.paramKey = paramKey;
  }
}

export class DuplicateBindingError extends ConfigIntegrityError {
  constructor(modelId, operation, providerId) {
    super(`Duplicate binding detected for composite key (${modelId}, ${operation}, ${providerId})`);
    this.name = "DuplicateBindingError";
    this.code = "DUPLICATE_BINDING";
    this.modelId = modelId;
    this.operation = operation;
    this.providerId = providerId;
  }
}

export class UnsupportedCapabilityError extends ModelsSystemError {
  constructor(message = "No active provider binding supports the requested parameter values") {
    super(message, {
      retryable: false,
      safeMessage: "The requested parameter combination is not supported by any active provider",
      statusCode: 422,
      code: "UNSUPPORTED_CAPABILITY"
    });
    this.name = "UnsupportedCapabilityError";
  }
}

export class MissingUserIdError extends ModelsSystemError {
  constructor(message = "userId is required for model execution unless noCharge is explicitly granted") {
    super(message, {
      retryable: false,
      safeMessage: "Authentication required: missing userId",
      statusCode: 401,
      code: "MISSING_USER_ID"
    });
    this.name = "MissingUserIdError";
  }
}

export class MissingOptionError extends ModelsSystemError {
  constructor(optionName, message = null) {
    const finalMessage = message || `Required option "${optionName}" is missing`;
    super(finalMessage, {
      retryable: false,
      safeMessage: `Missing required execution option: ${optionName}`,
      statusCode: 400,
      code: "MISSING_OPTION"
    });
    this.name = "MissingOptionError";
    this.optionName = optionName;
  }
}

export class PriorityConflictError extends ConfigIntegrityError {
  constructor(modelId, operation, priority) {
    super(`Multiple active bindings share priority ${priority} for ("${modelId}", "${operation}")`);
    this.name = "PriorityConflictError";
    this.code = "PRIORITY_CONFLICT";
    this.modelId = modelId;
    this.operation = operation;
    this.priority = priority;
  }
}

export class MissingOutputMapError extends ConfigIntegrityError {
  constructor(modelId, operation, providerId) {
    super(`Binding for ("${modelId}", "${operation}", "${providerId}") is missing required "outputMap"`);
    this.name = "MissingOutputMapError";
    this.code = "MISSING_OUTPUT_MAP";
    this.modelId = modelId;
    this.operation = operation;
    this.providerId = providerId;
  }
}

