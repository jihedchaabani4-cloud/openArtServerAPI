import { UnsupportedCapabilityError } from "../errors/index.js";

/**
 * Provider-Specific Execution Route Resolver
 *
 * Owned by the Provider Runtime layer.
 * Evaluates declared `when` routing rules against semantic inputs.
 * Implements clean configuration hierarchy:
 *   Parent Binding Defaults + Route-Specific Overrides
 *
 * @param {object} binding       - Configured provider binding manifest
 * @param {object} semanticInput - Validated canonical semantic input
 * @returns {object} Concrete execution route with merged parameters and endpoints
 */
export function resolveExecutionRoute(binding, semanticInput = {}) {
  if (!binding) return null;

  // Single-route binding: the binding itself is the execution configuration
  if (!Array.isArray(binding.routes) || binding.routes.length === 0) {
    return binding;
  }

  const matchingRoutes = [];

  for (const route of binding.routes) {
    if (!route.when || Object.keys(route.when).length === 0) {
      matchingRoutes.push(route);
      continue;
    }

    let allMatch = true;
    for (const [key, condition] of Object.entries(route.when)) {
      const val = semanticInput[key];
      const isPresent =
        val !== undefined &&
        val !== null &&
        val !== "" &&
        (!Array.isArray(val) || val.length > 0);

      if (condition === "present") {
        if (!isPresent) {
          allMatch = false;
          break;
        }
      } else if (condition === "absent") {
        if (isPresent) {
          allMatch = false;
          break;
        }
      } else if (typeof condition === "object" && condition !== null) {
        if (condition.equals !== undefined && val !== condition.equals) {
          allMatch = false;
          break;
        }
      } else if (val !== condition) {
        allMatch = false;
        break;
      }
    }

    if (allMatch) {
      matchingRoutes.push(route);
    }
  }

  // Fail explicitly if 0 routes match (no silent guessing)
  if (matchingRoutes.length === 0) {
    const presentKeys = Object.keys(semanticInput).filter((k) => {
      const v = semanticInput[k];
      return (
        v !== undefined &&
        v !== null &&
        v !== "" &&
        (!Array.isArray(v) || v.length > 0)
      );
    });
    throw new UnsupportedCapabilityError(
      `No matching route configured for provider "${binding.providerId}" on model "${binding.modelId}". ` +
      `Supplied semantic parameters [${presentKeys.join(", ")}] do not match any declared execution route.`
    );
  }

  // Deterministic precedence: sort by condition count descending (most specific match wins)
  matchingRoutes.sort((a, b) => {
    const aCount = Object.keys(a.when || {}).length;
    const bCount = Object.keys(b.when || {}).length;
    if (bCount !== aCount) return bCount - aCount;
    return (a.priority || 99) - (b.priority || 99);
  });

  const selectedRoute = matchingRoutes[0];

  // Configuration Hierarchy: Common Binding Defaults + Route-Specific Overrides
  return {
    ...binding,
    ...selectedRoute,
    id: selectedRoute.id || binding.id,
    routeId: selectedRoute.id || null,
    operation: selectedRoute.operation || selectedRoute.id || binding.operation,
    parameterMap: {
      ...(binding.parameterMap || {}),
      ...(selectedRoute.parameterMap || {}),
    },
    staticPayload: {
      ...(binding.staticPayload || {}),
      ...(selectedRoute.staticPayload || {}),
    },
    pricing: selectedRoute.pricing || binding.pricing,
    retailPricing: selectedRoute.retailPricing || binding.retailPricing,
    endpoint: selectedRoute.endpoint || binding.endpoint,
    providerModelId: selectedRoute.providerModelId || binding.providerModelId,
    outputMap: selectedRoute.outputMap || binding.outputMap,
    pollingConfig: selectedRoute.pollingConfig || binding.pollingConfig,
    sdkMethod: selectedRoute.sdkMethod || binding.sdkMethod,
  };
}
