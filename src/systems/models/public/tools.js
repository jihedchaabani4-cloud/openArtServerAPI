/**
 * System 2: Models Management — Public Tools Gateway (#models/tools)
 *
 * Governed by:
 * - docs/architecture/constitution/01_business_systems_architecture.md (System 2)
 * - docs/architecture/constitution/02_architecture_rules_and_agent_guardrails.md
 *
 * Inter-system tool functions accept plain DTOs and return plain DTOs.
 * Model pricing calculations are pure financial estimates strictly decoupled
 * from Billing's wallet ledger (Rule 10).
 */

import {
  initRegistry,
  getRegistry,
  getModel,
  reloadRegistry,
  validateCanonicalInput,
  validateBindingConstraints,
  getModelSchemaInternal,
  getModelConfig as getInternalModelConfig,
} from "../internal/registry/index.js";

import {
  calculateRetailCredits,
  calculateWholesaleCostUsd,
  calculateMargin,
  calculateCost,
  getCatalog,
  estimatePrice,
  PricingService,
} from "../internal/pricing/index.js";

import {
  llmService,
  LLMService,
  PromptService,
} from "../internal/providers/index.js";

import {
  run,
} from "../internal/execution/index.js";

import {
  ModelsError,
  ModelsValidationError,
  ModelsNotFoundError,
  ModelsConfigurationError,
  ModelsProviderError,
  ModelsSystemError,
  ValidationError,
  InvalidEnumValueError,
  UnknownParameterError,
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
} from "../internal/errors.js";

// ── Inter-System Tools Functions (System 2 Interface) ──────────────────────────

/**
 * Returns the configuration for a single model (if modelId string provided)
 * or the full catalog presentation configuration dictionary.
 *
 * @param {string|object} [modelIdOrOptions]
 * @returns {object} Model config or { models: [...] }
 */
export function getModelConfig(modelIdOrOptions = {}) {
  if (typeof modelIdOrOptions === "string") {
    const config = getInternalModelConfig();
    const found = config.models.find(
      (m) => m.key === modelIdOrOptions || m.modelFamily === modelIdOrOptions || m.id === modelIdOrOptions
    );
    if (!found) {
      throw new ModelsNotFoundError(`Model "${modelIdOrOptions}" not found in catalog configuration`, {
        modelFamily: modelIdOrOptions,
      });
    }
    return found;
  }
  return getInternalModelConfig(modelIdOrOptions);
}

/**
 * Returns canonical model parameter schema and metadata.
 *
 * @param {string|object} modelOrFamily
 * @returns {object}
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

/**
 * Legacy schema helper for backward compatibility.
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

/**
 * Validates and sanitizes raw input against model's canonical schema.
 *
 * @param {string} modelId
 * @param {object} params
 * @returns {object} Clean sanitized input DTO
 */
export function validateModelInputs(modelId, params = {}) {
  return validateInput(modelId, params);
}

/**
 * Validates and sanitizes input (legacy signature).
 */
export function validateInput(modelFamily, rawInput = {}) {
  const model = getModel(modelFamily);
  const modelContract = getModelSchema(model);
  return validateCanonicalInput(modelContract.parameters, rawInput);
}

/**
 * Calculates operation credit cost. Pure financial calculation.
 *
 * @param {object} input
 * @param {string} input.modelId - Target model ID
 * @param {string} [input.operation] - Operation name (optional)
 * @param {object} [input.params] - Semantic parameters
 * @returns {{ credits: number, currency: string, pricingVersion: string, planIdentity?: string }}
 */
export function calculateOperationCost({ modelId, operation = null, params = {} } = {}) {
  if (!modelId) {
    throw new ModelsValidationError("modelId is required to calculate operation cost");
  }
  const estimate = estimatePrice(modelId, params);
  return {
    credits: estimate.amount,
    currency: estimate.currency || "credits",
    pricingVersion: estimate.pricingVersion || "fixed_retail",
    planIdentity: estimate.planIdentity || null,
    manifestVersion: estimate.manifestVersion || "1.0.0",
  };
}

