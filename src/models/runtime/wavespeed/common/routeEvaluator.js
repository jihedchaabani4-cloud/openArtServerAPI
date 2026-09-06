import { UnsupportedCapabilityError, ConfigIntegrityError } from "../../../errors/index.js";

/**
 * WaveSpeed Route Evaluator
 *
 * Owned exclusively by the WaveSpeed Provider Execution Layer.
 * Evaluates declared `when` conditions against semantic parameters.
 *
 * Supported matchers:
 *   - "present": parameter is defined, non-null, non-empty
 *   - "absent": parameter is undefined, null, empty string, or empty array
 *   - "equals" / direct literal: exact value equality check
 *
 * Precedence:
 *   1. Condition count descending (most specific route wins)
 *   2. Explicit priority ascending (priority 1 > priority 2)
 *
 * Invariants:
 *   - 0 matches throws UnsupportedCapabilityError (no silent guessing)
 *   - Ambiguous matches with equal specificity and priority throw ConfigIntegrityError
 *   - Merges parent binding defaults with route-specific overrides
 */

/**
 * Checks whether a parameter value is considered "present".
 * @param {any} val
 * @returns {boolean}
 */
export function isParamPresent(val) {
  if (val === undefined || val === null || val === "") return false;
  if (Array.isArray(val) && val.length === 0) return false;
  if (typeof val === "object" && Object.keys(val).length === 0) return false;
  return true;
}

/**
 * Evaluates an individual condition rule against a given parameter value.
 * @param {any} val
 * @param {any} condition
 * @returns {boolean}
 */
export function matchesCondition(val, condition) {
  const present = isParamPresent(val);

  if (condition === "present") {
    return present;
  }
  if (condition === "absent") {
    return !present;
  }
  if (typeof condition === "object" && condition !== null) {
    if (condition.equals !== undefined) {
      return val === condition.equals;
    }
    if (condition.notEquals !== undefined) {
      return val !== condition.notEquals;
    }
    if (Array.isArray(condition.in)) {
      return condition.in.includes(val);
    }
  }
  return val === condition;
}

/**
 * Evaluates candidate routes for a WaveSpeed binding against semantic input.
 *
 * @param {object} binding       - Parent WaveSpeed binding manifest
 * @param {object[]} routes      - Declared routes in the binding
 * @param {object} semanticInput - Canonical semantic parameters
 * @param {string} category      - Topology category ("image", "video", "llm", "upscale")
 * @returns {object} Concrete execution plan with merged configuration
 */
export function evaluateWaveSpeedRoutes(binding, routes = [], semanticInput = {}, category = "general") {
  if (!Array.isArray(routes) || routes.length === 0) {
    return binding;
  }

  const matchingRoutes = [];

  for (const route of routes) {
    const when = route.when || {};
    const conditions = Object.entries(when);

    if (conditions.length === 0) {
      // Unconditional fallback route (lowest specificity: 0 conditions)
      matchingRoutes.push({ route, specificity: 0 });
      continue;
    }

    let allMatch = true;
    for (const [key, condition] of conditions) {
      const val = semanticInput[key];
      if (!matchesCondition(val, condition)) {
        allMatch = false;
        break;
      }
    }

    if (allMatch) {
      matchingRoutes.push({ route, specificity: conditions.length });
    }
  }

  // Error on 0 matches: fail-fast with full diagnostic
  if (matchingRoutes.length === 0) {
    const suppliedKeys = Object.keys(semanticInput).filter((k) => isParamPresent(semanticInput[k]));
    throw new UnsupportedCapabilityError(
      `No matching WaveSpeed ${category} route configured for model "${binding.modelId}". ` +
      `Supplied semantic parameters [${suppliedKeys.join(", ")}] do not match any declared execution route.`
    );
  }

  // Sort candidate matches:
  // 1. Specificity descending (higher condition count wins)
  // 2. Priority ascending (1 is higher than 2)
  matchingRoutes.sort((a, b) => {
    if (b.specificity !== a.specificity) {
      return b.specificity - a.specificity;
    }
    const prioA = a.route.priority ?? binding.priority ?? 99;
    const prioB = b.route.priority ?? binding.priority ?? 99;
    return prioA - prioB;
  });

  // Ambiguity check: if top 2 matches have identical specificity and identical priority
  // but point to different endpoints/providerModelIds, fail-fast
  if (matchingRoutes.length > 1) {
    const first = matchingRoutes[0];
    const second = matchingRoutes[1];
    const prioFirst = first.route.priority ?? binding.priority ?? 99;
    const prioSecond = second.route.priority ?? binding.priority ?? 99;

    if (
      first.specificity === second.specificity &&
      prioFirst === prioSecond &&
      first.route.id !== second.route.id &&
      (first.route.providerModelId !== second.route.providerModelId || first.route.endpoint !== second.route.endpoint)
    ) {
      throw new ConfigIntegrityError(
        `Ambiguous WaveSpeed ${category} route resolution for model "${binding.modelId}": ` +
        `routes "${first.route.id}" and "${second.route.id}" both match with equal specificity (${first.specificity}) ` +
        `and equal priority (${prioFirst}). Configure distinct priorities or more specific "when" conditions.`
      );
    }
  }

  const selectedRoute = matchingRoutes[0].route;

  // Configuration Hierarchy: Binding Defaults + Route-Specific Overrides
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
