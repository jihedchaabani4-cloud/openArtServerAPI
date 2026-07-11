import { createWorkflowError, WORKFLOW_ERROR_CODES } from "../workflows/workflowErrors.js";
import { listProvidersForCapability, getProvider } from "./providerRegistry.js";

const QUALITY_RANK = {
  free: 0,
  standard: 1,
  pro: 2,
  premium: 3,
};

function qualityRank(tier = "standard") {
  return QUALITY_RANK[String(tier).toLowerCase()] ?? 1;
}

function sortCandidates(candidates, policy) {
  return candidates.sort((a, b) => {
    if (policy.qualityTier && qualityRank(b.qualityTier) !== qualityRank(a.qualityTier)) {
      return qualityRank(b.qualityTier) - qualityRank(a.qualityTier);
    }

    if (policy.latencyPreference === "fastest" && a.latencyMs !== b.latencyMs) {
      return a.latencyMs - b.latencyMs;
    }

    if (policy.costPreference === "lowest" && a.cost !== b.cost) {
      return a.cost - b.cost;
    }

    return a.score - b.score;
  });
}

export async function resolveProvider({ capabilityId, policy = {}, executionId = null }) {
  const requestedProvider = policy.provider && policy.provider !== "auto" ? getProvider(policy.provider) : null;
  const pool = requestedProvider ? [requestedProvider] : listProvidersForCapability(capabilityId);

  if (pool.length === 0) {
    throw createWorkflowError(WORKFLOW_ERROR_CODES.INVALID_PROVIDER, `No providers support capability "${capabilityId}".`);
  }

  const candidates = [];
  const rejected = [];

  for (const adapter of pool) {
    const health = await adapter.isHealthy();
    const costEstimate = await adapter.estimateCost({ capabilityId, executionId });
    const latencyEstimate = await adapter.estimateLatency({ capabilityId, executionId });
    const cost = Number(costEstimate.amount) || 0;
    const latencyMs = Number(latencyEstimate.p95Ms ?? latencyEstimate.p50Ms ?? 0) || 0;
    const qualityTier = adapter.qualityTier || "standard";

    if (!health.healthy) {
      rejected.push({ providerId: adapter.providerId, reason: health.reason || "unhealthy" });
      continue;
    }

    if (policy.qualityTier && qualityRank(qualityTier) < qualityRank(policy.qualityTier)) {
      rejected.push({ providerId: adapter.providerId, reason: `quality tier below ${policy.qualityTier}` });
      continue;
    }

    candidates.push({
      adapter,
      providerId: adapter.providerId,
      cost,
      latencyMs,
      qualityTier,
      score: cost + latencyMs / 1000 - qualityRank(qualityTier),
    });
  }

  if (candidates.length === 0) {
    throw createWorkflowError(WORKFLOW_ERROR_CODES.INVALID_PROVIDER, "No healthy provider candidates available.", {
      capabilityId,
      rejected,
    });
  }

  const ordered = sortCandidates(candidates, policy);
  const selected = ordered[0];

  return {
    adapter: selected.adapter,
    decision: {
      decisionId: `${executionId || "execution"}:${capabilityId}:${Date.now()}`,
      executionId,
      capabilityId,
      eligibleProviders: candidates.map((candidate) => candidate.providerId),
      selectedProvider: selected.providerId,
      selectionReasons: [
        "healthy",
        `cost=${selected.cost}`,
        `latencyMs=${selected.latencyMs}`,
        `qualityTier=${selected.qualityTier}`,
      ],
      fallbackChain: policy.allowFailover === false ? [] : ordered.slice(1).map((candidate) => candidate.providerId),
      rejectedProviders: rejected,
    },
  };
}
