/**
 * Centralized Error Policy & Classification System
 * ─────────────────────────────────────────────────────────────────────────────
 * Enforces strict fault ownership:
 *
 * 1. USER_FAULT:
 *    User triggered the issue (e.g., NSFW / sexual / violence prompt, bad input).
 *    → Clear, polite message explaining what they need to fix.
 *
 * 2. BILLING_FAULT:
 *    User has insufficient credits to run the workflow.
 *    → Explicit notification to top up wallet.
 *
 * 3. SERVER_FAULT & UPSTREAM_FAULT:
 *    Issue occurred on our end or with an external AI provider (bug in code,
 *    API key expired/out of credits, database glitch, provider 504/429).
 *    → Standard apology message without leaking internal secrets or stack traces.
 *    → Full error details preserved internally for developer logs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createLogger } from "../../infrastructure/logging/index.js";

const errorLogger = createLogger("system");

export const ERROR_CATEGORIES = Object.freeze({
  USER_FAULT: "USER_FAULT",
  BILLING_FAULT: "BILLING_FAULT",
  SERVER_FAULT: "SERVER_FAULT",
  UPSTREAM_FAULT: "UPSTREAM_FAULT",
});

export const DEFAULT_APOLOGY_MESSAGE =
  "Please try again in a few moments.";

export const RUNTIME_ERROR_CODES = Object.freeze({
  // User Faults
  CONTENT_SAFETY_VIOLATION: "CONTENT_SAFETY_VIOLATION",
  PROVIDER_CONTENT_POLICY_ERROR: "PROVIDER_CONTENT_POLICY_ERROR",
  INVALID_INPUT: "INVALID_INPUT",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  SSRF_BLOCKED: "SSRF_BLOCKED",

  // Billing Faults
  INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",
  BILLING_HOLD_REQUIRED: "BILLING_HOLD_REQUIRED",

  // Upstream AI Provider Faults
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_RATE_LIMIT: "PROVIDER_RATE_LIMIT",
  PROVIDER_TRANSIENT_ERROR: "PROVIDER_TRANSIENT_ERROR",
  PROVIDER_REQUEST_ERROR: "PROVIDER_REQUEST_ERROR",
  PROVIDER_QUOTA_EXCEEDED: "PROVIDER_QUOTA_EXCEEDED",
  PROVIDER_MALFORMED_RESPONSE: "PROVIDER_MALFORMED_RESPONSE",

  // Server / Internal Faults
  CREDENTIAL_ERROR: "CREDENTIAL_ERROR",
  CONFIG_INTEGRITY_ERROR: "CONFIG_INTEGRITY_ERROR",
  PRICING_CONFIG_ERROR: "PRICING_CONFIG_ERROR",
  NO_SERVABLE_DEPLOYMENT: "NO_SERVABLE_DEPLOYMENT",
  UNKNOWN_MODEL_FAMILY: "UNKNOWN_MODEL_FAMILY",
  UNKNOWN_OPERATION: "UNKNOWN_OPERATION",
  PROVIDER_FAILED: "PROVIDER_FAILED",
  OUTPUT_INVALID: "OUTPUT_INVALID",
  OUTPUT_CONTRACT_VIOLATION: "OUTPUT_CONTRACT_VIOLATION",
  PERSISTENCE_FAILED: "PERSISTENCE_FAILED",
  NODE_FAILED: "NODE_FAILED",
  ORCHESTRATION_DEADLOCK: "ORCHESTRATION_DEADLOCK",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

const DEFAULT_DECISIONS = Object.freeze({
  // ── USER FAULTS ────────────────────────────────────────────────────────────
  [RUNTIME_ERROR_CODES.CONTENT_SAFETY_VIOLATION]: {
    category: ERROR_CATEGORIES.USER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: "Your prompt violates our content safety policy (NSFW or prohibited content). Please modify your prompt and try again.",
    severity: "warning",
  },
  [RUNTIME_ERROR_CODES.PROVIDER_CONTENT_POLICY_ERROR]: {
    category: ERROR_CATEGORIES.USER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: "Your prompt violates our content safety policy (NSFW or prohibited content). Please modify your prompt and try again.",
    severity: "warning",
  },
  [RUNTIME_ERROR_CODES.INVALID_INPUT]: {
    category: ERROR_CATEGORIES.USER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "none",
    userMessage: "Invalid generation settings. Please check your prompt and inputs and try again.",
    severity: "warning",
  },
  [RUNTIME_ERROR_CODES.VALIDATION_ERROR]: {
    category: ERROR_CATEGORIES.USER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "none",
    userMessage: "Invalid generation settings. Please check your prompt and inputs and try again.",
    severity: "warning",
  },
  [RUNTIME_ERROR_CODES.SSRF_BLOCKED]: {
    category: ERROR_CATEGORIES.USER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "none",
    userMessage: "The provided image URL is not permitted.",
    severity: "warning",
  },

  // ── BILLING FAULTS ─────────────────────────────────────────────────────────
  [RUNTIME_ERROR_CODES.INSUFFICIENT_CREDITS]: {
    category: ERROR_CATEGORIES.BILLING_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "none",
    userMessage: "You don't have enough credits to complete this generation. Please top up your wallet.",
    severity: "warning",
  },
  [RUNTIME_ERROR_CODES.BILLING_HOLD_REQUIRED]: {
    category: ERROR_CATEGORIES.BILLING_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "none",
    userMessage: "Billing could not be prepared for this job. Please try again.",
    severity: "error",
  },

  // ── UPSTREAM AI PROVIDER FAULTS (Apology to user) ──────────────────────────
  [RUNTIME_ERROR_CODES.PROVIDER_TIMEOUT]: {
    category: ERROR_CATEGORIES.UPSTREAM_FAULT,
    retryable: true,
    workflowAction: "retry",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "warning",
  },
  [RUNTIME_ERROR_CODES.PROVIDER_RATE_LIMIT]: {
    category: ERROR_CATEGORIES.UPSTREAM_FAULT,
    retryable: true,
    workflowAction: "retry",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "warning",
  },
  [RUNTIME_ERROR_CODES.PROVIDER_TRANSIENT_ERROR]: {
    category: ERROR_CATEGORIES.UPSTREAM_FAULT,
    retryable: true,
    workflowAction: "retry",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "warning",
  },
  [RUNTIME_ERROR_CODES.PROVIDER_REQUEST_ERROR]: {
    category: ERROR_CATEGORIES.UPSTREAM_FAULT,
    retryable: true,
    workflowAction: "retry",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "warning",
  },
  [RUNTIME_ERROR_CODES.PROVIDER_QUOTA_EXCEEDED]: {
    category: ERROR_CATEGORIES.SERVER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "error",
  },
  [RUNTIME_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE]: {
    category: ERROR_CATEGORIES.UPSTREAM_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "error",
  },

  // ── SERVER & INTERNAL FAULTS (Apology to user, zero leak of secrets) ──────
  [RUNTIME_ERROR_CODES.CREDENTIAL_ERROR]: {
    category: ERROR_CATEGORIES.SERVER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "error",
  },
  [RUNTIME_ERROR_CODES.CONFIG_INTEGRITY_ERROR]: {
    category: ERROR_CATEGORIES.SERVER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "error",
  },
  [RUNTIME_ERROR_CODES.PRICING_CONFIG_ERROR]: {
    category: ERROR_CATEGORIES.SERVER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "error",
  },
  [RUNTIME_ERROR_CODES.NO_SERVABLE_DEPLOYMENT]: {
    category: ERROR_CATEGORIES.SERVER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "error",
  },
  [RUNTIME_ERROR_CODES.UNKNOWN_MODEL_FAMILY]: {
    category: ERROR_CATEGORIES.SERVER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "error",
  },
  [RUNTIME_ERROR_CODES.UNKNOWN_OPERATION]: {
    category: ERROR_CATEGORIES.SERVER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "error",
  },
  [RUNTIME_ERROR_CODES.PROVIDER_FAILED]: {
    category: ERROR_CATEGORIES.SERVER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "error",
  },
  [RUNTIME_ERROR_CODES.OUTPUT_INVALID]: {
    category: ERROR_CATEGORIES.SERVER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "error",
  },
  [RUNTIME_ERROR_CODES.OUTPUT_CONTRACT_VIOLATION]: {
    category: ERROR_CATEGORIES.SERVER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "error",
  },
  [RUNTIME_ERROR_CODES.PERSISTENCE_FAILED]: {
    category: ERROR_CATEGORIES.SERVER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "error",
  },
  [RUNTIME_ERROR_CODES.NODE_FAILED]: {
    category: ERROR_CATEGORIES.SERVER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "error",
  },
  [RUNTIME_ERROR_CODES.ORCHESTRATION_DEADLOCK]: {
    category: ERROR_CATEGORIES.SERVER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "critical",
  },
  [RUNTIME_ERROR_CODES.INTERNAL_ERROR]: {
    category: ERROR_CATEGORIES.SERVER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "error",
  },
});

/**
 * Inspects any raw error or code string and normalizes it to a canonical RUNTIME_ERROR_CODE.
 * Also performs semantic inspection (e.g. NSFW in message, 429, timeout).
 */
