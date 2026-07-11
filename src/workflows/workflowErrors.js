export class WorkflowArchitectureError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowArchitectureError";
    this.code = code;
    this.details = details;
  }
}

export function createWorkflowError(code, message, details = {}) {
  return new WorkflowArchitectureError(message, code, details);
}

export function toSafeWorkflowError(error, fallbackCode = "WORKFLOW_ERROR") {
  if (error instanceof WorkflowArchitectureError) {
    return {
      errorCode: error.code,
      message: error.message,
      details: error.details,
    };
  }

  return {
    errorCode: fallbackCode,
    message: "Workflow request could not be processed.",
  };
}

export const WORKFLOW_ERROR_CODES = Object.freeze({
  INVALID_FEATURE: "INVALID_FEATURE",
  FEATURE_DISABLED: "FEATURE_DISABLED",
  INVALID_MODE: "INVALID_MODE",
  INVALID_WORKFLOW: "INVALID_WORKFLOW",
  INVALID_WORKFLOW_DEFINITION: "INVALID_WORKFLOW_DEFINITION",
  INVALID_CAPABILITY: "INVALID_CAPABILITY",
  INVALID_PROVIDER: "INVALID_PROVIDER",
  INVALID_CALLER: "INVALID_CALLER",
});
