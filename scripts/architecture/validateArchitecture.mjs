import "../../src/workflows/registerWorkflows.js";
import "../../src/registry/registerFeatures.js";
import { listFeatures, resolveFeatureWorkflow, FIRST_SLICE_FEATURE_IDS } from "../../src/registry/featureRegistry.js";
import { listWorkflows, requireWorkflow } from "../../src/workflows/workflowRegistry.js";
import { listCapabilities, requireCapability } from "../../src/capabilities/capabilityRegistry.js";
import { FEATURE_STATUSES, WORKFLOW_STEP_TYPES } from "../../src/workflows/workflowConstants.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function validateMetadataOnlyFeatures() {
  for (const feature of listFeatures()) {
    for (const [key, value] of Object.entries(feature)) {
      assert(typeof value !== "function", `Feature ${feature.featureId} contains executable property ${key}.`);
    }
  }
}

function validateFeatureWorkflowReferences() {
  for (const feature of listFeatures()) {
    for (const workflowId of Object.values(feature.workflows)) {
      requireWorkflow(workflowId);
    }
  }
}

function validateWorkflowCapabilities() {
  for (const workflow of listWorkflows()) {
    for (const step of workflow.steps) {
      if (step.type === WORKFLOW_STEP_TYPES.CAPABILITY) {
        requireCapability(step.capabilityId);
      }
    }
  }
}

function validateDisabledFeatureHandling() {
  const disabledImage = listFeatures().find((feature) => feature.featureId === FIRST_SLICE_FEATURE_IDS.IMAGE);
  assert(disabledImage?.status === FEATURE_STATUSES.DISABLED, "First-slice image feature should start disabled.");

  let rejected = false;
  try {
    resolveFeatureWorkflow(FIRST_SLICE_FEATURE_IDS.IMAGE, "default");
  } catch (error) {
    rejected = error.code === "FEATURE_DISABLED";
  }
  assert(rejected, "Disabled feature should reject default resolution without allowDisabled.");

  const allowed = resolveFeatureWorkflow(FIRST_SLICE_FEATURE_IDS.IMAGE, "default", { allowDisabled: true });
  assert(allowed.workflowId === "first-slice-image-generation", "Disabled feature should resolve with allowDisabled.");
}

function main() {
  assert(listFeatures().length >= 2, "Expected first-slice features to be registered.");
  assert(listWorkflows().length >= 2, "Expected first-slice workflows to be registered.");
  assert(listCapabilities().length === 4, "Expected four media capabilities.");
  validateMetadataOnlyFeatures();
  validateFeatureWorkflowReferences();
  validateWorkflowCapabilities();
  validateDisabledFeatureHandling();
  console.log("[architecture:validate] PASS");
}

main();
