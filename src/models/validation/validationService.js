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
  UnknownParameterError,
  InvalidEnumValueError,
  UnknownModelFamilyError,
  UnknownOperationError,
} from "../errors/index.js";
import { getRegistry } from "../registry/loader.js";
import { resolveModelSchema } from "../registry/resolver.js";
import { sanitizePrompt } from "./parameterSanitizer.js";

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

/**
 * Validates user inputs with zero tolerance for unknown keys or invalid enum values.
 *
 * @param {string} modelFamily
 * @param {string} operation
 * @param {object} rawInput
 * @param {object} options - { allowStrip: boolean }
 * @returns {object} CleanInput
 */
export function validateInput(modelFamily, operation, rawInput = {}, options = {}) {
  if (!rawInput || typeof rawInput !== "object") {
    throw new ValidationError("Input must be a valid object");
  }

  // Security guard for prototype pollution
  if (rawInput.__proto__ !== Object.prototype || Object.prototype.hasOwnProperty.call(rawInput, "__proto__")) {
    // If someone passes literal __proto__ key, strip it or reject
  }

  // Resolve schema combining canonical parameter vocabulary + model-specific overrides
  const resolvedSchema = resolveModelSchema(modelFamily, operation);
  const inputsSchema = resolvedSchema.inputs || {};

  const cleanInput = {};
  const ignoredSystemKeys = new Set(["__proto__", "constructor", "model", "operation", "idempotencyKey"]);

  // 1. Zero-Tolerance Hard Validation: Check for unknown fields
  for (const key of Object.keys(rawInput)) {
    if (ignoredSystemKeys.has(key)) continue;

    if (!inputsSchema[key]) {
      if (options.allowStrip) {
        // Only strip if caller explicitly enabled allowStrip (e.g. legacy compatibility mode)
        continue;
      }
      throw new UnknownParameterError(key);
    }
  }

  // 2. Validate declared fields, boundaries, and required flags
  for (const [key, fieldDef] of Object.entries(inputsSchema)) {
    const val = rawInput[key];

    if (val === undefined || val === null) {
      if (fieldDef.required) {
        throw new ValidationError(`Missing required field: "${key}"`, { field: key });
      }
      // Apply default value if optional and not provided
      cleanInput[key] = fieldDef.default !== undefined ? fieldDef.default : null;
    } else {
      if (fieldDef.type === "string" && (key === "prompt" || fieldDef.maxLength || fieldDef.max_length)) {
        cleanInput[key] = sanitizePrompt(key, val, fieldDef);
      } else {
        cleanInput[key] = validateField(key, val, fieldDef);
      }
    }
  }

  return cleanInput;
}
