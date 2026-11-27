/**
 * System 9: Workflow Engine — Neutral Typed Error Hierarchy.
 *
 * Domain-agnostic and billing-agnostic errors extending AppError from #shared.
 * Zero credit/refund copy: billable domain systems (e.g., Generation) format
 * client-facing refund phrasing at their own seam.
 */
import { AppError } from "#shared";

export class WorkflowEngineError extends AppError {
  constructor(codeOrMessage = "WORKFLOW_ENGINE_ERROR", messageOrOptions = "Workflow engine error", opts = {}) {
    if (typeof codeOrMessage === "object" && codeOrMessage !== null) {
      const {
        code = "WORKFLOW_ENGINE_ERROR",
        message = "Workflow engine error",
        userMessage = null,
        status = 500,
        statusCode = status,
        isInternal = false,
        type = "OPERATIONAL",
        category = isInternal ? "SERVER_FAULT" : "USER_FAULT",
        retryable = false,
        billingAction = "NONE",
        context = {},
      } = codeOrMessage;

      super(code, message, {
        type,
        category,
        statusCode,
        retryable,
        billingAction,
        context,
      });
      this.name = this.constructor.name;
      this.code = code;
      this.errorCode = code;
      this.status = statusCode;
      this.statusCode = statusCode;
      this.isInternal = isInternal;
      this.userMessage = userMessage;
      return;
    }

    let code = "WORKFLOW_ENGINE_ERROR";
    let message = "Workflow engine error";
    let options = {};

    if (typeof messageOrOptions === "string") {
      code = codeOrMessage;
      message = messageOrOptions;
      options = opts || {};
    } else if (typeof messageOrOptions === "number") {
      message = codeOrMessage;
      options = { statusCode: messageOrOptions, ...(opts || {}) };
    } else if (typeof messageOrOptions === "object" && messageOrOptions !== null) {
      message = codeOrMessage;
      options = messageOrOptions;
    } else {
      message = codeOrMessage;
    }

    const statusCode = options.statusCode || 500;
    super(code, message, {
      type: options.type || "OPERATIONAL",
      category: options.category || "SERVER_FAULT",
      statusCode,
      retryable: options.retryable || false,
      billingAction: options.billingAction || "NONE",
      context: options.context || {},
    });
    this.name = this.constructor.name;
    this.code = code;
    this.errorCode = code;
    this.status = statusCode;
    this.isInternal = Boolean(options.isInternal);
    if (options.userMessage !== undefined) {
      this.userMessage = options.userMessage;
    }
  }
}

export class WorkflowValidationError extends WorkflowEngineError {
  constructor(message = "Invalid workflow parameters", { field = null, code = "WORKFLOW_VALIDATION_ERROR", context = {} } = {}) {
    super(code, message, {
      type: "OPERATIONAL",
      category: "USER_FAULT",
      statusCode: 400,
      retryable: false,
      billingAction: "NONE",
      context: { field, ...context },
    });
    this.name = "WorkflowValidationError";
    this.code = code;
    this.errorCode = code;
    this.safeMessage = message;
    this.field = field;
  }
}

export class WorkflowNotFoundError extends WorkflowEngineError {
  constructor(message = "Workflow resource not found", { resourceId = null, code = "WORKFLOW_NOT_FOUND", context = {} } = {}) {
    super(code, message, {
      type: "OPERATIONAL",
      category: "USER_FAULT",
      statusCode: 404,
      retryable: false,
      billingAction: "NONE",
      context: { resourceId, ...context },
    });
    this.name = "WorkflowNotFoundError";
    this.code = code;
    this.errorCode = code;
    this.safeMessage = message;
    this.resourceId = resourceId;
  }
}

export class WorkflowCompilationError extends WorkflowEngineError {
  constructor(message = "Workflow compilation failed", { errors = [], context = {} } = {}) {
    super("WORKFLOW_COMPILATION_FAILED", message, {
      type: "OPERATIONAL",
      category: "USER_FAULT",
      statusCode: 422,
      retryable: false,
      billingAction: "NONE",
      context: { errors, ...context },
    });
    this.name = "WorkflowCompilationError";
    this.errorCode = "COMPILATION_FAILED";
    this.errors = errors;
  }
}

export class WorkflowUpstreamError extends WorkflowEngineError {
  constructor(
    message = "Upstream provider error",
    {
      code = "WORKFLOW_UPSTREAM_ERROR",
      category = "UPSTREAM_FAULT",
      statusCode = 502,
      retryable = true,
      context = {},
    } = {}
  ) {
    super(code, message, {
      type: "OPERATIONAL",
      category,
      statusCode,
      retryable,
      billingAction: "NONE",
      context,
    });
    this.name = "WorkflowUpstreamError";
    this.code = code;
    this.errorCode = code;
  }
}

export class WorkflowSafetyError extends WorkflowValidationError {
  constructor(message = "Input violates content safety policy", { field = "prompt", context = {} } = {}) {
    super(message, {
      field,
      code: "CONTENT_SAFETY_VIOLATION",
      context: { is_safe: false, safety_reason: message, ...context },
    });
    this.name = "WorkflowSafetyError";
    this.code = "CONTENT_SAFETY_VIOLATION";
    this.errorCode = "CONTENT_SAFETY_VIOLATION";
    this.category = "USER_FAULT";
    this.safetyCategory = "CONTENT_SAFETY_VIOLATION";
    this.statusCode = 422;
    this.status = 422;
    this.retryable = false;
    this.is_safe = false;
    this.safeMessage = message;
    this.userMessage = message;
  }
}

export default {
  WorkflowEngineError,
  WorkflowValidationError,
  WorkflowNotFoundError,
  WorkflowCompilationError,
  WorkflowUpstreamError,
  WorkflowSafetyError,
};
