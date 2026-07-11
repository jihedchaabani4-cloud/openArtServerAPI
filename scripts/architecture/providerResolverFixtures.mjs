import { MEDIA_CAPABILITIES } from "../../src/workflows/workflowConstants.js";
import { createStaticProviderAdapter } from "../../src/providers/providerAdapterContract.js";

export function createProviderResolverFixtures() {
  return [
    createStaticProviderAdapter({
      providerId: "healthy-low-cost",
      capabilities: [MEDIA_CAPABILITIES.IMAGE_GENERATION, MEDIA_CAPABILITIES.VIDEO_GENERATION],
      cost: 3,
      latencyMs: 1500,
      qualityTier: "standard",
    }),
    createStaticProviderAdapter({
      providerId: "healthy-fast",
      capabilities: [MEDIA_CAPABILITIES.IMAGE_GENERATION, MEDIA_CAPABILITIES.VIDEO_GENERATION],
      cost: 6,
      latencyMs: 200,
      qualityTier: "standard",
    }),
    createStaticProviderAdapter({
      providerId: "healthy-premium",
      capabilities: [MEDIA_CAPABILITIES.IMAGE_GENERATION, MEDIA_CAPABILITIES.VIDEO_GENERATION],
      cost: 12,
      latencyMs: 700,
      qualityTier: "premium",
    }),
    createStaticProviderAdapter({
      providerId: "unhealthy-provider",
      capabilities: [MEDIA_CAPABILITIES.IMAGE_GENERATION, MEDIA_CAPABILITIES.VIDEO_GENERATION],
      healthy: { healthy: false, reason: "fixture outage" },
      cost: 1,
      latencyMs: 100,
      qualityTier: "premium",
    }),
  ];
}
