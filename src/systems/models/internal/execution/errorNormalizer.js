import {
  ModelsSystemError,
  ProviderRequestError,
  ProviderTransientError,
  UnsupportedCapabilityError,
  OutputContractViolationError,
} from "../errors.js";

export const StandardErrorCodes = Object.freeze({
  RATE_LIMITED: "RATE_LIMITED",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_QUOTA_EXCEEDED: "PROVIDER_QUOTA_EXCEEDED",
  CIRCUIT_BREAKER_OPEN: "CIRCUIT_BREAKER_OPEN",
  INVALID_INPUT_REJECTED_BY_PROVIDER: "INVALID_INPUT_REJECTED_BY_PROVIDER",
  UNSUPPORTED_CAPABILITY: "UNSUPPORTED_CAPABILITY",
  OUTPUT_CONTRACT_VIOLATION: "OUTPUT_CONTRACT_VIOLATION",
  UNKNOWN_PROVIDER_ERROR: "UNKNOWN_PROVIDER_ERROR",
});

/**
 * Parses duration strings like "12s", "1.5s", "500ms", "2m" into milliseconds.
 */
function parseDurationStringMs(val) {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  if (!trimmed) return null;

  let match = /^(\d+(?:\.\d+)?)\s*ms$/i.exec(trimmed);
  if (match) return Math.round(parseFloat(match[1]));

  match = /^(\d+(?:\.\d+)?)\s*s$/i.exec(trimmed);
  if (match) return Math.round(parseFloat(match[1]) * 1000);

  match = /^(\d+(?:\.\d+)?)\s*m$/i.exec(trimmed);
  if (match) return Math.round(parseFloat(match[1]) * 60 * 1000);

  return null;
}

/**
 * Parses RFC 7231 Retry-After header values (delta-seconds or HTTP-date) or duration strings into ms.
 */
function parseRetryAfterHeaderMs(val, now = Date.now()) {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
    return Math.round(val * 1000);
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) return null;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      return Math.round(parseFloat(trimmed) * 1000);
    }
    const durationMs = parseDurationStringMs(trimmed);
    if (durationMs !== null) return durationMs;

    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) {
      return Math.max(0, dateMs - now);
    }
  }
  return null;
}

function getHeaderCaseInsensitive(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    const val = headers.get(name);
    if (val !== null && val !== undefined) return val;
  }
  if (typeof headers === "object") {
    const target = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === target && v !== null && v !== undefined) {
        return v;
      }
    }
  }
  return null;
}

function findRetryDelayInObject(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return null;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findRetryDelayInObject(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }

  if (obj.retryDelay !== undefined && obj.retryDelay !== null) {
    if (typeof obj.retryDelay === "string") {
      const parsed = parseDurationStringMs(obj.retryDelay) ?? parseRetryAfterHeaderMs(obj.retryDelay);
      if (parsed !== null) return parsed;
    } else if (typeof obj.retryDelay === "number" && Number.isFinite(obj.retryDelay) && obj.retryDelay >= 0) {
      return Math.round(obj.retryDelay * 1000);
    } else if (typeof obj.retryDelay === "object") {
      const sec = Number(obj.retryDelay.seconds || 0);
      const nanos = Number(obj.retryDelay.nanos || 0);
      if (Number.isFinite(sec) && Number.isFinite(nanos) && (sec > 0 || nanos > 0)) {
        return Math.round(sec * 1000 + nanos / 1e6);
      }
    }
  }

  const nestedKeys = ["details", "errorDetails", "error", "providerRaw", "raw", "data", "response"];
  for (const key of nestedKeys) {
    if (obj[key] && typeof obj[key] === "object") {
      const found = findRetryDelayInObject(obj[key], depth + 1);
      if (found !== null) return found;
    }
  }

  return null;
}

/**
 * Extracts numeric retryAfterMs from Retry-After headers or provider retryDelay payloads.
 */
export function extractRetryAfterMs(err, rawData = null, rawMessage = "") {
  if (!err || typeof err !== "object") return null;

  if (typeof err.retryAfterMs === "number" && Number.isFinite(err.retryAfterMs) && err.retryAfterMs >= 0) {
    return Math.round(err.retryAfterMs);
  }

  const headerSources = [err.headers, err.response?.headers, rawData?.headers];
  for (const headers of headerSources) {
    const retryAfterVal = getHeaderCaseInsensitive(headers, "retry-after");
    const parsed = parseRetryAfterHeaderMs(retryAfterVal);
    if (parsed !== null) return parsed;
  }

  if (err.retryAfter !== undefined) {
    const parsed = parseRetryAfterHeaderMs(err.retryAfter);
    if (parsed !== null) return parsed;
  }

  const delaySources = [err, rawData, err.details, err.errorDetails, err.error, err.providerRaw];
  for (const src of delaySources) {
    const found = findRetryDelayInObject(src);
    if (found !== null) return found;
  }

  if (typeof rawMessage === "string" && rawMessage) {
    const jsonDelayMatch = /"retryDelay"\s*:\s*"([^"]+)"/i.exec(rawMessage);
    if (jsonDelayMatch) {
      const parsed = parseDurationStringMs(jsonDelayMatch[1]) ?? parseRetryAfterHeaderMs(jsonDelayMatch[1]);
      if (parsed !== null) return parsed;
    }
    const textDelayMatch = /retry in\s+(\d+(?:\.\d+)?\s*(?:ms|s))\b/i.exec(rawMessage);
    if (textDelayMatch) {
      const parsed = parseDurationStringMs(textDelayMatch[1]);
      if (parsed !== null) return parsed;
    }
  }

  return null;
}

/**
 * Normalizes raw HTTP, SDK, or network errors into uniform platform taxonomy.
 */
