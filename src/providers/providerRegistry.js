import { validateProviderAdapter } from "./providerAdapterContract.js";
import { createWorkflowError, WORKFLOW_ERROR_CODES } from "../workflows/workflowErrors.js";

const providers = new Map();

export function registerProvider(adapter, { replace = false } = {}) {
  const normalized = validateProviderAdapter(adapter);
  if (providers.has(normalized.providerId) && !replace) {
    throw createWorkflowError(
      WORKFLOW_ERROR_CODES.INVALID_PROVIDER,
      `Provider "${normalized.providerId}" is already registered.`
    );
  }
  providers.set(normalized.providerId, normalized);
  return normalized;
}

export function registerProviders(adapters, options = {}) {
  return adapters.map((adapter) => registerProvider(adapter, options));
}

export function getProvider(providerId) {
  return providers.get(providerId) || null;
}

export function listProviders() {
  return Array.from(providers.values());
}

export function listProvidersForCapability(capabilityId) {
  return listProviders().filter((adapter) => adapter.supportedCapabilities().includes(capabilityId));
}

export function clearProviderRegistry() {
  providers.clear();
}
