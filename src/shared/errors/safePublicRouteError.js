/**
 * safePublicRouteError
 * Maps caught route errors onto public API contracts:
 * - 5xx errors are masked: "Internal server error" + errorCode INTERNAL_ERROR.
 * - 4xx errors pass through their message and errorCode (or fallback based on status).
 */
export function safePublicRouteError(err, { statusCode } = {}) {
  const resolvedStatusCode = statusCode ?? (err?.statusCode || 500);
  const isInternal = resolvedStatusCode >= 500;
  const errorCode = isInternal
    ? "INTERNAL_ERROR"
    : (err?.errorCode || (resolvedStatusCode === 404 ? "NOT_FOUND" : "APP_ERROR"));

  return {
    statusCode: resolvedStatusCode,
    errorCode,
    publicMessage: isInternal ? "Internal server error" : (err?.message || "An error occurred"),
  };
}
