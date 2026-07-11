import { resolveProvider } from "../../providers/providerResolver.js";
import { getProvider } from "../../providers/providerRegistry.js";

/**
 * Resolves a provider adapter for execution, allowing forced provider overrides (e.g. for fallback).
 * @param {Object} request Includes capabilityId, executionId
 * @param {Object} policy Cost, latency, quality preferences
 * @param {string} [forceProvider] Bypass normal selection and force this provider ID
 * @returns {Promise<{ adapter: Object, decision: Object }>}
 */
export async function selectProvider(request, policy = {}, forceProvider = null) {
  const finalForceProvider = forceProvider || request?.forceProvider || policy?.provider;

  if (finalForceProvider && finalForceProvider !== "auto") {
    const adapter = getProvider(finalForceProvider);
    if (!adapter) {
      throw new Error(`Forced provider "${finalForceProvider}" not found in registry.`);
    }

    const capabilityId = request?.capabilityId || "IMAGE_GENERATION";
    const executionId = request?.executionId || null;

    return {
      adapter,
      decision: {
        decisionId: `${executionId || "execution"}:${capabilityId}:${Date.now()}`,
        executionId,
        capabilityId,
        selectedProvider: finalForceProvider,
        forcedFallback: true,
        selectionReasons: ["forced provider override"],
        eligibleProviders: [finalForceProvider],
        fallbackChain: [],
        rejectedProviders: []
      }
    };
  }

  return resolveProvider({
    capabilityId: request?.capabilityId,
    policy,
    executionId: request?.executionId
  });
}
