import { MEDIA_CAPABILITIES } from "../../v2/constants/workflowConstants.js";
import { createStaticProviderAdapter } from "../providerAdapterContract.js";

export function createVideoRunnerProviderAdapter({
  providerId,
  runner = null,
  capabilities = [MEDIA_CAPABILITIES.VIDEO_GENERATION, MEDIA_CAPABILITIES.VIDEO_EDITING],
  cost = 20,
  latencyMs = 5000,
  qualityTier = "standard",
  healthy = true,
} = {}) {
  return createStaticProviderAdapter({
    providerId,
    capabilities,
    cost,
    latencyMs,
    qualityTier,
    healthy,
    execute: async (request) => {
      if (runner && typeof runner.execute === "function") {
        return runner.execute(request);
      }
      if (runner && typeof runner.run === "function") {
        return runner.run(request);
      }
      if (runner && typeof runner.generate === "function") {
        return runner.generate(request);
      }
      return {
        providerId,
        capabilityId: request.capabilityId,
        outputs: [],
        status: "adapter-ready",
      };
    },
  });
}
