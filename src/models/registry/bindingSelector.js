import { getBindings, getModel } from "./modelRegistry.js";
import { circuitBreakerRegistry } from "../execution/circuitBreaker.js";
import {
  NoServableDeploymentError,
  UnsupportedCapabilityError,
  AllProvidersUnavailableError,
} from "../errors/index.js";

/**
 * Two-Phase Binding Selection Algorithm
 * 1. Capability Filtering: Verify binding supports requested parameters in its valueMap.
 * 2. Health Filtering: Filter out bindings whose Circuit Breaker is OPEN.
 * 3. Priority Selection: Dispatch to the highest-priority (lowest integer) eligible healthy binding.
 */
export function selectBinding(modelId, operation, cleanInput = {}, options = {}) {
  // Allow passing mock bindings in options for unit testing, otherwise fetch from registry
  let candidates = options.bindings
    ? [...options.bindings].filter((b) => b.modelId === modelId && b.operation === operation)
    : getBindings(modelId, operation);

  candidates = candidates.filter((b) => b.status === "active");

  if (candidates.length === 0) {
    throw new NoServableDeploymentError(modelId, operation);
  }

  // Phase 1: Capability Filter
  const eligible = candidates.filter((binding) => {
    const parameterMap = binding.parameterMap || {};
    for (const [key, value] of Object.entries(cleanInput)) {
      if (value === undefined || value === null) continue;
      const mapping = parameterMap[key];
      if (mapping && mapping.valueMap) {
        if (!Object.prototype.hasOwnProperty.call(mapping.valueMap, String(value))) {
          return false;
        }
      }
    }
    return true;
  });

  if (eligible.length === 0) {
    throw new UnsupportedCapabilityError(
      `No active provider binding for "${modelId}" (${operation}) supports the requested parameter values: ${JSON.stringify(cleanInput)}`
    );
  }

  // Phase 2: Health Filter (Circuit Breakers)
  const cb = options.circuitBreaker || circuitBreakerRegistry;
  let healthy = eligible.filter((b) => {
    const bindingId = `${b.modelId}:${b.operation}:${b.providerId}`;
    return cb.isAvailable(bindingId);
  });

  if (healthy.length === 0) {
    let allowFallback = false;
    try {
      const model = options.model || getModel(modelId);
      allowFallback = Boolean(model.allowFallbackToUnhealthy);
    } catch {
      // ignore
    }

    if (allowFallback) {
      healthy = eligible; // Last resort emergency fallback
    } else {
      throw new AllProvidersUnavailableError(modelId, operation);
    }
  }

  // Check manual preferred provider override
  if (options.preferredProvider) {
    const preferred = healthy.find((b) => b.providerId === options.preferredProvider);
    if (preferred) return preferred;
  }

  // Phase 3: Sort by priority ascending (1 = highest priority)
  healthy.sort((a, b) => (a.priority || 999) - (b.priority || 999));

  return healthy[0];
}
