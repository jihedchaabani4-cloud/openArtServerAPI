import { validateWorkflowDefinition } from "./workflowDefinitionSchema.js";
import { createWorkflowError, WORKFLOW_ERROR_CODES } from "./workflowErrors.js";

const definitions = new Map();

export function registerWorkflow(definition, { replace = false } = {}) {
  const normalized = validateWorkflowDefinition(definition);

  if (definitions.has(normalized.workflowId) && !replace) {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_WORKFLOW,
      `Workflow "${normalized.workflowId}" is already registered.`
    );
  }

  definitions.set(normalized.workflowId, Object.freeze(normalized));
  return getWorkflow(normalized.workflowId);
}

export function registerWorkflows(workflowDefinitions, options = {}) {
  return workflowDefinitions.map((definition) => registerWorkflow(definition, options));
}

export function getWorkflow(workflowId) {
  return definitions.get(workflowId) || null;
}

export function requireWorkflow(workflowId) {
  const workflow = getWorkflow(workflowId);
  if (!workflow) {
    throw createWorkflowError(WORKFLOW_ERROR_CODES.INVALID_WORKFLOW, `Unknown workflow "${workflowId}".`, {
      workflowId,
    });
  }
  return workflow;
}

export function listWorkflows() {
  return Array.from(definitions.values());
}

export function clearWorkflowRegistry() {
  definitions.clear();
}
