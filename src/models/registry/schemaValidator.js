import {
  ValidationError,
  InvalidEnumValueError,
  UnknownParameterError,
} from "../errors/index.js";

/**
 * Validates and sanitizes raw input against canonical operation inputs.
 * Strips unknown parameters unless allowUnknown is explicitly set.
 * Applies default values for missing optional parameters.
 */
export function validateCanonicalInput(canonicalInputs = {}, rawInput = {}, options = {}) {
  const cleanInput = {};

  // 1. Check for required inputs and validate declared inputs
  for (const [key, spec] of Object.entries(canonicalInputs)) {
    let val = rawInput[key];

    // Check required
    if (val === undefined || val === null || val === "") {
      if (spec.required) {
        throw new ValidationError(`Missing required parameter '${key}'`, { field: key });
      }
      // Apply default if provided
      if (spec.default !== undefined) {
        val = spec.default;
      } else {
        continue;
      }
    }

    // Check enum values
    if (spec.values && Array.isArray(spec.values) && spec.values.length > 0) {
      const stringVal = String(val);
      if (!spec.values.includes(stringVal)) {
        throw new InvalidEnumValueError(key, val, spec.values);
      }
    }

    // Check type if specified
    if (spec.type) {
      if (spec.type === "number" && typeof val !== "number") {
        const parsed = Number(val);
        if (Number.isNaN(parsed)) {
          throw new ValidationError(`Parameter '${key}' must be a number`, { field: key });
        }
        val = parsed;
      } else if (spec.type === "boolean" && typeof val !== "boolean") {
        if (val === "true" || val === 1) val = true;
        else if (val === "false" || val === 0) val = false;
        else throw new ValidationError(`Parameter '${key}' must be a boolean`, { field: key });
      } else if (spec.type === "string" && typeof val !== "string") {
        val = String(val);
      } else if (spec.type === "array" && !Array.isArray(val)) {
        throw new ValidationError(`Parameter '${key}' must be an array`, { field: key });
      }
    }

    cleanInput[key] = val;
  }

  // 2. Reject or strip unknown properties
  if (!options.allowUnknown) {
    for (const rawKey of Object.keys(rawInput)) {
      if (!Object.prototype.hasOwnProperty.call(canonicalInputs, rawKey)) {
        // Special framework properties allowed: operation, userId, idempotencyKey
        if (["operation", "userId", "idempotencyKey"].includes(rawKey)) continue;
        throw new UnknownParameterError(rawKey);
      }
    }
  }

  return cleanInput;
}
