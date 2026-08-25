/**
 * Models Management System — Public Interface (V2)
 *
 * SEALED SUBSYSTEM: Only 5 functions are exported.
 * All callers must use this module; direct imports from sub-modules are forbidden.
 */

import { getRegistry } from "./registry/loader.js";
import { validateInput as validateInputInternal } from "./validation/validationService.js";
import { calculateCost as calculateCostInternal } from "./pricing/modelPricingService.js";
import { resolveServableDeployment as resolveDeployment } from "./deployment/deploymentResolver.js";
import { run as runInternal } from "./execution/runService.js";

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
  const deployment = resolveDeployment(modelFamily, operation);
  const op = deployment.operations[operation];
  return { inputs: op.inputs || {}, outputs: op.outputs || {} };
}

// --- validateInput ------------------------------------------------------------

export function validateInput(modelFamily, operation, rawInput) {
  return validateInputInternal(modelFamily, operation, rawInput);
}

// --- calculateCost ------------------------------------------------------------

export function calculateCost(modelFamily, operation, cleanInput) {
  return calculateCostInternal(modelFamily, operation, cleanInput);
}

// --- run ----------------------------------------------------------------------

export async function run(modelFamily, operation, cleanInput, context = {}) {
  // If operation was omitted or auto, resolve it dynamically
  const resolvedOp = operation || resolveOperation(cleanInput, context.domain || "image");
  return runInternal(modelFamily, resolvedOp, cleanInput, context);
}

// --- resolveOperation ---------------------------------------------------------

export function resolveOperation(inputs = {}, targetOutput = "image") {
  if (inputs.operation) return inputs.operation;

  const hasImage = Boolean(inputs.image_url || inputs.image || inputs.images?.length || inputs.input_assets?.length || inputs.references?.length);
  const hasVideo = Boolean(inputs.video_url || inputs.video);
  const isUpscale = Boolean(inputs.factor || inputs.scale || inputs.isUpscale || inputs.target_resolution);

  if (targetOutput === "video") {
    if (hasVideo) return "video_to_video";
    if (hasImage) return "image_to_video";
    return "text_to_video";
  }

  if (targetOutput === "image") {
    if (isUpscale) return "image_upscale";
    if (hasImage) return "edit";
    return "text_to_image";
  }

  if (targetOutput === "text") {
    return "chat_completion";
  }

  return "text_to_image";
}
