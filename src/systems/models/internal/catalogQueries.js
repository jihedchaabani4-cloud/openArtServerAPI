/**
 * Catalog & Pricing Queries
 * Pure query layer providing getCatalog and calculateCost without importing from the models index facade.
 */

import { getRegistry } from "./registry/modelRegistry.js";
import { getModelSchema as getModelSchemaInternal, validateBindingConstraints } from "./schema/schemaValidator.js";
import { calculateRetailCredits } from "./pricing/pricingEngine.js";
import { resolveExecutionPlan } from "./registry/bindingResolver.js";
import { createLogger, LogEvents } from "#shared";

const modelsLogger = createLogger("models");

/**
 * Returns catalog of available models matching optional filters.
 * Exposes a safe, frontend-ready Model contract without leaking provider internals.
 * Single canonical parameter representation: parameters.
 */
export function getCatalog(filters = {}) {
  const { models } = getRegistry();
  const entries = [];

  for (const [modelId, model] of models.entries()) {
    const isSystemOnly = Boolean(model.systemOnly || model.visibility === "internal");

    // Filter out system-only models by default unless explicitly requested
    if (!filters.includeSystem && !filters.systemOnly && isSystemOnly) continue;
    if (filters.systemOnly && !isSystemOnly) continue;

    const schema = model.canonicalInputs || getModelSchemaInternal(model);

    const entry = {
      id: model.id,
      modelId: model.id,
      modelFamily: model.id,
      displayName: model.displayName,
      description: model.description || "",
      iconUrl: model.iconUrl || "",
      domain: model.domain,
      parameters: schema,
      retailPricing: model.retailPricing || null,
      status: model.status || "active",
      version: model.version || "1.0.0",
    };

    if (filters.domain && entry.domain !== filters.domain) continue;
    if (filters.status && entry.status !== filters.status) continue;

    entries.push(entry);
  }

  return entries;
}

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
 * @returns {number|object} Integer credit cost or quote object
 */
export function calculateCost(modelFamily, cleanInput = {}, options = {}) {
  const { model, route, planIdentity } = resolveExecutionPlan(modelFamily, cleanInput, options);
  validateBindingConstraints(route, cleanInput);
  const cost = calculateRetailCredits(model, cleanInput, route);

  modelsLogger.info(
    {
      modelFamily,
      providerId: route.providerId,
      routeId: route.id || route.routeId || "default",
      credits: cost,
      planIdentity: planIdentity?.id,
      event: LogEvents.MODELS_COST_CALCULATED,
    },
    `Cost calculated: ${cost} credits for ${modelFamily} via ${route.providerId}`
  );

  if (options.returnQuote || options.includePlanIdentity) {
    return {
      credits: cost,
      planIdentity: planIdentity?.id || null,
      planDetails: planIdentity || null,
    };
  }

  return cost;
}
