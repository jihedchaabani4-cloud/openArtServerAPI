/**
 * Runway Provider Route Resolver
 *
 * Selects the matching concrete operation route (`textToImage`, `textToVideo`,
 * `imageToVideo`, `videoToVideo`, `characterPerformance`, `imageUpscale`,
 * `videoUpscale`) from a Runway binding's `operations` array based on semantic
 * input presence/absence conditions.
 *
 * Precedence:
 *   1. Specificity descending (number of `when` conditions matched)
 *   2. Explicit priority ascending (1 is highest)
 */

function isParamPresent(val) {
  if (val === undefined || val === null || val === "") return false;
  if (Array.isArray(val) && val.length === 0) return false;
  if (typeof val === "object" && Object.keys(val).length === 0) return false;
  return true;
}

function matchesCondition(val, condition) {
  const present = isParamPresent(val);
  if (condition === "present") return present;
  if (condition === "absent") return !present;
  if (typeof condition === "object" && condition !== null && condition.equals !== undefined) {
    return val === condition.equals;
  }
  return val === condition;
}

/**
 * Resolves the concrete Runway execution route from a binding manifest.
 *
 * @param {object} binding
 * @param {object} [semanticInput={}]
 * @returns {object}
 */
export function resolveRunwayRoute(binding, semanticInput = {}) {
  const ops = binding.operations || binding.routes;
  if (!Array.isArray(ops) || ops.length === 0) {
    return binding;
  }

  if (ops.length === 1) {
    return mergeRoute(binding, ops[0]);
  }

  const matched = [];
  for (const op of ops) {
    const when = op.when || {};
    const entries = Object.entries(when);
    if (entries.length === 0) {
      matched.push({ op, specificity: 0 });
      continue;
    }
    const ok = entries.every(([key, cond]) => matchesCondition(semanticInput[key], cond));
    if (ok) {
      matched.push({ op, specificity: entries.length });
    }
  }

  if (matched.length === 0) {
    // Fallback to lowest-priority operation (e.g. text_to_video for default pricing quote)
    const sorted = [...ops].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    return mergeRoute(binding, sorted[sorted.length - 1]);
  }

  matched.sort((a, b) => {
    if (b.specificity !== a.specificity) return b.specificity - a.specificity;
    return (a.op.priority ?? 99) - (b.op.priority ?? 99);
  });

  return mergeRoute(binding, matched[0].op);
}

function mergeRoute(binding, selectedRoute) {
  return {
    ...binding,
    ...selectedRoute,
    id: selectedRoute.id || binding.id,
    routeId: selectedRoute.id || null,
    operation: selectedRoute.operation || selectedRoute.id || binding.operation,
    sdkMethod: selectedRoute.sdkMethod || binding.sdkMethod,
    requiredInputs: selectedRoute.requiredInputs || binding.requiredInputs || [],
    parameterMap: {
      ...(binding.parameterMap || {}),
      ...(selectedRoute.parameterMap || {}),
      ...(selectedRoute.parameterOverrides || {}),
    },
    passthroughParameters: [
      ...(binding.passthroughParameters || []),
      ...(selectedRoute.passthroughParameters || []),
    ],
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
  };
}
