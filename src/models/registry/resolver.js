import { getRegistry } from "./loader.js";
import { UnknownModelFamilyError, UnknownOperationError } from "../errors/index.js";

/**
 * Resolves a complete, client-facing model operation schema by merging
 * shared canonical parameters with model-specific constraints and allowed values.
 *
 * @param {string} modelFamilyId
 * @param {string} operationName
 * @returns {object} Fully resolved ModelOperationSchema
 */
export function resolveModelSchema(modelFamilyId, operationName) {
  const { families, deployments, parameters } = getRegistry();

  const normalizedId = (!families.has(modelFamilyId) && modelFamilyId === "nano_banana_pro") ? "nanobana_pro" : modelFamilyId;
  const family = families.get(normalizedId);
  let operationDef = family?.operations?.[operationName];

  // If not declared on family, check servable deployment as fallback
  if (!operationDef) {
    for (const deployment of deployments.values()) {
      if (
        deployment.modelFamily === modelFamilyId &&
        ["active", "deprecated"].includes(deployment.status) &&
        deployment.operations?.[operationName]
      ) {
        operationDef = deployment.operations[operationName];
        break;
      }
    }
  }

  if (!family && !operationDef) {
    throw new UnknownModelFamilyError(modelFamilyId);
  }

  if (!operationDef) {
    throw new UnknownOperationError(modelFamilyId, operationName);
  }

  const rawInputs = operationDef.inputs || {};
  const resolvedInputs = {};

  for (const [paramKey, inputSpec] of Object.entries(rawInputs)) {
    if (inputSpec.ref) {
      const canonical = parameters.get(inputSpec.ref);
      resolvedInputs[paramKey] = {
        ...(canonical || {}),
        ...inputSpec,
        id: paramKey,
        type: inputSpec.type || canonical?.type || "string",
        description: inputSpec.description || canonical?.description || "",
        uiHint: inputSpec.uiHint || canonical?.uiHint || null,
        required: Boolean(inputSpec.required),
        default: inputSpec.default !== undefined ? inputSpec.default : null,
        ...(inputSpec.values ? { values: [...inputSpec.values] } : {}),
        ...(inputSpec.min !== undefined ? { min: inputSpec.min } : {}),
        ...(inputSpec.max !== undefined ? { max: inputSpec.max } : {}),
        ...(inputSpec.max_length !== undefined ? { maxLength: inputSpec.max_length } : {})
      };
    } else {
      resolvedInputs[paramKey] = {
        ...inputSpec,
        id: paramKey,
        type: inputSpec.type || "string",
        description: inputSpec.description || "",
        uiHint: inputSpec.uiHint || null,
        required: Boolean(inputSpec.required),
        default: inputSpec.default !== undefined ? inputSpec.default : null,
        ...(inputSpec.values ? { values: [...inputSpec.values] } : {}),
        ...(inputSpec.min !== undefined ? { min: inputSpec.min } : {}),
        ...(inputSpec.max !== undefined ? { max: inputSpec.max } : {}),
        ...(inputSpec.max_length !== undefined ? { maxLength: inputSpec.max_length } : {})
      };
    }
  }

  return {
    model: modelFamilyId,
    operation: operationName,
    schemaVersion: operationDef.schemaVersion || "2026-09-v1",
    inputs: resolvedInputs,
    outputs: operationDef.outputs || { type: family?.domain || "image" }
  };
}
