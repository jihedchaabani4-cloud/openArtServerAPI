/**
 * System 2: Models Management — Public Tools Gateway (#models/tools)
 *
 * Pure Black-Box interface for model catalog, schema validation, manifest credit
 * estimation, and model execution. Zero DB, zero Redis, zero provider leaks.
 */

import {
  initRegistry,
  getModel,
  reloadRegistry as reloadRegistryInternal,
} from "../internal/registry/modelRegistry.js";
import {
  validateCanonicalInput,
  getModelSchema as getModelSchemaInternal,
} from "../internal/schema/schemaValidator.js";
import { getModelConfig as getInternalModelConfig } from "../internal/services/catalogPresentation.js";
import {
  calculateCost as calculateCostInternal,
  getCatalog,
} from "../internal/services/catalogQueries.js";
import { llmService } from "../internal/services/LLMService.js";
import { run as runInternal } from "../internal/execution/modelRunner.js";
import { createLogger, envConfig } from "#shared";

import {
  ModelsError,
  ModelsValidationError,
  ModelsNotFoundError,
  ModelsConfigurationError,
  ModelsProviderError,
} from "../internal/errors.js";

const modelsLogger = createLogger("models");

// Eagerly initialize the manifest registry on module load
try {
  initRegistry();
} catch (err) {
  modelsLogger.error({ error: err.message }, `Registry boot initialization error: ${err.message}`);
}

function sanitizeExecutionResult(res) {
  if (!res || typeof res !== "object") return res;
  const cleanData =
    res.data && typeof res.data === "object"
      ? {
          images: Array.isArray(res.data.images) ? res.data.images : [],
          ...(Array.isArray(res.data.videos) ? { videos: res.data.videos } : {}),
          ...(res.data.url ? { url: res.data.url } : {}),
          text: res.data.text ?? null,
          content: res.data.content ?? null,
        }
      : null;

  const cleanMetadata = res.metadata
    ? {
        generationId: res.metadata.generationId ?? null,
        modelId: res.metadata.modelId ?? null,
        operation: res.metadata.operation ?? "execution",
        creditsCharged: res.metadata.creditsCharged ?? 0,
        durationMs: res.metadata.durationMs ?? 0,
      }
    : {};

  return {
    status: res.status || "success",
    data: cleanData,
    content: res.content || "",
    text: res.text || "",
    images: Array.isArray(res.images) ? res.images : [],
    videos: Array.isArray(res.videos) ? res.videos : [],
    metadata: cleanMetadata,
  };
}

function sanitizeRunnerOptions(options = {}) {
  const safe = { ...options };
  // Never allow callers to inject raw DB clients into Models
  delete safe.dbClient;
  if (!envConfig.isTest) {
    delete safe._testBinding;
    delete safe._testBindingId;
    delete safe.sdkRunner;
    delete safe.sdkClient;
    delete safe.runtimeExecutor;
  }
  return safe;
}

// ── Inter-System Tools Functions (System 2 Black-Box Interface) ────────────────

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
    let found = config.models.find(
      (m) => m.key === modelIdOrOptions || m.modelFamily === modelIdOrOptions || m.id === modelIdOrOptions
    );
    if (!found) {
      let resolved = null;
      try {
        resolved = getModel(modelIdOrOptions);
      } catch {
        resolved = null;
      }
      if (resolved?.id) {
        found = config.models.find(
          (m) => m.key === resolved.id || m.modelFamily === resolved.id || m.id === resolved.id
        );
      }
    }
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
 * Calculates retail credit cost for a model without leaking provider/binding internals.
 *
 * @param {string} modelFamily
 * @param {object} [cleanInput={}]
 * @param {object} [options={}]
 * @returns {number|object}
 */
export function calculateCost(modelFamily, cleanInput = {}, options = {}) {
  const safeOptions = sanitizeRunnerOptions(options);
  const res = calculateCostInternal(modelFamily, cleanInput, safeOptions);
  if (res && typeof res === "object") {
    return {
      credits: res.credits,
      modelId: res.planDetails?.modelId || modelFamily,
      configVersion: res.planDetails?.configVersion || "1.0.0",
    };
  }
  return res;
}

/**
 * Executes AI generation through the unified Model Runner and returns a clean DTO
 * stripped of provider internals (`_internal`, raw SDK payloads, route/provider IDs).
 *
 * @param {object} input
 * @returns {Promise<object>} Clean generation output DTO
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
  const semanticParams = { ...params };
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

  const safeOptions = sanitizeRunnerOptions(options);
  const rawResult = await runInternal(modelId, semanticParams, { userId, ...safeOptions, model });
  return sanitizeExecutionResult(rawResult);
}

/**
 * Executes unified LLM or Multimodal Vision generation via configured text/vision models.
 *
 * @param {object} input
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
  timeoutMs = null,
  ...options
} = {}) {
  const safeOptions = sanitizeRunnerOptions(options);
  const mergedOptions = timeoutMs != null ? { ...safeOptions, timeoutMs } : safeOptions;
  return llmService.generate({
    prompt,
    systemInstruction,
    images,
    jsonMode,
    model,
    userId,
    schema,
    timeoutMs,
    options: mergedOptions,
  });
}

/**
 * Safely hot-reloads model manifests and returns a non-leaking summary DTO
 * (never exposes raw internal registry Maps or provider/binding details).
 *
 * @returns {{ reloaded: true, models: number }}
 */
export function reloadRegistry() {
  const { models } = reloadRegistryInternal();
  return {
    reloaded: true,
    models: models.size,
  };
}

// ── Public System 2 Tools Gateway Exports (Minimal Sealed Surface) ────────────

export {
  getCatalog,
  ModelsError,
  ModelsValidationError,
  ModelsNotFoundError,
  ModelsConfigurationError,
  ModelsProviderError,
};
