/**
 * System 2: Models Management — Models Controller
 */
import { getCatalog } from "../services/catalogQueries.js";
import { getModel } from "../registry/modelRegistry.js";
import {
  validateCanonicalInput,
  validateBindingConstraints,
  getModelSchema as getModelSchemaInternal,
} from "../schema/schemaValidator.js";
import { resolveExecutionPlan } from "../registry/bindingResolver.js";
import { calculateRetailCredits } from "../pricing/pricingEngine.js";
import { ModelsNotFoundError } from "../errors.js";

const PROVIDER_LEAK_RE =
  /\b(wavespeed|runwayml|runway|ltx|google|gemini|vertex|openai|binding\s+"[^"]+")\b/gi;

function isInternalModel(model) {
  return Boolean(model?.systemOnly || model?.visibility === "internal");
}

function getPublicModelOrThrow(modelFamily) {
  const model = getModel(modelFamily);
  if (isInternalModel(model)) {
    throw new ModelsNotFoundError(`Model "${modelFamily}" not found`, { modelFamily });
  }
  return model;
}

function safePublicControllerMessage(err, fallback) {
  const raw = typeof err?.safeMessage === "string" && err.safeMessage.trim()
    ? err.safeMessage
    : typeof err?.message === "string"
      ? err.message
      : "";
  if (!raw || PROVIDER_LEAK_RE.test(raw)) {
    PROVIDER_LEAK_RE.lastIndex = 0;
    return fallback;
  }
  return raw;
}

export function formatModelDto(m) {
  return {
    key:            m.modelFamily || m.id,
    displayName:    m.displayName,
    description:    m.description || "",
    category:       m.domain,
    tier:           m.badge || "standard",
    pricing:        m.retailPricing || (m.operations && Object.values(m.operations)[0]?.retailPricing) || {},
    tags:           m.badge ? [m.badge.toLowerCase()] : [],
    icon:           m.iconUrl || "",
    badge:          m.badge || null,
    capabilities:   m.capabilities || {},
    parameters:     m.parameters || {},
  };
}

function getModelSchema(modelOrFamily) {
  const model = typeof modelOrFamily === "string" ? getPublicModelOrThrow(modelOrFamily) : modelOrFamily;
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

function getSchema(modelFamily, operation = null) {
  const model = getPublicModelOrThrow(modelFamily);

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

  return getModelSchema(model);
}

function estimatePrice(modelFamily, rawInput = {}, options = {}) {
  const model = getPublicModelOrThrow(modelFamily);
  const modelContract = getModelSchema(model);
  const cleanInput = validateCanonicalInput(modelContract.parameters, rawInput);
  const { model: planModel, route } = resolveExecutionPlan(model.id, cleanInput, options);
  validateBindingConstraints(route, cleanInput);
  const amount = calculateRetailCredits(planModel, cleanInput, route);
  return {
    amount,
    currency: "credits",
    pricingVersion: "fixed_retail",
    manifestVersion: planModel?.version || "1.0.0",
  };
}

export function handleGetCatalog(req, res) {
  const { category, domain } = req.query;
  const targetDomain = category || domain;

  const catalog = getCatalog(targetDomain ? { domain: targetDomain } : {});

  const publicModels = catalog.filter((m) => !isInternalModel(m));
  const models = publicModels.map(formatModelDto);

  res.json({
    success: true,
    data: {
      total: models.length,
      models,
      grouped: models.reduce((acc, m) => {
        (acc[m.category] = acc[m.category] || []).push(m);
        return acc;
      }, {}),
    },
  });
}

export function handleGetModelDetail(req, res) {
  const { key } = req.params;

  const catalog = getCatalog();
  const m = catalog.find((entry) => entry.modelFamily === key || entry.id === key);

  if (m) {
    return res.json({
      success: true,
      data: formatModelDto(m),
    });
  }

  return res.status(404).json({
    success: false,
    error: `Model "${key}" not found`,
    available: catalog.map((entry) => entry.modelFamily || entry.id),
  });
}

export function handleGetModelSchema(req, res) {
  const { key } = req.params;
  try {
    const schema = getModelSchema(key);
    return res.json({
      success: true,
      data: schema,
    });
  } catch (err) {
    return res.status(err.statusCode || 404).json({
      success: false,
      error: safePublicControllerMessage(err, `Model "${key}" not found`),
      code: err.code || "SCHEMA_ERROR",
    });
  }
}

export function handleEstimatePrice(req, res) {
  const { key } = req.params;
  try {
    const estimate = estimatePrice(key, req.body || {});
    return res.json({
      success: true,
      data: {
        credits: estimate.amount,
        currency: estimate.currency,
        pricingVersion: estimate.pricingVersion,
        manifestVersion: estimate.manifestVersion,
      },
    });
  } catch (err) {
    return res.status(err.statusCode || 400).json({
      success: false,
      error: safePublicControllerMessage(err, "Invalid parameters for price estimation"),
      code: err.code || "PRICING_ESTIMATION_ERROR",
    });
  }
}

export function handleGetLegacySchema(req, res) {
  const { key, operation } = req.params;
  res.setHeader("Deprecation", "true");
  res.setHeader(
    "Warning",
    `299 - "GET /api/models/:key/:operation/schema is deprecated. Use GET /api/models/:key/schema instead."`
  );
  try {
    const schema = getSchema(key, operation);
    return res.json({
      success: true,
      data: schema,
    });
  } catch (err) {
    return res.status(err.statusCode || 400).json({
      success: false,
      error: safePublicControllerMessage(err, `Model "${key}" not found`),
      code: err.code || "SCHEMA_ERROR",
    });
  }
}

export function handleEstimateLegacyPrice(req, res) {
  const { key } = req.params;
  res.setHeader("Deprecation", "true");
  res.setHeader(
    "Warning",
    `299 - "POST /api/models/:key/:operation/estimate-price is deprecated. Use POST /api/models/:key/estimate-price instead."`
  );
  try {
    const estimate = estimatePrice(key, req.body || {});
    return res.json({
      success: true,
      data: {
        credits: estimate.amount,
        currency: estimate.currency,
        pricingVersion: estimate.pricingVersion,
        manifestVersion: estimate.manifestVersion,
      },
    });
  } catch (err) {
    return res.status(err.statusCode || 400).json({
      success: false,
      error: safePublicControllerMessage(err, "Invalid parameters for price estimation"),
      code: err.code || "PRICING_ESTIMATION_ERROR",
    });
  }
}
