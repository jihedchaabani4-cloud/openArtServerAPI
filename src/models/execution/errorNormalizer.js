import {
  ModelsSystemError,
  ProviderRequestError,
  ProviderTransientError,
  UnsupportedCapabilityError,
  OutputContractViolationError,
} from "../errors/index.js";

export const StandardErrorCodes = Object.freeze({
  RATE_LIMITED: "RATE_LIMITED",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_QUOTA_EXCEEDED: "PROVIDER_QUOTA_EXCEEDED",
  INVALID_INPUT_REJECTED_BY_PROVIDER: "INVALID_INPUT_REJECTED_BY_PROVIDER",
  UNSUPPORTED_CAPABILITY: "UNSUPPORTED_CAPABILITY",
  OUTPUT_CONTRACT_VIOLATION: "OUTPUT_CONTRACT_VIOLATION",
  UNKNOWN_PROVIDER_ERROR: "UNKNOWN_PROVIDER_ERROR",
});

/**
 * Normalizes raw HTTP, SDK, or network errors into uniform platform taxonomy.
 */
export function normalizeError(err, context = {}) {
  const statusCode = err.statusCode || err.status || 500;
  const rawMessage = err.message || "Unknown error";
  const rawData = err.raw || err.response?.data || null;

  // 1. Check if already one of our typed errors
  if (
    err instanceof UnsupportedCapabilityError ||
    err instanceof OutputContractViolationError
  ) {
    return err;
  }

  // 2. Custom errorMap defined on binding
  if (context.binding?.errorMap && context.binding.errorMap[err.code]) {
    const mapped = context.binding.errorMap[err.code];
    return new ModelsSystemError(mapped.message || rawMessage, {
      code: mapped.code || StandardErrorCodes.UNKNOWN_PROVIDER_ERROR,
      retryable: mapped.retryable ?? false,
      statusCode: mapped.statusCode || statusCode,
      safeMessage: mapped.safeMessage || "An error occurred with the AI provider",
    });
  }

  // 3. Provider Account Balance / Quota Exhaustion (Admin/Platform issue, NOT end-user fault)
  if (
    err.code === StandardErrorCodes.PROVIDER_QUOTA_EXCEEDED ||
    err.code === "PROVIDER_QUOTA_EXCEEDED" ||
    statusCode === 402 ||
    /insufficient (credits|funds)|insufficient_funds|top up your account|insufficient_quota|balance.*exhausted|credit limit reached/i.test(rawMessage)
  ) {
    const error = new ProviderRequestError(`Provider account quota/credits exhausted: ${rawMessage}`);
    error.code = StandardErrorCodes.PROVIDER_QUOTA_EXCEEDED;
    error.statusCode = 503;
    error.retryable = false;
    error.safeMessage = "This model is temporarily unavailable due to upstream provider maintenance. Please select a different model.";
    error.providerRaw = rawData || { message: rawMessage };
    return error;
  }

  // 4. Rate Limit detection
  if (statusCode === 429 || /rate limit|too many requests/i.test(rawMessage)) {
    const error = new ProviderTransientError("Provider rate limit reached. Please try again shortly.");
    error.code = StandardErrorCodes.RATE_LIMITED;
    error.statusCode = 429;
    error.retryable = true;
    error.safeMessage = "The AI model is temporarily busy. Retrying shortly.";
    error.providerRaw = rawData || { message: rawMessage };
    return error;
  }

  // 4. Timeout detection
  if (statusCode === 504 || /timeout|timed out|abort/i.test(rawMessage)) {
    const error = new ProviderTransientError("Provider request timed out.");
    error.code = StandardErrorCodes.PROVIDER_TIMEOUT;
    error.statusCode = 504;
    error.retryable = true;
    error.safeMessage = "The model generation took too long. Please try again.";
    error.providerRaw = rawData || { message: rawMessage };
    return error;
  }

  // 5. Provider Outage / Server Error
  if (statusCode === 502 || statusCode === 503 || /bad gateway|service unavailable|network error/i.test(rawMessage)) {
    const error = new ProviderTransientError("Provider is currently unavailable.");
    error.code = StandardErrorCodes.PROVIDER_UNAVAILABLE;
    error.statusCode = 503;
    error.retryable = true;
    error.safeMessage = "The model provider is temporarily unavailable. Please try again shortly.";
    error.providerRaw = rawData || { message: rawMessage };
    return error;
  }

  // 6. Bad Input / Payload Rejection
  if (statusCode === 400 || statusCode === 422) {
    const error = new ProviderRequestError(`Provider rejected input payload: ${rawMessage}`);
    error.code = StandardErrorCodes.INVALID_INPUT_REJECTED_BY_PROVIDER;
    error.statusCode = statusCode;
    error.retryable = false;
    error.safeMessage = "The model rejected one of the input parameters.";
    error.providerRaw = rawData || { message: rawMessage };
    return error;
  }

  // 7. Fallback generic
  const genericError = new ModelsSystemError(rawMessage, {
    code: StandardErrorCodes.UNKNOWN_PROVIDER_ERROR,
    statusCode,
    retryable: statusCode >= 500,
    safeMessage: "An unexpected provider error occurred.",
  });
  genericError.providerRaw = rawData || { message: rawMessage };
  return genericError;
}
