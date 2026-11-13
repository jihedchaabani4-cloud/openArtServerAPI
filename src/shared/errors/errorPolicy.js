/**
 * errorPolicy.js — The Single Source of Truth Rulebook
 * Lookup table defining standard error code policies.
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
    category: "UPSTREAM_FAULT",
    retryable: false,
    billingAction: "RELEASE",
    statusCode: 503,
    userMessage: "This model is temporarily unavailable due to upstream provider maintenance. Please select a different model.",
  },
  CONTENT_SAFETY_VIOLATION: {
    category: "USER_FAULT",
    retryable: false,
    billingAction: "RELEASE",
    statusCode: 422,
    userMessage: "Your prompt violates our content policy. Please modify it and try again.",
  },
  SAFETY_CHECK_FAILED: {
    category: "UPSTREAM_FAULT",
    retryable: false,
    billingAction: "ROLLBACK",
    statusCode: 502,
    userMessage: "Content safety verification could not be completed. Please try again shortly.",
  },
  INSUFFICIENT_CREDITS: {
    category: "BILLING_FAULT",
    retryable: false,
    billingAction: "NONE",
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
    billingAction: "ROLLBACK",
    statusCode: 500,
    userMessage: "Something went wrong. Our team has been notified.",
  },
  INTERNAL_ERROR: {
    category: "SERVER_FAULT",
    retryable: false,
    billingAction: "ROLLBACK",
    statusCode: 500,
    userMessage: "Something went wrong. Our team has been notified.",
  },
  NOT_FOUND: {
    category: "USER_FAULT",
    retryable: false,
    billingAction: "NONE",
    statusCode: 404,
    userMessage: "Resource not found.",
  },
  VALIDATION_ERROR: {
    category: "USER_FAULT",
    retryable: false,
    billingAction: "NONE",
    statusCode: 400,
    userMessage: "Invalid input provided.",
  },
});
