/**
 * Binding Registry
 *
 * Provides the public API for querying bindings.
 * Data is owned by modelRegistry (initRegistry builds the full state),
 * but all binding-specific access is funnelled through this module.
 *
 * ── Responsibility ───────────────────────────────────────────────────────────
 *   modelRegistry  → loads + validates model.json manifests
 *   bindingRegistry → exposes binding queries (getBindings, getBinding)
 *
 * This separation ensures:
 *   - Callers never need to import modelRegistry for binding queries
 *   - Internal registry state remains a single source of truth
 * ────────────────────────────────────────────────────────────────────────────
 */
import { getRegistry } from "./modelRegistry.js";
import { UnknownModelFamilyError, UnknownOperationError } from "../errors/index.js";

/**
 * Returns all bindings for a given model + operation, sorted by priority ascending.
 *
 * @param {string} modelId    - e.g. "nanobana_pro" or "nanobana-pro"
 * @param {string} operation  - e.g. "text_to_image"
 * @returns {object[]} Array of binding manifests (may be empty)
 */
export function getBindings(modelId, operation) {
  const { bindingIndex, models } = getRegistry();

  const model =
    models.get(modelId) ||
    models.get(typeof modelId === "string" ? modelId.replace(/-/g, "_") : null) ||
    models.get(typeof modelId === "string" ? modelId.replace(/_/g, "-") : null);

  if (!model) throw new UnknownModelFamilyError(modelId);
  if (!model.operations || !model.operations[operation]) {
    throw new UnknownOperationError(model.id, operation);
  }

  const indexKey = `${model.id}:${operation}`;
  return bindingIndex.get(indexKey) || [];
}

/**
 * Returns a specific binding by model + operation + provider.
 *
 * @param {string} modelId
 * @param {string} operation
 * @param {string} providerId
 * @returns {object|null}
 */
export function getBinding(modelId, operation, providerId) {
  const { bindings, models } = getRegistry();

  const model =
    models.get(modelId) ||
    models.get(typeof modelId === "string" ? modelId.replace(/-/g, "_") : null) ||
    models.get(typeof modelId === "string" ? modelId.replace(/_/g, "-") : null);

  const actualId = model ? model.id : modelId;
  const key = `${actualId}:${operation}:${providerId}`;
  return bindings.get(key) || null;
}
