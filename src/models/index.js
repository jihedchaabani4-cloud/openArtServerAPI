/**
 * Models Management System — Public Facade Interface
 *
 * SEALED SUBSYSTEM: All callers interact through these exported functions.
 * Backed by the Dynamic Multi-Provider Architecture (032).
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

const modelsLogger = createLogger("models");

// Eagerly initialize the registry on module load
try {
  initRegistry();
} catch (err) {
  modelsLogger.error({ error: err.message }, `Registry boot initialization error: ${err.message}`);
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
 */
export function validateInput(modelFamily, operation, rawInput = {}) {
  const model = getModel(modelFamily);
  const opDef = model.operations?.[operation];
  if (!opDef) {
    throw new Error(`Operation "${operation}" not supported for model "${modelFamily}"`);
  }

  return validateCanonicalInput(opDef, rawInput);
}

// --- calculateCost ------------------------------------------------------------

/**
 * Computes fixed retail credit cost for a model operation.
 *
 * MODEL-FIRST ARCHITECTURE:
 * External callers supply ONLY modelFamily, operation, and canonical input.
 * The Models Management subsystem resolves the configured active provider
 * implementation internally.
 *
 * @param {string} modelFamily
 * @param {string} operation
 * @param {object} cleanInput
 * @param {object} [options={}]
 * @returns {number} Integer credit cost
 */
export function calculateCost(modelFamily, operation, cleanInput = {}, options = {}) {
  const model = getModel(modelFamily);
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
 * Estimates retail credit cost from raw input.
 * Resolves the configured active provider implementation internally.
 */
export function estimatePrice(modelFamily, operation, rawInput = {}, options = {}) {
  const cleanInput = validateInput(modelFamily, operation, rawInput);
  const amount = calculateCost(modelFamily, operation, cleanInput, options);
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
 * Executes a model operation via the unified multi-provider runner.
 */
export async function run(modelFamily, operation, cleanInput = {}, options = {}) {
  const resolvedOp = operation || resolveOperation(cleanInput, options.domain || "image");

  modelsLogger.debug(
    {
      modelFamily,
      operation: resolvedOp,
      event: "models.execution.started",
    },
    `Executing model ${modelFamily} (${resolvedOp})`
  );

  return runInternal(modelFamily, resolvedOp, cleanInput, options);
}

// --- resolveOperation ---------------------------------------------------------

/**
 * Workflow compatibility helper: infers canonical operation from raw inputs.
 */
export function resolveOperation(inputs = {}, targetOutput = "image") {
  if (inputs.operation) return inputs.operation;

  const hasImage = Boolean(
    inputs.image_url || inputs.image || inputs.images?.length || inputs.input_assets?.length
  );

  let inferredOp;
  if (targetOutput === "image") {
    inferredOp = hasImage ? "edit" : "text_to_image";
  } else if (targetOutput === "text") {
    inferredOp = "chat_completion";
  } else {
    inferredOp = "text_to_image";
  }

  modelsLogger.warn(
    { targetOutput, inferredOp, inputKeys: Object.keys(inputs) },
    `[resolveOperation] Operation was inferred as "${inferredOp}" from inputs. Consider passing explicit "operation".`
  );

  return inferredOp;
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