/**
 * Executes AI generation through the unified Model Runner.
 *
 * @param {object} input
 * @param {string} input.modelId - Logical model key (e.g. 'flux-schnell', 'kling-v1.6')
 * @param {string} [input.prompt] - Prompt text
 * @param {object} [input.params={}] - Semantic model parameters
 * @param {string[]} [input.references=[]] - Optional array of reference media URLs
 * @param {string} [input.userId] - Calling user ID for billing audit
 * @param {object} [options={}] - Additional runner options
 * @returns {Promise<object>} Generation output DTO
 */
export async function executeGeneration({
  modelId,
  prompt,
  params = {},
  references = [],
  userId = null,
  ...options
} = {}) {
  if (!modelId) {
    throw new ModelsValidationError("modelId is required for executeGeneration");
  }
  const semanticParams = {
    ...params,
  };
  if (prompt !== undefined) {
    semanticParams.prompt = prompt;
  }
  if (Array.isArray(references) && references.length > 0 && !semanticParams.references) {
    semanticParams.references = references;
  }

  return run(modelId, semanticParams, { userId, ...options });
}

/**
 * Executes unified LLM or Multimodal Vision generation.
 *
 * @param {object} input
 * @param {string} [input.model] - Model override (defaults to gemini-3.1-flash-lite)
 * @param {string} input.prompt - Text prompt
 * @param {string} [input.systemInstruction] - Role instruction
 * @param {string[]} [input.images] - Multimodal image references
 * @param {boolean} [input.jsonMode=false] - Whether output should parse to JSON
 * @param {object} [input.schema] - Optional schema for structured output
 * @param {string} [input.userId] - Calling user ID
 * @param {object} [options={}] - Extra runner options
 * @returns {Promise<{ raw: string, content: string, json?: object, model: string, durationMs: number }>}
 */
export async function executeLLM({
  model,
  prompt,
  systemInstruction = "",
  images = [],
  jsonMode = false,
  schema = null,
  userId = null,
  ...options
} = {}) {
  return llmService.generate({
    prompt,
    systemInstruction,
    images,
    jsonMode,
    model,
    userId,
    schema,
    options,
  });
}

/**
 * Summary stats for monitoring.
 */
export function getRegistryStats() {
  const { models, providers, bindings } = getRegistry();
  return {
    models: models.size,
    providers: providers.size,
    bindings: bindings.size,
  };
}

// ── Facade Re-exports for Backward Compatibility ──────────────────────────────

export {
  // Registry & Inspection
  initRegistry,
  reloadRegistry,
  getCatalog,
  calculateCost,
  estimatePrice,
  run,
  calculateRetailCredits,
  calculateWholesaleCostUsd,
  calculateMargin,

  // Services
  PricingService,
  LLMService,
  PromptService,
  llmService,

  // Typed Errors
  ModelsError,
  ModelsValidationError,
  ModelsNotFoundError,
  ModelsConfigurationError,
  ModelsProviderError,
  ModelsSystemError,
  ValidationError,
  InvalidEnumValueError,
  UnknownParameterError,
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
};

export default {
  // Inter-system tools
  getModelConfig,
  getModelSchema,
  getSchema,
  validateModelInputs,
  validateInput,
  calculateOperationCost,
  executeGeneration,
  executeLLM,
  getRegistryStats,

  // Facade functions
  initRegistry,
  reloadRegistry,
  getCatalog,
  calculateCost,
  estimatePrice,
  run,
  calculateRetailCredits,
  calculateWholesaleCostUsd,
  calculateMargin,
  PricingService,
  LLMService,
  PromptService,
  llmService,

  // Errors
  ModelsError,
  ModelsValidationError,
  ModelsNotFoundError,
  ModelsConfigurationError,
  ModelsProviderError,
};
