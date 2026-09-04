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
import { validateCanonicalInput } from "./registry/schemaValidator.js";
import { calculateRetailCredits } from "./execution/pricingCalculator.js";
import { run as runInternal } from "./execution/modelRunner.js";
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
    const activeProviders = new Set();

    for (const opKey of operations) {
      const opDef = model.operations[opKey];
      const bindings = bindingIndex.get(`${modelId}:${opKey}`) || [];

      for (const b of bindings) {
        if (b.status === "active") {
          activeProviders.add(b.providerId);
        }
      }

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
      activeProviders: Array.from(activeProviders),
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

  return validateCanonicalInput(opDef.canonicalInputs || {}, rawInput);
}

// --- calculateCost ------------------------------------------------------------

/**
 * Computes fixed retail credit cost for a model operation.
 */
export function calculateCost(modelFamily, operation, cleanInput = {}) {
  const model = getModel(modelFamily);
  const cost = calculateRetailCredits(model, operation, cleanInput);

  modelsLogger.info(
    {
      modelFamily,
      operation,
      credits: cost,
      event: LogEvents.MODELS_COST_CALCULATED,
    },
    `Cost calculated: ${cost} credits for ${modelFamily} (${operation})`
  );

  return cost;
}

// --- estimatePrice ------------------------------------------------------------

/**
 * Estimates retail credit cost from raw input.
 */
export function estimatePrice(modelFamily, operation, rawInput = {}) {
  const cleanInput = validateInput(modelFamily, operation, rawInput);
  const amount = calculateCost(modelFamily, operation, cleanInput);
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
export async function run(modelFamily, operation, cleanInput, options = {}) {
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

// --- reloadRegistry -----------------------------------------------------------

export { reloadRegistry };

