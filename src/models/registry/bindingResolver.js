import { getInternalBindings, getBinding } from "./bindingRegistry.js";
import {
  BindingNotFoundError,
  BindingModelMismatchError,
  BindingOperationMismatchError,
  UnsupportedCapabilityError,
  MissingOptionError,
} from "../errors/index.js";

/**
 * Normalizes model IDs (handling '-' vs '_') for matching.
 */
function normalizeId(id) {
  return typeof id === "string" ? id.replace(/-/g, "_") : id;
}

/**
 * Deterministic Explicit Binding Resolver (Phase 1)
 *
 * Enforces strict binding validation without automatic provider failover.
 * Verifies that the binding exists, matches the requested model and operation,
 * and is in active status.
 *
 * Supported bindingId formats:
 *   1. "modelId.providerId"           (e.g. "nanobana_pro.wavespeed", "nanobana-pro.google")
 *   2. "providerId"                   (e.g. "wavespeed", "google")
 *   3. "modelId:operation:providerId" (composite key)
 *
 * @param {string} bindingId       - Explicit binding identifier (MANDATORY in Phase 1)
 * @param {string} modelId        - Target canonical model ID
 * @param {string} operation      - Target operation
 * @returns {object} validatedBinding
 */
/**
 * Resolves the configured provider binding for a given model and operation.
 *
 * MODEL-FIRST ARCHITECTURE:
 * External callers supply ONLY modelId and operation. The Models Management
 * subsystem resolves its configured active provider binding internally.
 *
 * @param {string} modelId - Target canonical model ID
 * @param {string} operation - Target operation
 * @param {object|string} [options={}] - Options object or explicit bindingId string
 * @returns {object} validated configured binding
 */
export function resolveBinding(modelId, operation, options = {}) {
  const opts = typeof options === "string" ? { bindingId: options } : (options || {});

  const normModelId = normalizeId(modelId);
  const availableBindings = getInternalBindings(modelId, operation);

  if (!availableBindings || availableBindings.length === 0) {
    throw new BindingNotFoundError(opts.bindingId || "configured", modelId, operation);
  }

  // Case A: Explicit binding requested (internal tests / admin tools only)
  if (opts.bindingId) {
    const targetBindingId = opts.bindingId;
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
    if (targetOperation && targetOperation !== operation) {
      throw new BindingOperationMismatchError(targetBindingId, targetOperation, operation);
    }

    let matched = getBinding(modelId, operation, targetProviderId);
    if (!matched) {
      matched = availableBindings.find(
        (b) => b.providerId === targetProviderId || b.id === targetBindingId
      ) || null;
    }

    if (!matched) {
      throw new BindingNotFoundError(targetBindingId, modelId, operation);
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
      `No active provider binding configured for model "${modelId}" (${operation})`
    );
  }

  return activeBindings[0];
}
