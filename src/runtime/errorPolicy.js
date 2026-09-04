/**
 * errorPolicy.js — The Single Source of Truth Rulebook
 * ─────────────────────────────────────────────────────────────────────────────
 * Static lookup table defining what each error code means:
 * - category: USER_FAULT | SERVER_FAULT | UPSTREAM_FAULT | BILLING_FAULT
 * - retryable: boolean
 * - billingAction: NONE | RELEASE | COMMIT | ROLLBACK
 * - statusCode: HTTP status code
 * - userMessage: Clean, user-safe message (zero information leakage)
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const ERROR_POLICY = Object.freeze({
  PROVIDER_TIMEOUT: {
    category: "UPSTREAM_FAULT",
    retryable: true,
    billingAction: "RELEASE",
    statusCode: 502,
    userMessage: "The service is temporarily unavailable. Please try again shortly.",
  },
  PROVIDER_QUOTA_EXCEEDED: {
    category: "SERVER_FAULT", // don't leak "it's the provider's fault" to the user
    retryable: false,
    billingAction: "RELEASE",
    statusCode: 500,
    userMessage: "Please try again in a few moments.",
  },
  CONTENT_SAFETY_VIOLATION: {
    category: "USER_FAULT",
    retryable: false,
    billingAction: "RELEASE",
    statusCode: 422,
    userMessage: "Your prompt violates our content policy. Please modify it and try again.",
  },
  INSUFFICIENT_CREDITS: {
    category: "BILLING_FAULT",
    retryable: false,
    billingAction: "NONE", // no hold was ever created
    statusCode: 402,
    userMessage: "You don't have enough credits for this operation.",
  },
  PROVIDER_AUTH_FAILED: {
    category: "SERVER_FAULT",
    retryable: false,
    billingAction: "ROLLBACK",
    statusCode: 500,
    userMessage: "Please try again in a few moments.",
  },
  PROGRAMMER_ERROR: {
    category: "SERVER_FAULT",
    retryable: false,
    billingAction: "ROLLBACK", // safest default: never leave a dangling hold
    statusCode: 500,
    userMessage: "Please try again in a few moments.",
  },
  PROVIDER_RATE_LIMIT: {
    category: "UPSTREAM_FAULT",
    retryable: true,
    billingAction: "RELEASE",
    statusCode: 429,
    userMessage: "The service is temporarily busy. Please try again shortly.",
  },
  INVALID_INPUT: {
    category: "USER_FAULT",
    retryable: false,
    billingAction: "NONE",
    statusCode: 400,
    userMessage: "Invalid input parameters. Please check your settings and try again.",
  },
  SSRF_BLOCKED: {
    category: "USER_FAULT",
    retryable: false,
    billingAction: "NONE",
    statusCode: 400,
    userMessage: "The provided image URL is not permitted.",
  },
  PERSISTENCE_FAILED: {
    category: "SERVER_FAULT",
    retryable: false,
    billingAction: "ROLLBACK",
    statusCode: 500,
    userMessage: "Please try again in a few moments.",
  },
  INTERNAL_ERROR: {
    category: "SERVER_FAULT",
    retryable: false,
    billingAction: "ROLLBACK",
    statusCode: 500,
    userMessage: "Please try again in a few moments.",
  },
});

export default ERROR_POLICY;
