import { resolveProviderRoute } from "./providerRuntimeRegistry.js";

/**
 * Provider-Specific Execution Route Resolver
 *
 * @deprecated Route resolution is provider-owned. Use resolveProviderRoute from
 * providerRuntimeRegistry.js instead.
 *
 * @param {object} binding       - Configured provider binding manifest
 * @param {object} semanticInput - Validated canonical semantic input
 * @param {object} [context={}]  - Execution context { model }
 * @returns {object} Concrete execution route with merged parameters and endpoints
 */
export function resolveExecutionRoute(binding, semanticInput = {}, context = {}) {
  if (!binding) return null;
  return resolveProviderRoute(binding.providerId, binding, semanticInput, context);
}

export default resolveExecutionRoute;
