import { CALLER_TYPES } from "./workflowConstants.js";
import { createWorkflowError, WORKFLOW_ERROR_CODES } from "./workflowErrors.js";

export function normalizeWorkflowRunInput({ workflowId, caller, input = {}, mode = "default", orchestrationContext = {}, async = false }) {
  if (!workflowId || typeof workflowId !== "string") {
    throw createWorkflowError(WORKFLOW_ERROR_CODES.INVALID_WORKFLOW, "workflowId is required.");
  }

  const callerType = caller?.type || CALLER_TYPES.INTERNAL;
  if (!Object.values(CALLER_TYPES).includes(callerType)) {
    throw createWorkflowError(WORKFLOW_ERROR_CODES.INVALID_CALLER, `Unsupported caller type "${callerType}".`);
  }

  return {
    workflowId,
    caller: {
      type: callerType,
      traceId: caller?.traceId || null,
      userId: caller?.userId || input.userId || null,
    },
    input: input || {},
    mode: mode || "default",
    orchestrationContext: orchestrationContext || {},
    async: Boolean(async),
  };
}

export function normalizeWorkflowRunResult(result) {
  return {
    executionId: result.executionId,
    status: result.status,
    jobReference: result.jobReference || null,
    mediaAssets: result.mediaAssets || [],
    error: result.error || null,
    currentContext: result.currentContext || null,
  };
}
