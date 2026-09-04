/**
 * Models Management System — Public Interface (V2)
 *
 * SEALED SUBSYSTEM: Only 5 functions are exported.
 * All callers must use this module; direct imports from sub-modules are forbidden.
 */

import { getRegistry } from "./registry/loader.js";
import { validateInput as validateInputInternal } from "./validation/validationService.js";
import { calculateCost as calculateCostInternal } from "./pricing/modelPricingService.js";
import { evaluatePricing } from "./pricing/pricingEngine.js";
import { resolveServableDeployment as resolveDeployment } from "./deployment/deploymentResolver.js";
import { resolveModelSchema } from "./registry/resolver.js";
import { run as runInternal } from "./execution/runService.js";
import { createLogger, LogEvents } from "../infrastructure/logging/index.js";

const modelsLogger = createLogger("models");

// --- getCatalog ---------------------------------------------------------------

export function getCatalog(filters = {}) {
  const { families, deployments } = getRegistry();
  const entries = [];

  for (const [familyId, family] of families) {
    const familyDeployments = [...deployments.values()].filter(
      (d) => d.modelFamily === familyId
    );
    if (familyDeployments.length === 0) continue;

    const operations = [
      ...new Set(familyDeployments.flatMap((d) => Object.keys(d.operations || {}))),
    ];

    const rep =
      familyDeployments.find((d) => d.status === "active") ||
      familyDeployments.find((d) => d.status === "deprecated") ||
      familyDeployments[0];

    const operationDetails = {};
    for (const opKey of operations) {
      const opDef = rep.operations?.[opKey];
      if (opDef) {
        operationDetails[opKey] = {
          inputs: opDef.inputs || {},
          pricing: opDef.pricing || null,
        };
      }
    }

    const entry = {
      modelFamily: familyId,
      displayName: family.displayName,
      description: family.description || "",
      iconUrl: family.iconUrl || "",
      badge: family.badge || null,
      domain: family.domain,
      operations,
      operationDetails,
      provider: rep.provider,
      lifecycleStatus: rep.status,
    };

    if (filters.domain && entry.domain !== filters.domain) continue;
    if (filters.operation && !entry.operations.includes(filters.operation)) continue;
    if (filters.status && entry.lifecycleStatus !== filters.status) continue;

    entries.push(entry);
  }

  return entries;
}

// --- getSchema ----------------------------------------------------------------
 
export function getSchema(modelFamily, operation) {
  return resolveModelSchema(modelFamily, operation);
}

// --- validateInput ------------------------------------------------------------

export function validateInput(modelFamily, operation, rawInput) {
  return validateInputInternal(modelFamily, operation, rawInput);
}

// --- calculateCost ------------------------------------------------------------

export function calculateCost(modelFamily, operation, cleanInput) {
  const cost = calculateCostInternal(modelFamily, operation, cleanInput);
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

export function estimatePrice(modelFamily, operation, rawInput = {}) {
  const cleanInput = validateInputInternal(modelFamily, operation, rawInput);
  return evaluatePricing(modelFamily, operation, cleanInput);
}

// --- run ----------------------------------------------------------------------

export async function run(modelFamily, operation, cleanInput, context = {}) {
  // If operation was omitted or auto, resolve it dynamically
  const resolvedOp = operation || resolveOperation(cleanInput, context.domain || "image");
  modelsLogger.debug(
    {
      modelFamily,
      operation: resolvedOp,
      event: LogEvents.MODELS_EXECUTION_STARTED,
    },
    `Executing model ${modelFamily} (${resolvedOp})`
  );
  return runInternal(modelFamily, resolvedOp, cleanInput, context);
}

// --- resolveOperation ---------------------------------------------------------

export function resolveOperation(inputs = {}, targetOutput = "image") {
  if (inputs.operation) return inputs.operation;

  const hasImage = Boolean(inputs.image_url || inputs.image || inputs.images?.length || inputs.input_assets?.length);

  if (targetOutput === "image") {
    if (hasImage) return "edit";
    return "text_to_image";
  }

  if (targetOutput === "text") {
    return "chat_completion";
  }

  return "text_to_image";
}

