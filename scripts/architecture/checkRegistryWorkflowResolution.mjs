import "../../src/workflows/registerWorkflows.js";
import "../../src/registry/registerFeatures.js";
import { FIRST_SLICE_FEATURE_IDS } from "../../src/registry/featureRegistry.js";
import { resolveFeatureWorkflowSafe } from "../../src/workflows/featureWorkflowResolver.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const image = resolveFeatureWorkflowSafe({
  featureId: FIRST_SLICE_FEATURE_IDS.IMAGE,
  mode: "text-to-image",
  allowDisabled: true,
});

assert(image.ok, `Image feature should resolve: ${image.error?.message || ""}`);
assert(image.value.workflow.workflowId === "first-slice-image-generation", "Image workflow mismatch.");

const video = resolveFeatureWorkflowSafe({
  featureId: FIRST_SLICE_FEATURE_IDS.VIDEO,
  mode: "text-to-video",
  allowDisabled: true,
});

assert(video.ok, `Video feature should resolve: ${video.error?.message || ""}`);
assert(video.value.workflow.workflowId === "first-slice-video-generation", "Video workflow mismatch.");

const unknown = resolveFeatureWorkflowSafe({ featureId: "missing-feature", mode: "default" });
assert(!unknown.ok && unknown.error.errorCode === "INVALID_FEATURE", "Unknown feature should return safe INVALID_FEATURE.");

const disabled = resolveFeatureWorkflowSafe({ featureId: FIRST_SLICE_FEATURE_IDS.IMAGE, mode: "default" });
assert(!disabled.ok && disabled.error.errorCode === "FEATURE_DISABLED", "Disabled feature should return safe FEATURE_DISABLED.");

console.log("[checkRegistryWorkflowResolution] PASS");
process.exit(0);
