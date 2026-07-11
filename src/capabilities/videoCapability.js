import { MEDIA_CAPABILITIES } from "../workflows/workflowConstants.js";
import { resolveProvider } from "../providers/providerResolver.js";

export async function executeVideoCapability({ capabilityId = MEDIA_CAPABILITIES.VIDEO_GENERATION, providerPolicy = {}, request = {}, executionId = null }) {
  const { adapter, decision } = await resolveProvider({ capabilityId, policy: providerPolicy, executionId });
  const result = await adapter.execute({ ...request, capabilityId, executionId });
  return { result, decision };
}

export const videoGenerationCapability = {
  capabilityId: MEDIA_CAPABILITIES.VIDEO_GENERATION,
  execute: (input) => executeVideoCapability({ ...input, capabilityId: MEDIA_CAPABILITIES.VIDEO_GENERATION }),
};

export const videoEditingCapability = {
  capabilityId: MEDIA_CAPABILITIES.VIDEO_EDITING,
  execute: (input) => executeVideoCapability({ ...input, capabilityId: MEDIA_CAPABILITIES.VIDEO_EDITING }),
};
