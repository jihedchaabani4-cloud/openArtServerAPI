import { MEDIA_CAPABILITIES } from "../workflows/workflowConstants.js";
import { createWorkflowError, WORKFLOW_ERROR_CODES } from "../workflows/workflowErrors.js";

const allowedCapabilities = new Set(Object.values(MEDIA_CAPABILITIES));

export function normalizeProviderHealth(value) {
  if (typeof value === "boolean") return { healthy: value };
  return {
    healthy: Boolean(value?.healthy),
    reason: value?.reason || null,
  };
}

export function validateProviderAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw createWorkflowError(WORKFLOW_ERROR_CODES.INVALID_PROVIDER, "Provider adapter must be an object.");
  }

  if (!adapter.providerId || typeof adapter.providerId !== "string") {
    throw createWorkflowError(WORKFLOW_ERROR_CODES.INVALID_PROVIDER, "Provider adapter requires providerId.");
  }

  for (const method of ["supportedCapabilities", "isHealthy", "estimateCost", "estimateLatency", "execute"]) {
    if (typeof adapter[method] !== "function") {
      throw createWorkflowError(
        WORKFLOW_ERROR_CODES.INVALID_PROVIDER,
        `Provider adapter "${adapter.providerId}" requires ${method}().`
      );
    }
  }

  const capabilities = adapter.supportedCapabilities();
  if (!Array.isArray(capabilities) || capabilities.some((capability) => !allowedCapabilities.has(capability))) {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_PROVIDER,
      `Provider adapter "${adapter.providerId}" exposes invalid capabilities.`
    );
  }

  return adapter;
}

export function createStaticProviderAdapter({
  providerId,
  capabilities,
  healthy = true,
  cost = 1,
  latencyMs = 1000,
  qualityTier = "standard",
  execute = async () => ({ outputs: [], providerId }),
}) {
  return validateProviderAdapter({
    providerId,
    qualityTier,
    supportedCapabilities: () => capabilities,
    isHealthy: async () => normalizeProviderHealth(healthy),
    estimateCost: async () => ({ amount: Number(cost) || 0, unit: "credits" }),
    estimateLatency: async () => ({ p50Ms: Number(latencyMs) || 0, p95Ms: Number(latencyMs) || 0 }),
    execute,
  });
}
