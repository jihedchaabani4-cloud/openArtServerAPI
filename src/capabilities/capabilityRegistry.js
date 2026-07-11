import { MEDIA_CAPABILITIES } from "../workflows/workflowConstants.js";
import { createWorkflowError, WORKFLOW_ERROR_CODES } from "../workflows/workflowErrors.js";
import { imageEditingCapability, imageGenerationCapability } from "./imageCapability.js";
import { videoEditingCapability, videoGenerationCapability } from "./videoCapability.js";

const capabilities = new Map();

export function registerCapability(capabilityId, capability) {
  if (!Object.values(MEDIA_CAPABILITIES).includes(capabilityId)) {
    throw createWorkflowError(WORKFLOW_ERROR_CODES.INVALID_CAPABILITY, `Unsupported capability "${capabilityId}".`);
  }

  capabilities.set(capabilityId, Object.freeze({ capabilityId, ...capability }));
  return getCapability(capabilityId);
}

export function getCapability(capabilityId) {
  return capabilities.get(capabilityId) || null;
}

export function requireCapability(capabilityId) {
  const capability = getCapability(capabilityId);
  if (!capability) {
    throw createWorkflowError(WORKFLOW_ERROR_CODES.INVALID_CAPABILITY, `Capability "${capabilityId}" is not registered.`);
  }
  return capability;
}

export function listCapabilities() {
  return Array.from(capabilities.values());
}

export function registerDefaultCapabilities() {
  registerCapability(MEDIA_CAPABILITIES.IMAGE_GENERATION, imageGenerationCapability);
  registerCapability(MEDIA_CAPABILITIES.IMAGE_EDITING, imageEditingCapability);
  registerCapability(MEDIA_CAPABILITIES.VIDEO_GENERATION, videoGenerationCapability);
  registerCapability(MEDIA_CAPABILITIES.VIDEO_EDITING, videoEditingCapability);
}

registerDefaultCapabilities();
