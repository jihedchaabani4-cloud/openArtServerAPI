/**
 * Models Management System — Public Facade Interface
 *
 * SEALED SUBSYSTEM: All callers interact through these exported functions.
 * Backed by the Dynamic Multi-Provider Architecture (032).
 *
 * ── Semantic-First Architecture ──────────────────────────────────────────────
 * External callers supply ONLY modelId + semantic parameters.
 * The Models Management subsystem infers the internal operation entirely
 * from the semantic parameters provided:
 *
 *   { prompt }                       → text_to_image
 *   { prompt, input_image }          → edit
 *   { messages }                     → chat_completion
 *
 * Operation is NEVER exposed to callers. It is resolved internally.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  initRegistry,
  getRegistry,
  getModel,
  reloadRegistry,
} from "./registry/modelRegistry.js";
import { validateCanonicalInput } from "./schema/schemaValidator.js";
import { calculateRetailCredits } from "./pricing/pricingEngine.js";
import { run as runInternal } from "./execution/modelRunner.js";
import { resolveBinding } from "./registry/bindingResolver.js";
import { createLogger, LogEvents } from "../infrastructure/logging/index.js";
import { UnknownOperationError } from "./errors/index.js";

const modelsLogger = createLogger("models");

// Eagerly initialize the registry on module load
try {
  initRegistry();
} catch (err) {
  modelsLogger.error({ error: err.message }, `Registry boot initialization error: ${err.message}`);
}

// --- inferOperation (PRIVATE) -------------------------------------------------

/**
 * Infers the canonical operation name from semantic parameters.
 *
 * Resolution rules (evaluated in order):
 *   1. If params contain `input_image`, `images`, or `image_url` → "edit"
 *      (only if the model declares an "edit" operation)
 *   2. If params contain `messages` → "chat_completion"
 *   3. Default → "text_to_image"
 *
 * Throws UnknownOperationError if the inferred operation is not declared
 * by the model (no silent fallback to a different operation).
 *
 * @param {object} model       - Loaded model manifest
 * @param {object} params      - Semantic parameters from caller
 * @returns {string} Canonical operation name
 */
function inferOperation(model, params = {}) {
  const operations = model.operations || {};

  // Rule 1: image input signals an edit operation
  const hasImageInput = Boolean(
    params.input_image ||
    (Array.isArray(params.images) && params.images.length > 0) ||
    params.image_url
  );

  if (hasImageInput) {
    if (operations.edit) return "edit";
    throw new UnknownOperationError(model.id, "edit");
  }

  // Rule 2: messages array signals a chat/LLM operation
  if (params.messages) {
    if (operations.chat_completion) return "chat_completion";
    if (operations.text_generation) return "text_generation";
  }

  // Rule 3: default — text_to_image (image domain) or first declared operation
  if (operations.text_to_image) return "text_to_image";

  // Last resort: use first declared operation
  const firstOp = Object.keys(operations)[0];
  if (firstOp) return firstOp;

  throw new UnknownOperationError(model.id, "(none)");
}

// --- getCatalog ---------------------------------------------------------------

/**
 * Returns catalog of available models matching optional filters.
 */
export function getCatalog(filters = {}) {
  const { models, bindingIndex } = getRegistry();
  const entries = [];

  for (const [modelId, model] of models.entries()) {
    const isSystemOnly = Boolean(model.systemOnly || model.visibility === "internal");

    // Filter out system-only models by default unless explicitly requested
    if (!filters.includeSystem && !filters.systemOnly && isSystemOnly) continue;
    if (filters.systemOnly && !isSystemOnly) continue;

    const operations = Object.keys(model.operations || {});
    const operationDetails = {};

    for (const opKey of operations) {
      const opDef = model.operations[opKey];
      operationDetails[opKey] = {
        inputs: opDef.canonicalInputs || {},
        retailPricing: opDef.retailPricing || null,
      };
    }

    const entry = {
      modelFamily: model.id,
      modelId: model.id,
      displayName: model.displayName,
      description: model.description || "",
      iconUrl: model.iconUrl || "",
      domain: model.domain,
      systemOnly: isSystemOnly,
      visibility: model.visibility || (isSystemOnly ? "internal" : "public"),
      operations,
      operationDetails,
      lifecycleStatus: model.status || "active",
      status: model.status || "active",
    };

    if (filters.domain && entry.domain !== filters.domain) continue;
    if (filters.operation && !entry.operations.includes(filters.operation)) continue;
    if (filters.status && entry.lifecycleStatus !== filters.status) continue;

    entries.push(entry);
  }

  return entries;
}

// --- getSchema ----------------------------------------------------------------

/**
 * Returns input schema and pricing details for a given model and operation.
 * Still accepts explicit operation for schema introspection / admin tooling.
 */