export function normalizeCode(errorOrCode) {
  if (!errorOrCode) {
    return RUNTIME_ERROR_CODES.INTERNAL_ERROR;
  }

  // 1. Direct code check
  const code = typeof errorOrCode === "string" ? errorOrCode : errorOrCode?.code;
  if (code && DEFAULT_DECISIONS[code]) {
    return code;
  }

  // 2. Semantic inspection of message
  const msg = (
    typeof errorOrCode === "string"
      ? errorOrCode
      : `${errorOrCode?.message || ""} ${errorOrCode?.safeMessage || ""} ${errorOrCode?.details || ""}`
  ).toLowerCase();

  // Content safety / NSFW detection
  if (
    /nsfw|sexual|explicit|content moderation|content safety|prohibited content|safety policy|safety guideline/i.test(msg) ||
    code === "PROVIDER_CONTENT_POLICY_ERROR"
  ) {
    return RUNTIME_ERROR_CODES.CONTENT_SAFETY_VIOLATION;
  }

  // Credit / balance detection
  if (/insufficient.*credits?|not enough credits?|credit limit/i.test(msg) || code === "INSUFFICIENT_FUNDS") {
    return RUNTIME_ERROR_CODES.INSUFFICIENT_CREDITS;
  }

  // Rate limit / 429
  if (/rate.*limit|too many requests|429/i.test(msg)) {
    return RUNTIME_ERROR_CODES.PROVIDER_RATE_LIMIT;
  }

  // Timeout / 504
  if (/timed? ?out|timeout|504|gateway timeout/i.test(msg)) {
    return RUNTIME_ERROR_CODES.PROVIDER_TIMEOUT;
  }

  // Auth / Credential
  if (/unauthorized|401|api key|credentials|quota exceeded/i.test(msg)) {
    return RUNTIME_ERROR_CODES.CREDENTIAL_ERROR;
  }

  // Validation
  if (/validation|invalid input|missing required/i.test(msg)) {
    return RUNTIME_ERROR_CODES.INVALID_INPUT;
  }

  return code || RUNTIME_ERROR_CODES.INTERNAL_ERROR;
}

