import { resolveTreatment } from "../treatments/treatmentRegistry.js";
import { createWorkflowError, WORKFLOW_ERROR_CODES } from "./workflowErrors.js";

export function resolveProcessingStep(stepId, deps) {
  try {
    return resolveTreatment(stepId, deps);
  } catch (error) {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_WORKFLOW_DEFINITION,
      `Unknown processing step "${stepId}".`,
      { stepId, cause: error.message }
    );
  }
}

export function canResolveProcessingStep(stepId, deps) {
  try {
    resolveProcessingStep(stepId, deps);
    return true;
  } catch {
    return false;
  }
}
