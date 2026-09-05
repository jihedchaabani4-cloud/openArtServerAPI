import { getRegistry } from "./modelRegistry.js";
import { getBindings, getBinding } from "./bindingRegistry.js";
import {
  BindingNotFoundError,
  BindingModelMismatchError,
  BindingOperationMismatchError,
  UnsupportedCapabilityError,
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
 *   4. undefined/null                 (uses single/default active binding if available)
 *
 * @param {string|null} bindingId  - Explicit binding identifier
 * @param {string} modelId        - Target canonical model ID
 * @param {string} operation      - Target operation
 * @returns {object} validatedBinding
 */
export function resolveBinding(bindingId, modelId, operation) {
  const normModelId = normalizeId(modelId);
  const availableBindings = getBindings(modelId, operation);

  if (!availableBindings || availableBindings.length === 0) {
    throw new BindingNotFoundError(bindingId || "default", modelId, operation);
  }

  // 1. If no explicit bindingId provided, resolve default/first active binding
  if (!bindingId) {
    const active = availableBindings.filter((b) => b.status === "active");
    if (active.length === 0) {
      throw new UnsupportedCapabilityError(`No active bindings configured for "${modelId}" (${operation})`);
    }
    // Return the highest priority active binding
    return active[0];
  }

  // 2. Parse provider identifier from bindingId
  let targetProviderId = bindingId;
  let targetModelId = null;
  let targetOperation = null;

  if (typeof bindingId === "string") {
    if (bindingId.includes(":")) {
      // Format: "model:operation:provider"
      const parts = bindingId.split(":");
      targetModelId = parts[0];
      targetOperation = parts[1];
      targetProviderId = parts[2];
    } else if (bindingId.includes(".")) {
      // Format: "model.provider"
      const parts = bindingId.split(".");
      targetModelId = parts[0];
      targetProviderId = parts[1];
    }
  }

  // 3. Check for Model Mismatch
  if (targetModelId && normalizeId(targetModelId) !== normModelId) {
    throw new BindingModelMismatchError(bindingId, targetModelId, modelId);
  }

  // 4. Check for Operation Mismatch
  if (targetOperation && targetOperation !== operation) {
    throw new BindingOperationMismatchError(bindingId, targetOperation, operation);
  }

  // 5. Look up binding
  let matchedBinding = getBinding(modelId, operation, targetProviderId);
  if (!matchedBinding) {
    // Also try matching by providerId case-insensitively or via availableBindings
    matchedBinding = availableBindings.find(
      (b) => b.providerId === targetProviderId || b.id === bindingId
    ) || null;
  }

  if (!matchedBinding) {
    throw new BindingNotFoundError(bindingId, modelId, operation);
  }

  // 6. Verify Active Status
  if (matchedBinding.status !== "active") {
    throw new UnsupportedCapabilityError(
      `Selected binding "${bindingId}" is not active (current status: "${matchedBinding.status}")`
    );
  }

  return matchedBinding;
}
