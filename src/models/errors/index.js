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

export class SSRFBlockedError extends ValidationError {
  constructor(message = "SSRF validation failed: domain not allowed") {
    super(message, { safeMessage: "This URL host isn't allowed" });
    this.name = "SSRFBlockedError";
    this.code = "SSRF_BLOCKED";
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

export class InsufficientCreditsError extends ModelsSystemError {
  constructor(required, available) {
    super(`Insufficient credits: required ${required}, available ${available}`, {
      retryable: false,
      safeMessage: "Insufficient credits for this generation",
      statusCode: 402,
      code: "INSUFFICIENT_CREDITS"
    });
    this.required = required;
    this.available = available;
  }
}

export class ReservationExpiredError extends ModelsSystemError {
  constructor(reservationId) {
    super(`Reservation '${reservationId}' has expired or was already released`, {
      retryable: false,
      safeMessage: "Credit reservation expired",
      statusCode: 409,
      code: "RESERVATION_EXPIRED"
    });
    this.reservationId = reservationId;
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

export class NoServableDeploymentError extends ModelsSystemError {
  constructor(modelFamily, operation) {
    super(`No servable deployment found for ("${modelFamily}", "${operation}")`, {
      retryable: false,
      safeMessage: "Service temporarily unavailable",
      statusCode: 503,
      code: "NO_SERVABLE_DEPLOYMENT"
    });
    this.modelFamily = modelFamily;
    this.operation = operation;
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

export class PricingConfigError extends ModelsSystemError {
  constructor(message) {
    super(message, {
      retryable: false,
      safeMessage: "Pricing configuration error",
      statusCode: 500,
      code: "PRICING_CONFIG_ERROR"
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
  constructor(message) {
    super(message, {
      retryable: false,
      safeMessage: "Internal error",
      statusCode: 500,
      code: "OUTPUT_CONTRACT_VIOLATION"
    });
  }
}
