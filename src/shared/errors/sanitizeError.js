const INTERNAL_LEAK_REGEX =
  /\b(wavespeed|ltx|runwayml|runway|google|gemini|vertex|openai|anthropic|replicate|fal\.ai|supabase|postgrest|pg_|postgres|redis|bullmq|ioredis)\b/gi;
const URL_LEAK_REGEX = /https?:\/\/[^\s"'<>]+/gi;
const SQL_LEAK_REGEX =
  /\b(SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|relation\s+"[^"]+"\s+does\s+not\s+exist|syntax\s+error\s+at\s+or\s+near)\b/gi;
const STACK_TRACE_REGEX = /\n\s*at\s+[^\n]+/g;

/**
 * Strips stack traces, SQL fragments, internal URLs, and upstream vendor names from
 * error strings before surfacing messages to callers or persisting them.
 */
export function scrubSensitiveText(text, fallback = "Operation failed. Please try again.") {
  if (!text || typeof text !== "string") return fallback;
  let cleaned = text.replace(STACK_TRACE_REGEX, "").trim();
  if (SQL_LEAK_REGEX.test(cleaned)) {
    SQL_LEAK_REGEX.lastIndex = 0;
    return fallback;
  }
  cleaned = cleaned.replace(URL_LEAK_REGEX, "[redacted-url]");
  cleaned = cleaned.replace(INTERNAL_LEAK_REGEX, "provider");
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  return cleaned || fallback;
}

/**
 * Domain-neutral public error classifier and scrubber (zero billing or refund copy).
 * Business systems (e.g., Generation) can wrap or decorate these neutral results with
 * domain-specific messaging (such as credit refund copy for billable jobs).
 */
export function sanitizePublicError(err) {
  const rawCode = String(err?.code || err?.errorCode || "").trim();
  const rawMsg = typeof err?.message === "string" ? err.message : String(err || "");
  const rawCategory = String(err?.category || "").toUpperCase();
  const rawStatus = Number(err?.statusCode || err?.status || 0);

  if (rawCode === "SAFETY_CHECK_UNAVAILABLE") {
    const isRateLimit = rawCategory === "RATE_LIMIT" || rawStatus === 429;
    const category = isRateLimit ? "RATE_LIMIT" : "UPSTREAM_FAULT";
    const statusCode = isRateLimit ? 429 : rawStatus === 503 ? 503 : 502;
    const userMessage = isRateLimit
      ? "Safety check service is temporarily busy. Please try again in a moment."
      : "Safety check service is temporarily unavailable. Please try again shortly.";
    return {
      code: "SAFETY_CHECK_UNAVAILABLE",
      category,
      statusCode,
      retryable: err?.retryable !== undefined ? Boolean(err.retryable) : true,
      message: userMessage,
      userMessage,
    };
  }

  if (rawCode === "SAFETY_CHECK_FAILED") {
    const staticMsg = "Unable to verify prompt safety. Please revise your prompt and try again.";
    return {
      code: "SAFETY_CHECK_FAILED",
      category: "CONTENT_SAFETY_VIOLATION",
      statusCode: 422,
      retryable: false,
      message: staticMsg,
      userMessage: staticMsg,
    };
  }

  if (
    rawCode === "CONTENT_SAFETY_VIOLATION" ||
    rawCode === "PROMPT_VIOLATION" ||
    rawCode === "PROVIDER_CONTENT_POLICY_ERROR" ||
    rawCategory === "CONTENT_SAFETY_VIOLATION" ||
    err?.is_safe === false ||
    /content safety|content policy|safety violation|nsfw/i.test(rawMsg)
  ) {
    const cleanReason = scrubSensitiveText(
      err?.userMessage || err?.safeMessage || rawMsg,
      "Input violates content safety policy."
    );
    return {
      code: "CONTENT_SAFETY_VIOLATION",
      category: "CONTENT_SAFETY_VIOLATION",
      statusCode: 422,
      retryable: false,
      message: cleanReason,
      userMessage: cleanReason,
    };
  }

  if (
    rawCategory === "USER_FAULT" ||
    rawStatus === 400 ||
    rawStatus === 403 ||
    rawStatus === 404 ||
    rawCode === "WORKFLOW_VALIDATION_ERROR" ||
    rawCode === "WORKFLOW_NOT_FOUND" ||
    rawCode === "GENERATION_VALIDATION_ERROR" ||
    rawCode === "GENERATION_NOT_FOUND" ||
    rawCode === "USE_CASE_NOT_FOUND" ||
    rawCode === "FORBIDDEN" ||
    rawCode === "OWNERSHIP_VERIFICATION_FAILED" ||
    rawCode === "TARGET_VERIFICATION_FAILED"
  ) {
    const statusCode = rawStatus === 403 || rawStatus === 404 ? rawStatus : 400;
    const cleanMsg = scrubSensitiveText(
      err?.userMessage || err?.safeMessage || rawMsg,
      "Invalid request parameters."
    );
    return {
      code: rawCode || "VALIDATION_ERROR",
      category: "USER_FAULT",
      statusCode,
      retryable: false,
      message: cleanMsg,
      userMessage: cleanMsg,
    };
  }

  if (
    rawCode === "PROVIDER_QUOTA_EXCEEDED" ||
    rawCode === "CIRCUIT_BREAKER_OPEN" ||
    rawCategory === "UPSTREAM_FAULT" ||
    rawCategory === "RATE_LIMIT" ||
    rawStatus === 429 ||
    rawStatus === 502 ||
    rawStatus === 503 ||
    /rate limit|quota|timeout|timed out|upstream/i.test(rawCode) ||
    /rate limit|quota|timed out/i.test(rawMsg)
  ) {
    const isProviderQuota = rawCode === "PROVIDER_QUOTA_EXCEEDED";
    const isRateLimit =
      !isProviderQuota &&
      (rawCategory === "RATE_LIMIT" || rawStatus === 429 || /rate limit|quota/i.test(rawCode));
    const category = isRateLimit ? "RATE_LIMIT" : "UPSTREAM_FAULT";
    const statusCode = isProviderQuota
      ? 503
      : isRateLimit
        ? 429
        : rawStatus === 503 || rawCode === "CIRCUIT_BREAKER_OPEN"
          ? 503
          : 502;
    const userMessage = isProviderQuota
      ? "This model is temporarily unavailable due to upstream provider maintenance. Please select a different model."
      : isRateLimit
        ? "Service is currently busy. Please try again in a moment."
        : "Execution failed due to a temporary upstream service issue. Please try again shortly.";
    return {
      code: rawCode || (isRateLimit ? "RATE_LIMIT_EXCEEDED" : "UPSTREAM_ERROR"),
      category,
      statusCode,
      retryable:
        isProviderQuota || rawCode === "CIRCUIT_BREAKER_OPEN"
          ? false
          : err?.retryable !== undefined
            ? Boolean(err.retryable)
            : true,
      message: userMessage,
      userMessage,
    };
  }

  const fallbackMessage = "Execution failed due to an unexpected internal error. Please try again.";
  return {
    code: rawCode || "SERVER_ERROR",
    category: "SERVER_FAULT",
    statusCode: 500,
    retryable: false,
    message: fallbackMessage,
    userMessage: fallbackMessage,
  };
}

export default { scrubSensitiveText, sanitizePublicError };
