import { executeProvider, registerRunner } from "../../runtime/providerRuntimeRegistry.js";

/**
 * Legacy Provider SDK Dispatcher (Backward Compatibility Wrapper)
 *
 * Delegates directly to the dynamic Provider Runtime Registry (`src/models/runtime/providerRuntimeRegistry.js`).
 * Retained so existing imports of `executeProviderSdk` and `registerProviderSdk` continue to function without disruption.
 */

export function registerProviderSdk(providerId, runnerFn) {
  registerRunner(providerId, runnerFn);
}

export async function executeProviderSdk({
  provider,
  binding,
  payload,
  credential,
  timeoutMs,
  options = {},
}) {
  return executeProvider({
    provider,
    binding,
    payload,
    credential,
    timeoutMs,
    options,
  });
}
