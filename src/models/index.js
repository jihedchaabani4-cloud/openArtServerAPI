/**
 * Models Management System — Public Facade Interface
 *
 * SEALED SUBSYSTEM: All callers interact through these exported functions.
 * Backed by the Dynamic Multi-Provider Architecture (032).
 *
 * ── Model-First Architecture ─────────────────────────────────────────────────
 * External callers supply ONLY modelFamily + semantic parameters.
 * Provider selection is managed by internal Models Management configuration.
 * Provider execution routing (e.g. edit vs generation endpoints) is owned by
 * the Provider's implementation and configuration.
 *
 * Operation is NOT a public concept, NOT a required argument, and NOT a
 * generic Models Core routing key.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  initRegistry,
  getRegistry,
  getModel,
  reloadRegistry,
} from "./registry/modelRegistry.js";
import { validateCanonicalInput, validateBindingConstraints } from "./schema/schemaValidator.js";
import { calculateRetailCredits } from "./pricing/pricingEngine.js";
import { run as runInternal } from "./execution/modelRunner.js";
import { resolveBinding, resolveExecutionRoute } from "./registry/bindingResolver.js";
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
  const { models } = getRegistry();
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
      canonicalInputs: model.canonicalInputs || {},
      retailPricing: model.retailPricing || null,
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
 * Returns input schema and pricing details for a given model.
 * Optionally accepts explicit operation for schema introspection / admin tooling.
 */
export function getSchema(modelFamily, operation = null) {
  const model = getModel(modelFamily);

  if (operation && model.operations?.[operation]) {
    const opDef = model.operations[operation];
    return {
      modelFamily: model.id,
      modelId: model.id,
      operation,
      domain: model.domain,
      inputs: opDef.canonicalInputs || {},
      retailPricing: opDef.retailPricing || null,
    };
  }

  return {
    modelFamily: model.id,
    modelId: model.id,
    domain: model.domain,
    inputs:
      model.canonicalInputs ||
      (model.operations && Object.values(model.operations)[0]?.canonicalInputs) ||
      {},
    retailPricing: model.retailPricing || null,
    operations: Object.keys(model.operations || {}),
  };
}

// --- validateInput ------------------------------------------------------------

/**
 * Validates and sanitizes raw input against the model's canonical schema.
 * No operation parameter required.
 *
 * @param {string} modelFamily
 * @param {object} rawInput
 * @returns {object} cleanInput
 */
export function validateInput(modelFamily, rawInput = {}) {
  const model = getModel(modelFamily);
  const schema =
    model.canonicalInputs ||
    (model.operations && Object.values(model.operations)[0]?.canonicalInputs) ||
    {};
  return validateCanonicalInput(schema, rawInput);
}

// --- calculateCost ------------------------------------------------------------

/**
 * Computes fixed retail credit cost for a model based on semantic parameters.
 *
 * MODEL-FIRST ARCHITECTURE:
 * External callers supply ONLY modelFamily and canonical semantic input.
 * The configured provider and its execution route are resolved entirely internally.
 * Guarantees quote implementation === execution implementation.
 *
 * @param {string} modelFamily
 * @param {object} cleanInput
 * @param {object} [options={}]
 * @returns {number} Integer credit cost
 */
export function calculateCost(modelFamily, cleanInput = {}, options = {}) {
  const model = getModel(modelFamily);
  const binding = resolveBinding(model.id, options);
  const route = resolveExecutionRoute(binding, cleanInput);
  validateBindingConstraints(route, cleanInput);
  const cost = calculateRetailCredits(model, cleanInput, route);

  modelsLogger.info(
    {
      modelFamily,
      providerId: route.providerId,
      routeId: route.id || route.routeId || "default",
      credits: cost,
      event: LogEvents.MODELS_COST_CALCULATED,
    },
    `Cost calculated: ${cost} credits for ${modelFamily} via ${route.providerId}`
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
 * MODEL-FIRST: No operation parameter. The subsystem resolves the configured
 * provider and its provider-owned route from the semantic parameters provided.
 *
 * @param {string} modelFamily
 * @param {object} semanticParams - Canonical semantic input (prompt, input_image, etc.)
 * @param {object} [options={}]
 * @returns {Promise<object>} Execution result
 */
export async function run(modelFamily, semanticParams = {}, options = {}) {
  const model = getModel(modelFamily);

  modelsLogger.debug(
    {
      modelFamily,
      event: "models.execution.started",
    },
    `Executing model ${modelFamily}`
  );

  return runInternal(modelFamily, semanticParams, { ...options, model });
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