/**
 * Returns the complete decision object for an error.
 *
 * @param {Error|Object|string} errorOrCode
 * @returns {{
 *   code: string,
 *   category: string,
 *   retryable: boolean,
 *   workflowAction: string,
 *   billingAction: string,
 *   userMessage: string,
 *   internalMessage: string,
 *   severity: string,
 * }}
 */
export function getErrorDecision(errorOrCode) {
  const code = normalizeCode(errorOrCode);
  const decision = DEFAULT_DECISIONS[code] || {
    category: ERROR_CATEGORIES.SERVER_FAULT,
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback",
    userMessage: DEFAULT_APOLOGY_MESSAGE,
    severity: "error",
  };

  const internalMessage =
    typeof errorOrCode === "string"
      ? errorOrCode
      : errorOrCode?.message || errorOrCode?.safeMessage || code;

  // Strict Rule: If it's NOT a USER_FAULT and NOT a BILLING_FAULT, force apology message
  const isUserOrBilling =
    decision.category === ERROR_CATEGORIES.USER_FAULT ||
    decision.category === ERROR_CATEGORIES.BILLING_FAULT;

  const finalUserMessage = isUserOrBilling
    ? decision.userMessage
    : DEFAULT_APOLOGY_MESSAGE;

  return {
    code,
    category: decision.category,
    retryable: decision.retryable,
    workflowAction: decision.workflowAction,
    billingAction: decision.billingAction,
    userMessage: finalUserMessage,
    internalMessage,
    severity: decision.severity,
  };
}

/**
 * Formats a clean, secure error object to be stored in workflow_runs.error
 * and presented to clients via GET /runs/:run_id.
 *
 * @param {Error|Object|string} errorOrCode
 * @param {Object} [failedNode=null]
 * @returns {Object}
 */
export function formatWorkflowError(errorOrCode, failedNode = null) {
  const decision = getErrorDecision(errorOrCode);
  const nodeId = failedNode?.node_id || failedNode?.id || null;

  return {
    code: decision.code,
    category: decision.category,
    message: decision.userMessage,
    nodeId,
    retryable: decision.retryable,
    // Internal details for backend debugging; sanitized from user view
    internalDetails: decision.internalMessage,
  };
}

/**
 * Adapts an error into a node envelope runtime error payload.
 */
export function toRuntimeError(error, fallbackCode = RUNTIME_ERROR_CODES.INTERNAL_ERROR) {
  const code = error?.code || fallbackCode;
  const decision = getErrorDecision({ ...error, code });
  return {
    code: decision.code,
    category: decision.category,
    message: decision.userMessage,
    details: error?.details || decision.internalMessage,
    retryable: decision.retryable,
  };
}

/**
 * Sanitizes an error object before sending it to the client over HTTP.
 * Guarantees zero leakage of stack traces, database details, or provider secrets.
 *
 * - USER_FAULT: returns clean explanation of the user's issue (e.g. NSFW, invalid input).
 * - BILLING_FAULT: returns wallet top-up advice.
 * - SERVER_FAULT / UPSTREAM_FAULT: returns standard apology message. Zero secrets leaked.
 *
 * @param {Error|Object|string} errorOrCode
 * @returns {{ code: string, category: string, message: string, retryable: boolean, nodeId?: string }}
 */
