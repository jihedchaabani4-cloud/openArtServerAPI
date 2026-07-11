import "../workflows/registerWorkflows.js";
import "../registry/registerFeatures.js";
import { resolveFeatureWorkflow } from "../registry/featureRegistry.js";
import { requireWorkflow } from "./workflowRegistry.js";
import { toSafeWorkflowError } from "./workflowErrors.js";

export function resolveFeatureWorkflowRequest({ featureId, mode = "default", allowDisabled = false }) {
  const resolution = resolveFeatureWorkflow(featureId, mode, { allowDisabled });
  const workflow = requireWorkflow(resolution.workflowId);

  return {
    ...resolution,
    workflow,
  };
}

export function resolveFeatureWorkflowSafe(input) {
  try {
    return {
      ok: true,
      value: resolveFeatureWorkflowRequest(input),
    };
  } catch (error) {
    return {
      ok: false,
      error: toSafeWorkflowError(error),
    };
  }
}