export function getSchema(modelFamily, operation) {
  const model = getModel(modelFamily);
  const opDef = model.operations?.[operation];
  if (!opDef) {
    throw new Error(`Operation "${operation}" not supported for model "${modelFamily}"`);
  }

  return {
    modelFamily: model.id,
    modelId: model.id,
    operation,
    domain: model.domain,
    inputs: opDef.canonicalInputs || {},
    retailPricing: opDef.retailPricing || null,
  };
}

// --- validateInput ------------------------------------------------------------

/**
 * Validates and sanitizes raw input against canonical schema.
 * Operation is inferred internally from semantic parameters.
 *
 * @param {string} modelFamily
 * @param {object} rawInput
 * @returns {object} cleanInput
 */
export function validateInput(modelFamily, rawInput = {}) {
  const model = getModel(modelFamily);
  const operation = inferOperation(model, rawInput);
  const opDef = model.operations[operation];
  return validateCanonicalInput(opDef, rawInput);
}

// --- calculateCost ------------------------------------------------------------

/**
 * Computes fixed retail credit cost for a model based on semantic parameters.
 *
 * SEMANTIC-FIRST ARCHITECTURE:
 * External callers supply ONLY modelFamily and canonical semantic input.
 * The Models Management subsystem infers the operation and resolves the
 * configured active provider implementation entirely internally.
 *
 * @param {string} modelFamily
 * @param {object} cleanInput
 * @param {object} [options={}]
 * @returns {number} Integer credit cost
 */
export function calculateCost(modelFamily, cleanInput = {}, options = {}) {
  const model = getModel(modelFamily);
  const operation = inferOperation(model, cleanInput);
  const binding = resolveBinding(model.id, operation, options);
  const cost = calculateRetailCredits(model, operation, cleanInput, binding);

  modelsLogger.info(
    {
      modelFamily,
      operation,
      bindingId: `${binding.modelId}:${binding.operation}:${binding.providerId}`,
      credits: cost,
      event: LogEvents.MODELS_COST_CALCULATED,
    },
    `Cost calculated: ${cost} credits for ${modelFamily} (${operation}) via ${binding.providerId}`
  );

  return cost;
}

// --- estimatePrice ------------------------------------------------------------

/**
 * Estimates retail credit cost from raw semantic input.
 * Resolves the configured active provider implementation internally.
 */
export function estimatePrice(modelFamily, rawInput = {}, options = {}) {
  const cleanInput = validateInput(modelFamily, rawInput);
  const amount = calculateCost(modelFamily, cleanInput, options);
  const model = getModel(modelFamily);
  return {
    amount,
    currency: "credits",
    pricingVersion: "fixed_retail",
    manifestVersion: model?.version || "1.0.0",
  };
}

// --- run ----------------------------------------------------------------------

/**
 * Executes a model via the unified multi-provider runner.
 *
 * SEMANTIC-FIRST: No operation parameter. The subsystem infers the
 * correct internal operation from the semantic parameters provided.
 *
 * @param {string} modelFamily
 * @param {object} semanticParams - Canonical semantic input (prompt, input_image, etc.)
 * @param {object} [options={}]
 * @returns {Promise<object>} Execution result
 */
export async function run(modelFamily, semanticParams = {}, options = {}) {
  const model = getModel(modelFamily);
  const operation = inferOperation(model, semanticParams);

  modelsLogger.debug(
    {
      modelFamily,
      operation,
      event: "models.execution.started",
    },
    `Executing model ${modelFamily} (${operation})`
  );

  return runInternal(modelFamily, operation, semanticParams, { ...options, model });
}

// --- Registry Lifecycle & Queries --------------------------------------------

export { initRegistry, reloadRegistry };

/**
 * Returns summary stats about the loaded registry — for admin/monitoring use.
 * Does NOT expose internal registry state (Maps, raw manifests, etc.).
 *
 * @returns {{ models: number, providers: number, bindings: number }}
 */
export function getRegistryStats() {
  const { models, providers, bindings } = getRegistry();
  return {
    models: models.size,
    providers: providers.size,
    bindings: bindings.size,
  };
}

// --- Models Subsystem Errors --------------------------------------------------

export {
  ModelsSystemError,
  ValidationError,
  MissingOptionError,
  ProviderTransientError,
  ProviderRequestError,
  ProviderContentPolicyError,
  ProviderMalformedResponseError,
  OutputContractViolationError,
  UnsupportedCapabilityError,
  UnknownModelFamilyError,
  ModelNotFoundError,
  UnknownOperationError,
  OperationNotFoundError,
  BindingNotFoundError,
  BindingModelMismatchError,
  BindingOperationMismatchError,
  ConfigIntegrityError,
} from "./errors/index.js";
