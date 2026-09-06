import { getInternalBindings, getBinding } from "./bindingRegistry.js";
import { getModel, getModelBindings } from "./modelRegistry.js";
import { resolveExecutionRoute } from "./routeResolver.js";
import {
  BindingNotFoundError,
  BindingModelMismatchError,
  BindingOperationMismatchError,
  UnsupportedCapabilityError,
} from "../errors/index.js";

export { resolveExecutionRoute };

/**
 * Normalizes model IDs (handling '-' vs '_') for matching.
 */
function normalizeId(id) {
  return typeof id === "string" ? id.replace(/-/g, "_") : id;
}

/**
 * Resolves the configured provider binding for a given model.
 *
 * MODEL-FIRST ARCHITECTURE:
 * External callers supply ONLY modelId. The Models Management
 * subsystem resolves its configured active provider binding internally.
 * Operation is NOT required for provider resolution.
 *
 * @param {string} modelId             - Target canonical model ID
 * @param {object|string} [arg2={}]     - Options object, or legacy operation string
 * @param {object|string} [arg3={}]     - Options object when arg2 is legacy operation
 * @returns {object} validated configured binding
 */
export function resolveBinding(modelId, arg2 = {}, arg3 = {}) {
  let operation = null;
  let options = {};

  if (typeof arg2 === "string") {
    // Legacy 3-arg signature: (modelId, operation, options)
    operation = arg2;
    options = typeof arg3 === "string" ? { bindingId: arg3 } : (arg3 || {});
  } else {
    // Model-First 2-arg signature: (modelId, options)
    options = typeof arg2 === "string" ? { bindingId: arg2 } : (arg2 || {});
  }

  const model = getModel(modelId);
  const normModelId = normalizeId(model.id);

  // Retrieve bindings: if operation was explicitly supplied, use operation index;
  // otherwise, use all model bindings directly.
  let availableBindings = [];
  if (operation) {
    availableBindings = getInternalBindings(model.id, operation);
  } else {
    availableBindings = getModelBindings(model.id);
  }

  if (!availableBindings || availableBindings.length === 0) {
    throw new BindingNotFoundError(options.bindingId || "configured", modelId, operation || "default");
  }

  // Case A: Explicit binding requested (internal tests / admin tools only)
  if (options.bindingId) {
    const targetBindingId = options.bindingId;
    let targetProviderId = targetBindingId;
    let targetModelId = null;
    let targetOperation = null;

    if (typeof targetBindingId === "string") {
      if (targetBindingId.includes(":")) {
        const parts = targetBindingId.split(":");
        targetModelId = parts[0];
        targetOperation = parts[1];
        targetProviderId = parts[2];
      } else if (targetBindingId.includes(".")) {
        const parts = targetBindingId.split(".");
        targetModelId = parts[0];
        targetProviderId = parts[1];
      }
    }

    if (targetModelId && normalizeId(targetModelId) !== normModelId) {
      throw new BindingModelMismatchError(targetBindingId, targetModelId, modelId);
    }
    if (targetOperation && operation && targetOperation !== operation) {
      throw new BindingOperationMismatchError(targetBindingId, targetOperation, operation);
    }

    let matched = operation ? getBinding(model.id, operation, targetProviderId) : null;
    if (!matched) {
      matched = availableBindings.find(
        (b) => b.providerId === targetProviderId || b.id === targetBindingId
      ) || null;
    }

    if (!matched) {
      throw new BindingNotFoundError(targetBindingId, modelId, operation || "default");
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
      `No active provider binding configured for model "${modelId}"${operation ? ` (${operation})` : ""}`
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
