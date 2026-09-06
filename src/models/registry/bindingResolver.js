import { getModel, getModelBindings } from "./modelRegistry.js";
import { resolveExecutionRoute } from "../runtime/routeResolver.js";
import {
  BindingNotFoundError,
  BindingModelMismatchError,
  UnsupportedCapabilityError,
} from "../errors/index.js";

export { resolveExecutionRoute };

function normalizeId(id) {
  return typeof id === "string" ? id.replace(/-/g, "_") : id;
}

/**
 * Resolves the configured provider binding for a given model.
 *
 * MODEL-FIRST ARCHITECTURE:
 * External callers supply ONLY modelId. The Models Management
 * subsystem resolves its configured active provider binding internally.
 * Zero operation knowledge.
 *
 * @param {string} modelId             - Target canonical model ID
 * @param {object|string} [options={}] - Options object or explicit bindingId string
 * @returns {object} validated configured provider binding
 */
export function resolveBinding(modelId, options = {}) {
  const opts = typeof options === "string" ? { bindingId: options } : (options || {});
  const model = getModel(modelId);
  const normModelId = normalizeId(model.id);
  const availableBindings = getModelBindings(model.id);

  if (!availableBindings || availableBindings.length === 0) {
    throw new BindingNotFoundError(opts.bindingId || "configured", modelId);
  }

  // Case A: Explicit binding requested (internal tests / admin tools only)
  if (opts.bindingId) {
    const targetBindingId = opts.bindingId;
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

    if (matched.status !== "active" && matched.status !== "standby") {
      throw new UnsupportedCapabilityError(
        `Selected binding "${targetBindingId}" is inactive (current status: "${matched.status}")`
      );
    }

    return matched;
  }

  // Case B: Model-First resolution — resolve the configured active implementation
  const activeBindings = availableBindings.filter((b) => b.status === "active");

  if (activeBindings.length === 0) {
    throw new UnsupportedCapabilityError(
      `No active provider binding configured for model "${modelId}"`
    );
  }

  return activeBindings[0];
}

/**
 * Resolves both the configured provider binding and its concrete execution route
 * for a given model and semantic input.
 *
 * Guarantees that pricing and execution resolve the EXACT SAME implementation:
 *   quote implementation === execution implementation
 *
 * @param {string} modelId
 * @param {object} semanticInput
 * @param {object} [options={}]
 * @returns {object} concrete execution route
 */
export function resolveBindingAndRoute(modelId, semanticInput = {}, options = {}) {
  const binding = resolveBinding(modelId, options);
  return resolveExecutionRoute(binding, semanticInput);
}