export function sanitizeClientError(errorOrCode) {
  if (!errorOrCode) return null;
  const decision = getErrorDecision(errorOrCode);
  const nodeId = typeof errorOrCode === "object" ? errorOrCode?.nodeId || null : null;

  return {
    code: decision.code,
    category: decision.category,
    message: decision.userMessage,
    retryable: decision.retryable,
    ...(nodeId ? { nodeId } : {}),
  };
}

/**
 * Master Error Processor
 * ─────────────────────────────────────────────────────────────────────────────
 * Central entry point: Pass any raw error + context, and it outputs 3 clean sections:
 *
 * 1. user: What the USER sees (Frontend / Public API) - Safe & Sanitized.
 * 2. system: What the DEVELOPER sees (Internal logs / DB / Monitoring) - Full details.
 * 3. actions: Operational directives (billing rollback, retry flag, HTTP status code).
 *
 * @param {Error|Object|string} rawError
 * @param {Object} [context={}] - e.g. { nodeId, runId, userId, traceId }
 * @returns {{
 *   user: { code: string, category: string, message: string, retryable: boolean, statusCode: number, nodeId?: string },
 *   system: { rawCode: string, rawMessage: string, stack: string|null, internalDetails: string, severity: string, traceId: string|null, nodeId: string|null, timestamp: string },
 *   actions: { billingAction: "rollback"|"none", workflowAction: "stop"|"retry", retryable: boolean, shouldRefund: boolean }
 * }}
 */
export function processSystemError(rawError, context = {}) {
  const decision = getErrorDecision(rawError);
  const nodeId = context.nodeId || (typeof rawError === "object" ? rawError?.nodeId : null) || null;
  const traceId = context.traceId || context.runId || null;
  const userId = context.userId || null;

  let statusCode = 500;
  if (decision.category === ERROR_CATEGORIES.USER_FAULT) {
    statusCode = decision.code === RUNTIME_ERROR_CODES.CONTENT_SAFETY_VIOLATION ? 422 : 400;
  } else if (decision.category === ERROR_CATEGORIES.BILLING_FAULT) {
    statusCode = 402;
  } else if (decision.category === ERROR_CATEGORIES.UPSTREAM_FAULT) {
    statusCode = decision.code === RUNTIME_ERROR_CODES.PROVIDER_RATE_LIMIT ? 429 : 503;
  }

  return {
    // 1. What the USER sees (UI / Mobile / Web Client)
    user: {
      code: decision.code,
      category: decision.category,
      message: decision.userMessage,
      retryable: decision.retryable,
      statusCode,
      ...(nodeId ? { nodeId } : {}),
    },

    // 2. What the SYSTEM / DEVELOPER sees (Full internal logs & DB)
    system: {
      rawCode: typeof rawError === "object" ? rawError?.code || decision.code : decision.code,
      rawMessage: typeof rawError === "object" ? rawError?.message || String(rawError) : String(rawError),
      stack: typeof rawError === "object" && rawError?.stack ? rawError.stack : null,
      internalDetails: decision.internalMessage,
      severity: decision.severity,
      nodeId,
      traceId,
      userId,
      timestamp: new Date().toISOString(),
    },

    // 3. Operational directives for billing, workflows, and retries
    actions: {
      billingAction: decision.billingAction,
      workflowAction: decision.workflowAction,
      retryable: decision.retryable,
      shouldRefund: decision.billingAction === "rollback",
      statusCode,
    },
  };
}

export function logErrorReport(report) {
  if (!report) return;
  const level = report.system?.severity === "FATAL" || report.user?.category === "SERVER_FAULT" ? "error" : "warn";
  errorLogger[level](
    {
      errorCode: report.user?.code,
      category: report.user?.category,
      nodeId: report.system?.nodeId,
      traceId: report.system?.traceId,
      err: {
        message: report.system?.rawMessage,
        stack: report.system?.stack,
        code: report.system?.rawCode,
      },
    },
    `[${report.user?.category || "ERROR"}] ${report.user?.message || report.system?.rawMessage}`
  );
}

/**
 * Unified Error System Namespace
 */
export const ErrorSystem = Object.freeze({
  process: processSystemError,
  decide: getErrorDecision,
  sanitize: sanitizeClientError,
  formatWorkflow: formatWorkflowError,
  toEnvelope: toRuntimeError,
  logReport: logErrorReport,
  CATEGORIES: ERROR_CATEGORIES,
  CODES: RUNTIME_ERROR_CODES,
  DEFAULT_APOLOGY_MESSAGE,
});
