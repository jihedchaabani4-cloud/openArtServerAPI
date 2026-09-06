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
import { getRegistry, getModel } from "./modelRegistry.js";
import { UnknownOperationError } from "../errors/index.js";

/**
 * Returns raw internal binding manifests for engine components (resolver, runner).
 * @param {string} modelId
 * @param {string} operation
 * @returns {object[]}
 */
export function getInternalBindings(modelId, operation) {
  const { bindingIndex } = getRegistry();
  const model = getModel(modelId);

  if (!model.operations || !model.operations[operation]) {
    throw new UnknownOperationError(model.id, operation);
  }

  const indexKey = `${model.id}:${operation}`;
  return bindingIndex.get(indexKey) || [];
}

/**
 * Returns all bindings for a given model + operation as a safe public DTO array.
 *
 * SEALED: Implementation details (parameterMap, outputMap, providerModelId, endpoint,
 * providerId, runtime, credentialKey) are NOT exposed to callers.
 *
 * Callers MUST use the opaque `bindingId` string to identify and pass bindings
 * to `calculateCost()`, `run()`, and `estimatePrice()`. They must NOT parse
 * `bindingId` to reconstruct provider information.
 *
 * @param {string} modelId    - e.g. "nanobana_pro"
 * @param {string} operation  - e.g. "text_to_image"
 * @returns {object[]} Array of safe public binding DTOs
 */
export function getBindings(modelId, operation) {
  const rawList = getInternalBindings(modelId, operation);

  return rawList.map((b) => {
    const capabilities = {};
    if (b.parameterMap) {
      for (const [canonicalParam, mapDef] of Object.entries(b.parameterMap)) {
        if (mapDef && mapDef.valueMap && typeof mapDef.valueMap === "object") {
          capabilities[canonicalParam] = Object.keys(mapDef.valueMap);
        }
      }
    }
    if (b.constraints && typeof b.constraints === "object") {
      for (const [param, allowed] of Object.entries(b.constraints)) {
        capabilities[param] = allowed;
      }
    }

    // Return opaque DTO — no internal fields (providerId, provider, runtime,
    // parameterMap, outputMap, endpoint, providerModelId) are exposed.
    return {
      bindingId: b.id || `${b.modelId}.${b.providerId}`,
      modelId: b.modelId,
      status: b.status || "active",
      priority: b.priority || 999,
      capabilities,
    };
  });
}

/**
 * Returns the bindingId string for the highest-priority active binding for
 * a given model + operation. This is the canonical way for callers to obtain
 * a default bindingId when none was explicitly specified by the user/planner.
 *
 * Returns null if no active binding is available.
 *
 * @param {string} modelId
 * @param {string} operation
 * @returns {string|null} opaque bindingId e.g. "nanobana_pro.wavespeed", or null
 */
export function getDefaultBinding(modelId, operation) {
  let rawList;
  try {
    rawList = getInternalBindings(modelId, operation);
  } catch {
    return null;
  }
  // bindings are sorted by priority ascending (lowest number = highest priority)
  const active = rawList.filter((b) => b.status === "active");
  if (active.length === 0) return null;
  const b = active[0];
  return b.id || `${b.modelId}.${b.providerId}`;
}

/**
 * Returns a specific binding by model + operation + provider.
 * INTERNAL — only used by the Models engine (bindingResolver, modelRunner).
 *
 * @param {string} modelId
 * @param {string} operation
 * @param {string} providerId
 * @returns {object|null}
 */
export function getBinding(modelId, operation, providerId) {
  const { bindings } = getRegistry();
  const model = getModel(modelId);

  const actualId = model ? model.id : modelId;
  const key = `${actualId}:${operation}:${providerId}`;
  return bindings.get(key) || null;
}
