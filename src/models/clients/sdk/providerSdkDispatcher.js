import { runWaveSpeedSdk } from "./wavespeedSdkRunner.js";
import { runGoogleSdk } from "./googleSdkRunner.js";
import { createApiSdkClient } from "./baseApiSdk.js";

const customSdkRunners = new Map();

/**
 * Register a custom SDK runner for a provider.
 */
export function registerProviderSdk(providerId, runnerFn) {
  customSdkRunners.set(providerId, runnerFn);
}

/**
 * Executes a model operation through the appropriate Provider SDK.
 * - If the provider has a dedicated SDK (WaveSpeed, Google), uses that.
 * - If the provider has no dedicated package, automatically creates an API SDK client
 *   based on the provider's API link and executes through it.
 */
export async function executeProviderSdk({
  provider,
  binding,
  payload,
  credential,
  timeoutMs,
  options = {},
}) {
  const providerId = provider.id;

  // 1. Allow custom injected runner (useful for tests or custom overrides)
  if (typeof options.sdkRunner === "function") {
    return options.sdkRunner({ provider, binding, payload, credential, timeoutMs, options });
  }

  // 2. Check registered custom SDK runners
  if (customSdkRunners.has(providerId)) {
    const runner = customSdkRunners.get(providerId);
    return runner({ provider, binding, payload, credential, timeoutMs, options });
  }

  // 3. Official WaveSpeed SDK
  if (providerId === "wavespeed") {
    return runWaveSpeedSdk({
      binding,
      payload,
      credential,
      options: {
        ...options,
        timeout: options.timeout || (timeoutMs ? timeoutMs / 1000 : 3600),
      },
    });
  }

  // 4. Official Google GenAI SDK
  if (providerId === "google") {
    return runGoogleSdk({
      binding,
      payload,
      credential,
      options: {
        ...options,
        timeoutMs: timeoutMs || provider.defaultTimeoutMs || 30000,
      },
    });
  }

  // 5. Automatic Dynamic API SDK for providers without a dedicated npm SDK
  const apiSdk = createApiSdkClient(provider, credential);
  return apiSdk.run(binding.providerModelId, payload, {
    endpoint: binding.endpoint,
    timeoutMs: timeoutMs || provider.defaultTimeoutMs || 30000,
    ...options,
  });
}
