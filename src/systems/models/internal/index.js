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
import { validateCanonicalInput, validateBindingConstraints, getModelSchema as getModelSchemaInternal } from "./schema/schemaValidator.js";
import { calculateRetailCredits } from "./pricing/pricingEngine.js";
import { run as runInternal } from "./execution/modelRunner.js";
import { resolveExecutionPlan } from "./registry/bindingResolver.js";
import { createLogger, LogEvents } from "#shared";

const modelsLogger = createLogger("models");

// Eagerly initialize the registry on module load
try {
  initRegistry();
} catch (err) {
  modelsLogger.error({ error: err.message }, `Registry boot initialization error: ${err.message}`);
}

import { getCatalog, calculateCost } from "./catalogQueries.js";

// Re-export query functions
export { getCatalog, calculateCost };

// --- getModelSchema -----------------------------------------------------------

/**
 * Returns the authoritative Model-level parameter contract and metadata.
 * Directly consumable by frontend UI builders and application callers.
 * Does NOT require or accept an operation parameter.
 * Single canonical parameter representation: parameters.
 *
 * @param {string|object} modelOrFamily - Canonical model ID or model object
 * @returns {object} Full Model contract
 */
export function getModelSchema(modelOrFamily) {
  const model = typeof modelOrFamily === "string" ? getModel(modelOrFamily) : modelOrFamily;
  const schema = getModelSchemaInternal(model);

  return {
    id: model.id,
    modelId: model.id,
    modelFamily: model.id,
    displayName: model.displayName,
    description: model.description || "",
    domain: model.domain,
    parameters: schema,
    retailPricing: model.retailPricing || null,
    status: model.status || "active",
    version: model.version || "1.0.0",
  };
}

// --- getSchema (Legacy Compatibility Helper) ----------------------------------

/**
 * Legacy schema introspection helper.
 * @deprecated Use getModelSchema(modelFamily) instead.
 */
export function getSchema(modelFamily, operation = null) {
  const model = getModel(modelFamily);

  if (operation && model.operations?.[operation]) {
    const opDef = model.operations[operation];
    return {
      id: model.id,
      modelFamily: model.id,
      modelId: model.id,
      operation,
      domain: model.domain,
      inputs: opDef.canonicalInputs || model.canonicalInputs || {},
      parameters: opDef.canonicalInputs || model.canonicalInputs || {},
      retailPricing: opDef.retailPricing || model.retailPricing || null,
    };
  }

  return getModelSchema(modelFamily);
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
  const modelContract = getModelSchema(model);
  return validateCanonicalInput(modelContract.parameters, rawInput);
}


// --- estimatePrice ------------------------------------------------------------

/**
 * Estimates retail credit cost from raw semantic input.
 * Resolves the configured active provider implementation internally.
 */
export function estimatePrice(modelFamily, rawInput = {}, options = {}) {
  const cleanInput = validateInput(modelFamily, rawInput);
  const { model, route, planIdentity } = resolveExecutionPlan(modelFamily, cleanInput, options);
  validateBindingConstraints(route, cleanInput);
  const amount = calculateRetailCredits(model, cleanInput, route);
  return {
    amount,
    currency: "credits",
    pricingVersion: "fixed_retail",
    manifestVersion: model?.version || "1.0.0",
    planIdentity: planIdentity?.id || null,
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
  NoEligibleBindingError,
} from "./errors/index.js";

export { getModelConfig } from "./catalogPresentation.js";


