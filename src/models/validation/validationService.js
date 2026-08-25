import {
  validateString,
  validateEnum,
  validateInteger,
  validateFloat,
  validateBoolean,
} from "./types/scalarTypes.js";
import {
  validateImageUrl,
  validateImageUrlArray,
  validateMessageArray,
} from "./types/complexTypes.js";
import {
  ValidationError,
  UnknownModelFamilyError,
  UnknownOperationError,
} from "../errors/index.js";
import { getRegistry } from "../registry/loader.js";

const TYPE_VALIDATORS = {
  string: validateString,
  enum: validateEnum,
  integer: validateInteger,
  float: validateFloat,
  boolean: validateBoolean,
  image_url: validateImageUrl,
  "image_url[]": validateImageUrlArray,
  "message[]": validateMessageArray,
};

export function stripUnknownFields(rawInput = {}, inputsSchema = {}) {
  const allowedKeys = new Set(Object.keys(inputsSchema));
  const clean = {};
  for (const [key, value] of Object.entries(rawInput)) {
    if (allowedKeys.has(key) && key !== "__proto__" && key !== "constructor") {
      clean[key] = value;
    }
  }
  return clean;
}

export function validateField(key, value, fieldDef = {}) {
  const validator = TYPE_VALIDATORS[fieldDef.type];
  if (!validator) {
    throw new ValidationError(`Unknown input field type: "${fieldDef.type}"`, { field: key });
  }
  return validator(key, value, fieldDef);
}

export function applyDefaults(cleanInput = {}, inputsSchema = {}) {
  const result = { ...cleanInput };
  for (const [key, fieldDef] of Object.entries(inputsSchema)) {
    if (result[key] === undefined && fieldDef.default !== undefined) {
      result[key] = fieldDef.default;
    }
  }
  return result;
}

export function validateInput(modelFamily, operation, rawInput = {}) {
  if (!rawInput || typeof rawInput !== "object") {
    throw new ValidationError("Input must be a valid object");
  }

  const { families, deployments } = getRegistry();
  if (!families.has(modelFamily)) {
    throw new UnknownModelFamilyError(modelFamily);
  }

  // Find deployment serving this operation
  let targetDeployment = null;
  let opConfig = null;

  for (const dep of deployments.values()) {
    if (dep.modelFamily === modelFamily && dep.operations && dep.operations[operation]) {
      targetDeployment = dep;
      opConfig = dep.operations[operation];
      break;
    }
  }

  if (!opConfig) {
    throw new UnknownOperationError(modelFamily, operation);
  }

  const inputsSchema = opConfig.inputs || {};

  // 1. Strip unknown fields
  const stripped = stripUnknownFields(rawInput, inputsSchema);

  // 2. Validate declared fields & check required
  for (const [key, fieldDef] of Object.entries(inputsSchema)) {
    const val = stripped[key];
    if (val === undefined || val === null) {
      if (fieldDef.required) {
        throw new ValidationError(`Missing required field: "${key}"`, { field: key });
      }
    } else {
      stripped[key] = validateField(key, val, fieldDef);
    }
  }

  // 3. Apply defaults
  const cleanInput = applyDefaults(stripped, inputsSchema);

  return cleanInput;
}