export function normalizeError(err, context = {}) {
  const statusCode = err.statusCode || err.status || 500;
  const rawMessage = err.message || "Unknown error";
  const rawData = err.raw || err.response?.data || null;

  // 1. Check if already one of our typed errors or circuit breaker open
  if (
    err instanceof UnsupportedCapabilityError ||
    err instanceof OutputContractViolationError
  ) {
    return err;
  }

  if (err.code === StandardErrorCodes.CIRCUIT_BREAKER_OPEN) {
    err.retryable = false;
    err.statusCode = 503;
    err.category = err.category || "UPSTREAM_FAULT";
    return err;
  }

  // 2. Provider Account Balance / Quota Exhaustion (Admin/Platform issue, NOT end-user fault)
  // Checked BEFORE generic err.terminal so provider quota errors (e.g. LTX "Insufficient funds")
  // are never swallowed by err.terminal with a 429/402 status or raw message.
  if (
    err.code === StandardErrorCodes.PROVIDER_QUOTA_EXCEEDED ||
    err.code === "PROVIDER_QUOTA_EXCEEDED" ||
    statusCode === 402 ||
    rawData?.error?.type === "insufficient_funds_error" ||
    /insufficient (credits|funds)|insufficient_funds|top up your account|insufficient_quota|balance.*exhausted|credit limit reached/i.test(rawMessage)
  ) {
    const error = new ProviderRequestError(`Provider account quota/credits exhausted: ${rawMessage}`);
    error.code = StandardErrorCodes.PROVIDER_QUOTA_EXCEEDED;
    error.statusCode = 503;
    error.retryable = false;
    if (err.terminal) error.terminal = true;
    error.safeMessage = "This model is temporarily unavailable due to upstream provider maintenance. Please select a different model.";
    error.providerRaw = rawData || { message: rawMessage };
    return error;
  }

  // 3. Check if terminal provider job failure from polling
  if (err.terminal || (err.retryable === false && err.code === "PROVIDER_JOB_FAILED")) {
    const error = new ProviderRequestError(rawMessage);
    error.code = err.code || StandardErrorCodes.INVALID_INPUT_REJECTED_BY_PROVIDER;
    error.statusCode = statusCode;
    error.retryable = false;
    error.terminal = true;
    error.safeMessage = err.safeMessage || rawMessage || "The AI generation job failed on the provider.";
    error.providerRaw = rawData || { message: rawMessage };
    return error;
  }

  // 4. Custom errorMap defined on binding
  if (context.binding?.errorMap && context.binding.errorMap[err.code]) {
    const mapped = context.binding.errorMap[err.code];
    return new ModelsSystemError(mapped.message || rawMessage, {
      code: mapped.code || StandardErrorCodes.UNKNOWN_PROVIDER_ERROR,
      retryable: mapped.retryable ?? false,
      statusCode: mapped.statusCode || statusCode,
      safeMessage: mapped.safeMessage || "An error occurred with the AI provider",
    });
  }

  // 5. Rate Limit detection
  if (statusCode === 429 || /rate limit|too many requests/i.test(rawMessage)) {
    const error = new ProviderTransientError("Provider rate limit reached. Please try again shortly.");
    error.code = StandardErrorCodes.RATE_LIMITED;
    error.statusCode = 429;
    error.retryable = true;
    error.safeMessage = "The AI model is temporarily busy. Retrying shortly.";
    error.providerRaw = rawData || { message: rawMessage };
    const retryAfterMs = extractRetryAfterMs(err, rawData, rawMessage);
    if (retryAfterMs !== null) {
      error.retryAfterMs = retryAfterMs;
    }
    return error;
  }

  // 6. Timeout detection
  if (statusCode === 504 || /timeout|timed out|abort/i.test(rawMessage)) {
    const error = new ProviderTransientError("Provider request timed out.");
    error.code = StandardErrorCodes.PROVIDER_TIMEOUT;
    error.statusCode = 504;
    error.retryable = true;
    error.safeMessage = "The model generation took too long. Please try again.";
    error.providerRaw = rawData || { message: rawMessage };
    return error;
  }

  // 7. Provider Outage / Server Error
  if (statusCode === 502 || statusCode === 503 || /bad gateway|service unavailable|network error/i.test(rawMessage)) {
    const error = new ProviderTransientError("Provider is currently unavailable.");
    error.code = StandardErrorCodes.PROVIDER_UNAVAILABLE;
    error.statusCode = 503;
    error.retryable = true;
    error.safeMessage = "The model provider is temporarily unavailable. Please try again shortly.";
    error.providerRaw = rawData || { message: rawMessage };
    const retryAfterMs = extractRetryAfterMs(err, rawData, rawMessage);
    if (retryAfterMs !== null) {
      error.retryAfterMs = retryAfterMs;
    }
    return error;
  }

  // 8. Bad Input / Payload Rejection
  if (statusCode === 400 || statusCode === 422) {
    const error = new ProviderRequestError(`Provider rejected input payload: ${rawMessage}`);
    error.code = StandardErrorCodes.INVALID_INPUT_REJECTED_BY_PROVIDER;
    error.statusCode = statusCode;
    error.retryable = false;
    error.safeMessage = "The model rejected one of the input parameters.";
    error.providerRaw = rawData || { message: rawMessage };
    return error;
  }

  // 9. Fallback generic
  const genericError = new ModelsSystemError(rawMessage, {
    code: StandardErrorCodes.UNKNOWN_PROVIDER_ERROR,
    statusCode,
    retryable: statusCode >= 500,
    safeMessage: "An unexpected provider error occurred.",
  });
  genericError.providerRaw = rawData || { message: rawMessage };
  return genericError;
}
