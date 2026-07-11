import { MEDIA_CAPABILITIES } from "../workflows/workflowConstants.js";
import { resolveProvider } from "../providers/providerResolver.js";

export async function executeImageCapability({ capabilityId = MEDIA_CAPABILITIES.IMAGE_GENERATION, providerPolicy = {}, request = {}, executionId = null }) {
  const { adapter, decision } = await resolveProvider({ capabilityId, policy: providerPolicy, executionId });
  const result = await adapter.execute({ ...request, capabilityId, executionId });
  return { result, decision };
}

export const imageGenerationCapability = {
  capabilityId: MEDIA_CAPABILITIES.IMAGE_GENERATION,
  execute: (input) => executeImageCapability({ ...input, capabilityId: MEDIA_CAPABILITIES.IMAGE_GENERATION }),
};

export const imageEditingCapability = {
  capabilityId: MEDIA_CAPABILITIES.IMAGE_EDITING,
  execute: (input) => executeImageCapability({ ...input, capabilityId: MEDIA_CAPABILITIES.IMAGE_EDITING }),
};
