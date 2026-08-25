export const RUNTIME_ERROR_CODES = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",
  BILLING_HOLD_REQUIRED: "BILLING_HOLD_REQUIRED",
  PRICING_NOT_FOUND: "PRICING_NOT_FOUND",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  PROVIDER_NOT_FOUND: "PROVIDER_NOT_FOUND",
  CONTENT_SAFETY_VIOLATION: "CONTENT_SAFETY_VIOLATION",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_RATE_LIMIT: "PROVIDER_RATE_LIMIT",
  PROVIDER_FAILED: "PROVIDER_FAILED",
  OUTPUT_INVALID: "OUTPUT_INVALID",
  PERSISTENCE_FAILED: "PERSISTENCE_FAILED",
  NODE_FAILED: "NODE_FAILED",
  ORCHESTRATION_DEADLOCK: "ORCHESTRATION_DEADLOCK",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

const DEFAULT_DECISIONS = Object.freeze({
  [RUNTIME_ERROR_CODES.INVALID_INPUT]: {
    retryable: false,
    workflowAction: "stop",
    billingAction: "none",
    userMessage: "The request is invalid.",
    severity: "warning",
  },
  [RUNTIME_ERROR_CODES.INSUFFICIENT_CREDITS]: {
    retryable: false,
    workflowAction: "stop",
    billingAction: "none",
    userMessage: "Not enough credits.",
    severity: "warning",
  },
  [RUNTIME_ERROR_CODES.BILLING_HOLD_REQUIRED]: {
    retryable: false,
    workflowAction: "stop",
    billingAction: "none",
    userMessage: "Billing could not be prepared for this job.",
    severity: "error",
  },
  [RUNTIME_ERROR_CODES.CONTENT_SAFETY_VIOLATION]: {
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: "The request did not pass content safety checks.",
    severity: "warning",
  },
  [RUNTIME_ERROR_CODES.PROVIDER_TIMEOUT]: {
    retryable: true,
    workflowAction: "retry",
    billingAction: "rollback",
    userMessage: "The provider timed out. Please try again.",
    severity: "warning",
  },
  [RUNTIME_ERROR_CODES.PROVIDER_RATE_LIMIT]: {
    retryable: true,
    workflowAction: "retry",
    billingAction: "rollback",
    userMessage: "The provider is temporarily busy. Please try again.",
    severity: "warning",
  },
  [RUNTIME_ERROR_CODES.PROVIDER_FAILED]: {
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: "Generation failed with the selected provider.",
    severity: "error",
  },
  [RUNTIME_ERROR_CODES.OUTPUT_INVALID]: {
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: "The provider returned an invalid result.",
    severity: "error",
  },
  [RUNTIME_ERROR_CODES.PERSISTENCE_FAILED]: {
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: "The result could not be saved.",
    severity: "error",
  },
  [RUNTIME_ERROR_CODES.ORCHESTRATION_DEADLOCK]: {
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: "The workflow could not continue.",
    severity: "critical",
  },
});

function normalizeCode(errorOrCode) {
  const code = typeof errorOrCode === "string" ? errorOrCode : errorOrCode?.code;
  return code || RUNTIME_ERROR_CODES.INTERNAL_ERROR;
}

export function getErrorDecision(errorOrCode) {
  const code = normalizeCode(errorOrCode);
  const decision = DEFAULT_DECISIONS[code] || {
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: "The workflow failed.",
    severity: "error",
  };

  return {
    code,
    retryable: decision.retryable,
    workflowAction: decision.workflowAction,
    billingAction: decision.billingAction,
    userMessage: decision.userMessage,
    internalMessage: typeof errorOrCode === "string" ? code : errorOrCode?.message || code,
    severity: decision.severity,
  };
}

export function toRuntimeError(error, fallbackCode = RUNTIME_ERROR_CODES.INTERNAL_ERROR) {
  const code = error?.code || fallbackCode;
  const decision = getErrorDecision({ ...error, code });
  return {
    code,
    message: decision.userMessage,
    details: error?.details,
    retryable: decision.retryable,
  };
}
