import { FEATURE_STATUSES, MEDIA_CAPABILITIES, createWorkflowError, WORKFLOW_ERROR_CODES } from "../v2/constants/workflowConstants.js";
import { validateFeatureRegistryEntry, assertRegistryEntryIsMetadataOnly } from "./featureRegistrySchema.js";

const entries = new Map();

export const FIRST_SLICE_FEATURE_IDS = Object.freeze({
  IMAGE: "first-slice-image-generation",
  VIDEO: "first-slice-video-generation",
});

export const firstSliceFeatureEntries = [
  {
    featureId: FIRST_SLICE_FEATURE_IDS.IMAGE,
    label: "First Slice Image Generation",
    supportedModes: ["default", "text-to-image"],
    workflows: {
      default: "first-slice-image-generation",
      "text-to-image": "first-slice-image-generation",
    },
    defaultWorkflow: "first-slice-image-generation",
    capability: MEDIA_CAPABILITIES.IMAGE_GENERATION,
    accessPolicy: { minPlan: "free" },
    presentationMetadata: { source: "architecture-first-slice" },
    status: FEATURE_STATUSES.DISABLED,
  },
  {
    featureId: FIRST_SLICE_FEATURE_IDS.VIDEO,
    label: "First Slice Video Generation",
    supportedModes: ["default", "text-to-video"],
    workflows: {
      default: "first-slice-video-generation",
      "text-to-video": "first-slice-video-generation",
    },
    defaultWorkflow: "first-slice-video-generation",
    capability: MEDIA_CAPABILITIES.VIDEO_GENERATION,
    accessPolicy: { minPlan: "free" },
    presentationMetadata: { source: "architecture-first-slice" },
    status: FEATURE_STATUSES.DISABLED,
  },
];

export function registerFeature(entry, { replace = false } = {}) {
  const normalized = validateFeatureRegistryEntry(entry);
  assertRegistryEntryIsMetadataOnly(normalized);

  if (entries.has(normalized.featureId) && !replace) {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_FEATURE,
      `Feature "${normalized.featureId}" is already registered.`
    );
  }

  entries.set(normalized.featureId, Object.freeze({ ...normalized }));
  return getFeature(normalized.featureId);
}

export function registerFeatures(featureEntries, options = {}) {
  return featureEntries.map((entry) => registerFeature(entry, options));
}

export function getFeature(featureId) {
  return entries.get(featureId) || null;
}

export function listFeatures({ includeDisabled = true } = {}) {
  return Array.from(entries.values()).filter(
    (entry) => includeDisabled || entry.status !== FEATURE_STATUSES.DISABLED
  );
}

export function resolveFeatureWorkflow(featureId, mode = "default", { allowDisabled = false } = {}) {
  const entry = getFeature(featureId);
  if (!entry) {
    throw createWorkflowError(WORKFLOW_ERROR_CODES.INVALID_FEATURE, `Unknown feature "${featureId}".`, {
      featureId,
    });
  }

  if (entry.status === FEATURE_STATUSES.DISABLED && !allowDisabled) {
    throw createWorkflowError(WORKFLOW_ERROR_CODES.FEATURE_DISABLED, `Feature "${featureId}" is disabled.`, {
      featureId,
    });
  }

  const selectedMode = mode || "default";
  const workflowId = entry.workflows[selectedMode];

  if (!workflowId) {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_MODE,
      `Feature "${featureId}" does not support mode "${selectedMode}".`,
      { featureId, mode: selectedMode, supportedModes: entry.supportedModes }
    );
  }

  return {
    feature: entry,
    mode: selectedMode,
    workflowId,
  };
}

export function clearFeatureRegistry() {
  entries.clear();
}

registerFeatures(firstSliceFeatureEntries, { replace: true });
