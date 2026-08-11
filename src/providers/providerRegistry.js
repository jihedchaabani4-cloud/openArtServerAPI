import { validateProviderAdapter } from "./providerAdapterContract.js";

const providers = new Map();

export function registerProvider(adapter, { replace = false } = {}) {
  const normalized = validateProviderAdapter(adapter);
  if (providers.has(normalized.providerId) && !replace) {
    const err = new Error(`Provider "${normalized.providerId}" is already registered.`);
    err.code = "INVALID_PROVIDER";
    throw err;
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
