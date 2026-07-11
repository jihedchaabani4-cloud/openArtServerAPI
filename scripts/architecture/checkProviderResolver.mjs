import { MEDIA_CAPABILITIES } from "../../src/workflows/workflowConstants.js";
import { clearProviderRegistry, registerProviders } from "../../src/providers/providerRegistry.js";
import { resolveProvider } from "../../src/providers/providerResolver.js";
import { createProviderResolverFixtures } from "./providerResolverFixtures.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

clearProviderRegistry();
registerProviders(createProviderResolverFixtures());

const lowest = await resolveProvider({
  capabilityId: MEDIA_CAPABILITIES.IMAGE_GENERATION,
  policy: { provider: "auto", costPreference: "lowest", allowFailover: true },
  executionId: "fixture-lowest",
});
assert(lowest.decision.selectedProvider === "healthy-low-cost", "Expected lowest-cost healthy provider.");
assert(!lowest.decision.eligibleProviders.includes("unhealthy-provider"), "Unhealthy provider must not be eligible.");
assert(lowest.decision.fallbackChain.length > 0, "Expected fallback chain when failover is allowed.");

const fastest = await resolveProvider({
  capabilityId: MEDIA_CAPABILITIES.VIDEO_GENERATION,
  policy: { provider: "auto", latencyPreference: "fastest", allowFailover: true },
  executionId: "fixture-fastest",
});
assert(fastest.decision.selectedProvider === "healthy-fast", "Expected fastest healthy provider.");

const premium = await resolveProvider({
  capabilityId: MEDIA_CAPABILITIES.IMAGE_GENERATION,
  policy: { provider: "auto", qualityTier: "premium", allowFailover: false },
  executionId: "fixture-premium",
});
assert(premium.decision.selectedProvider === "healthy-premium", "Expected premium provider.");
assert(premium.decision.fallbackChain.length === 0, "Fallback chain should be empty when failover is disabled.");

console.log("[checkProviderResolver] PASS");
process.exit(0);
