import { getModel, getModelBindings, getProvider } from "./modelRegistry.js";
import { resolveExecutionRoute } from "../runtime/routeResolver.js";
import {
  BindingNotFoundError,
  BindingModelMismatchError,
  UnsupportedCapabilityError,
} from "../errors/index.js";

function normalizeId(id) {
  return typeof id === "string" ? id.replace(/-/g, "_") : id;
}

/**
 * Resolves the configured active provider binding for a given model.
 *
 * PRODUCTION RESOLUTION (MODEL-FIRST ARCHITECTURE):
 * External callers supply ONLY modelId. Resolves the active configured provider.
 * Does NOT accept or respect any caller-supplied provider or binding overrides.
 *
 * @param {string} modelId - Canonical model ID
 * @returns {object} configured active provider binding
 */
export function resolveConfiguredBinding(modelId) {
  const model = getModel(modelId);
  const availableBindings = getModelBindings(model.id);

  if (!availableBindings || availableBindings.length === 0) {
    throw new BindingNotFoundError("configured", modelId);
  }

  const activeBindings = availableBindings.filter((b) => b.status === "active");

  if (activeBindings.length === 0) {
    throw new UnsupportedCapabilityError(
      `No active provider binding configured for model "${modelId}"`
    );
  }

  return activeBindings[0];
}

/**
 * Explicit binding resolution for isolated integration tests and admin tooling ONLY.
 * Never exposed through the public production API or caller options.
 *
 * @param {string} modelId - Canonical model ID
 * @param {string} targetBindingId - Explicit binding ID to load for testing
 * @returns {object} matched binding manifest
 */
export function resolveBindingForTest(modelId, targetBindingId) {
  const model = getModel(modelId);
  const normModelId = normalizeId(model.id);
  const availableBindings = getModelBindings(model.id);

  if (!availableBindings || availableBindings.length === 0) {
    throw new BindingNotFoundError(targetBindingId || "configured", modelId);
  }

  let targetProviderId = targetBindingId;
  let targetModelId = null;

  if (typeof targetBindingId === "string") {
    if (targetBindingId.includes(":")) {
      const parts = targetBindingId.split(":");
      targetModelId = parts[0];
      targetProviderId = parts[parts.length - 1];
    } else if (targetBindingId.includes(".")) {
      const parts = targetBindingId.split(".");
      targetModelId = parts[0];
      targetProviderId = parts[1];
    }
  }

  if (targetModelId && normalizeId(targetModelId) !== normModelId) {
    throw new BindingModelMismatchError(targetBindingId, targetModelId, modelId);
  }

  const matched = availableBindings.find(
    (b) => b.providerId === targetProviderId || b.id === targetBindingId
  ) || null;

  if (!matched) {
    throw new BindingNotFoundError(targetBindingId, modelId);
  }

  return matched;
}

/**
 * Shared Internal Resolution Pipeline
 *
 * Single pipeline used by BOTH calculateCost() and run().
 * Guarantees that quote resolution and execution resolution are 100% symmetric.
 *
 * @param {string} modelId
 * @param {object} semanticInput - Validated canonical semantic inputs
 * @param {object} [options={}]  - Internal options (e.g. test overrides)
 * @returns {{ model: object, binding: object, route: object, provider: object }}
 */
export function resolveExecutionPlan(modelId, semanticInput = {}, options = {}) {
  const model = getModel(modelId);

  // Isolate test overrides from production path
  let binding;
  if (options._testBinding) {
    binding = options._testBinding;
  } else if (options._testBindingId) {
    binding = resolveBindingForTest(model.id, options._testBindingId);
  } else {
    // Pure production path: strictly resolve configured active binding
    binding = resolveConfiguredBinding(model.id);
  }

  const route = resolveExecutionRoute(binding, semanticInput);
  const provider = getProvider(route.providerId);

  return {
    model,
    binding,
    route,
    provider,
  };
}
