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
} from "../internal/registry/modelRegistry.js";
import {
  validateCanonicalInput,
  getModelSchema as getModelSchemaInternal,
} from "../internal/schema/schemaValidator.js";
import { getModelConfig as getInternalModelConfig } from "../internal/services/catalogPresentation.js";
import {
  calculateCost,
  getCatalog,
} from "../internal/services/catalogQueries.js";
import { PricingService } from "../internal/services/PricingService.js";
import {
  llmService,
  BillingContextMissingError,
  ALLOWED_INTERNAL_REASONS,
} from "../internal/services/LLMService.js";
import { promptService } from "../internal/services/PromptService.js";
import { run as runInternal } from "../internal/execution/modelRunner.js";
import { createLogger } from "#shared";

import {
  ModelsError,
  ModelsValidationError,
  ModelsNotFoundError,
  ModelsConfigurationError,
  ModelsProviderError,
  ModelsSystemError,
  ValidationError,
  MissingOptionError,
  ProviderTransientError,
  ProviderRequestError,
  OutputContractViolationError,
  UnsupportedCapabilityError,
  UnknownModelFamilyError,
  UnknownOperationError,
  BindingNotFoundError,
  BindingModelMismatchError,
  BindingOperationMismatchError,
  ConfigIntegrityError,
} from "../internal/errors.js";

const modelsLogger = createLogger("models");

// Eagerly initialize the registry on module load
try {
  initRegistry();
} catch (err) {
  modelsLogger.error({ error: err.message }, `Registry boot initialization error: ${err.message}`);
}

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
    return { id: found.id || found.key, ...found };
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
 * Validates and sanitizes raw input against model's canonical schema.
 *
 * @param {string} modelId
 * @param {object} params
 * @returns {object} Clean sanitized input DTO
 */
export function validateModelInputs(modelId, params = {}) {
  const model = getModel(modelId);
  const modelContract = getModelSchema(model);
  return validateCanonicalInput(modelContract.parameters, params);
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

  const model = getModel(modelId);
  modelsLogger.debug(
    {
      modelFamily: modelId,
      event: "models.execution.started",
    },
    `Executing model ${modelId}`
  );

  return runInternal(modelId, semanticParams, { userId, ...options, model });
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

// ── Public System 2 Tools Gateway Exports ─────────────────────────────────────

export {
  // Catalog & Execution Gateway (imported)
  getCatalog,
  calculateCost,
  initRegistry,
  reloadRegistry,

  // Services
  PricingService,
  llmService,
  promptService,
  BillingContextMissingError,
  ALLOWED_INTERNAL_REASONS,

  // Typed Errors
  ModelsError,
  ModelsValidationError,
  ModelsNotFoundError,
  ModelsConfigurationError,
  ModelsProviderError,
  ModelsSystemError,
  ValidationError,
  MissingOptionError,
  ProviderTransientError,
  ProviderRequestError,
  OutputContractViolationError,
  UnsupportedCapabilityError,
  UnknownModelFamilyError,
  UnknownOperationError,
  BindingNotFoundError,
  BindingModelMismatchError,
  BindingOperationMismatchError,
  ConfigIntegrityError,
};

export default {
  // Inter-system tools
  getModelConfig,
  getModelSchema,
  validateModelInputs,
  calculateCost,
  getCatalog,
  executeGeneration,
  executeLLM,
  initRegistry,
  reloadRegistry,
  getRegistryStats,

  // Services
  PricingService,
  llmService,
  promptService,

  // Errors
  ModelsError,
  ModelsValidationError,
  ModelsNotFoundError,
  ModelsConfigurationError,
  ModelsProviderError,
};
