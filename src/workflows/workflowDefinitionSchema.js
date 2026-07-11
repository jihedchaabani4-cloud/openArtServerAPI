import {
  DEFAULT_ASYNC_AFTER_SECONDS,
  MEDIA_CAPABILITIES,
  WORKFLOW_STEP_TYPES,
} from "./workflowConstants.js";
import { createWorkflowError, WORKFLOW_ERROR_CODES } from "./workflowErrors.js";

const allowedStepTypes = new Set(Object.values(WORKFLOW_STEP_TYPES));
const allowedCapabilities = new Set(Object.values(MEDIA_CAPABILITIES));

export function validateWorkflowDefinition(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw createWorkflowError(WORKFLOW_ERROR_CODES.INVALID_WORKFLOW_DEFINITION, "Workflow definition must be an object.");
  }

  if (!definition.workflowId || typeof definition.workflowId !== "string") {
    throw createWorkflowError(WORKFLOW_ERROR_CODES.INVALID_WORKFLOW_DEFINITION, "Workflow definition requires workflowId.");
  }

  if (!definition.version || typeof definition.version !== "string") {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_WORKFLOW_DEFINITION,
      `Workflow "${definition.workflowId}" requires version.`
    );
  }

  if (!Array.isArray(definition.steps) || definition.steps.length === 0) {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_WORKFLOW_DEFINITION,
      `Workflow "${definition.workflowId}" requires at least one step.`
    );
  }

  for (const [index, step] of definition.steps.entries()) {
    validateWorkflowStep(step, definition.workflowId, index);
  }

  return {
    inputSchemaId: `${definition.workflowId}.input`,
    resultSchemaId: `${definition.workflowId}.result`,
    lifecyclePolicy: {
      asyncRequiredAfterSeconds: DEFAULT_ASYNC_AFTER_SECONDS,
      retryableFailureCodes: [],
      terminalFailureCodes: [],
      ...(definition.lifecyclePolicy || {}),
    },
    ...definition,
  };
}

export function validateWorkflowStep(step, workflowId, index) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_WORKFLOW_DEFINITION,
      `Workflow "${workflowId}" step ${index} must be an object.`
    );
  }

  if (!allowedStepTypes.has(step.type)) {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_WORKFLOW_DEFINITION,
      `Workflow "${workflowId}" step ${index} uses invalid type "${step.type}".`
    );
  }

  if (step.type === WORKFLOW_STEP_TYPES.PROCESSING_STEP && !step.stepId) {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_WORKFLOW_DEFINITION,
      `Workflow "${workflowId}" processing step ${index} requires stepId.`
    );
  }

  if (step.type === WORKFLOW_STEP_TYPES.CAPABILITY && !allowedCapabilities.has(step.capabilityId)) {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_CAPABILITY,
      `Workflow "${workflowId}" capability step ${index} uses invalid capability "${step.capabilityId}".`
    );
  }
}
