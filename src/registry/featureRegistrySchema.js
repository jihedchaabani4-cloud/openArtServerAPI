import { FEATURE_STATUSES, MEDIA_CAPABILITIES } from "../workflows/workflowConstants.js";
import { createWorkflowError, WORKFLOW_ERROR_CODES } from "../workflows/workflowErrors.js";

const allowedFeatureStatuses = new Set(Object.values(FEATURE_STATUSES));
const allowedCapabilities = new Set(Object.values(MEDIA_CAPABILITIES));

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_FEATURE,
      `${label} must be a plain object.`
    );
  }
}

export function validateFeatureRegistryEntry(entry) {
  assertPlainObject(entry, "Feature registry entry");

  if (!entry.featureId || typeof entry.featureId !== "string") {
    throw createWorkflowError(WORKFLOW_ERROR_CODES.INVALID_FEATURE, "Feature entry requires featureId.");
  }

  if (!entry.label || typeof entry.label !== "string") {
    throw createWorkflowError(WORKFLOW_ERROR_CODES.INVALID_FEATURE, `Feature "${entry.featureId}" requires label.`);
  }

  if (!Array.isArray(entry.supportedModes) || entry.supportedModes.length === 0) {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_FEATURE,
      `Feature "${entry.featureId}" requires at least one supported mode.`
    );
  }

  assertPlainObject(entry.workflows, `Feature "${entry.featureId}" workflows`);

  if (!entry.defaultWorkflow || typeof entry.defaultWorkflow !== "string") {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_FEATURE,
      `Feature "${entry.featureId}" requires defaultWorkflow.`
    );
  }

  if (!Object.values(entry.workflows).includes(entry.defaultWorkflow)) {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_FEATURE,
      `Feature "${entry.featureId}" defaultWorkflow must be present in workflows.`
    );
  }

  if (!allowedCapabilities.has(entry.capability)) {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_CAPABILITY,
      `Feature "${entry.featureId}" uses unsupported capability "${entry.capability}".`
    );
  }

  if (!allowedFeatureStatuses.has(entry.status)) {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_FEATURE,
      `Feature "${entry.featureId}" uses unsupported status "${entry.status}".`
    );
  }

  return entry;
}

export function assertRegistryEntryIsMetadataOnly(entry) {
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value === "function") {
      throw createWorkflowError(
        WORKFLOW_ERROR_CODES.INVALID_FEATURE,
        `Feature "${entry.featureId}" contains executable property "${key}".`
      );
    }
  }
}
