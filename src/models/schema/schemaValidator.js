import {
  UnknownParameterError,
  InvalidEnumValueError,
  ValidationError,
  UnsupportedCapabilityError,
} from "../errors/index.js";
import { evaluateRules } from "./conditionalRules.js";

/**
 * Canonical Input Validator
 *
 * Validates raw caller input against the canonical schema defined in model.json.
 *
 * ── Behavior ─────────────────────────────────────────────────────────────────
 * By default (allowUnknown: false):
 *   - Unknown parameters → throws UnknownParameterError
 *   - Invalid enum values → throws InvalidEnumValueError
 *   - Missing required fields → throws ValidationError
 *
 * With allowUnknown: true:
 *   - Unknown parameters are passed through as-is (useful for custom adapters)
 *
 * Framework-injected parameters always exempt from unknown check:
 *   operation, userId, idempotencyKey, domain
 *
 * After field validation, conditional rules are evaluated:
 *   model.json → operations.<op>.rules[] → see conditionalRules.js
 * ────────────────────────────────────────────────────────────────────────────
 *
 * @param {object} operationDefOrSchema - model.json operation object OR canonicalInputs map directly
 * @param {object} rawInput             - Caller-supplied input
 * @param {object} [opts]
 * @param {boolean} [opts.allowUnknown=false] - Pass unknown params through
 * @returns {object} cleanInput         - Validated, clean input (unknowns stripped unless allowUnknown)
 */
export function validateCanonicalInput(operationDefOrSchema = {}, rawInput = {}, opts = {}) {
  const schema = operationDefOrSchema.canonicalInputs || operationDefOrSchema;
  const rules = operationDefOrSchema.rules || [];
  const allowUnknown = opts.allowUnknown === true;

  // Framework-level properties exempt from validation
  const FRAMEWORK_EXEMPT = new Set(["operation", "userId", "idempotencyKey", "domain"]);

  const cleanInput = {};

  // Validate all schema-defined parameters
  for (const [paramName, paramDef] of Object.entries(schema)) {
    const value = rawInput[paramName];
    const isMissing = value === undefined || value === null || value === "";

    if (isMissing) {
      if (paramDef.required === true) {
        throw new ValidationError(`Required parameter "${paramName}" is missing`, {
          field: paramName,
        });
      }
      // Apply default if defined
      if (paramDef.default !== undefined) {
        cleanInput[paramName] = paramDef.default;
      }
      continue;
    }

    // Type coercion and checking
    let coerced = value;

    if (paramDef.type === "number" && typeof value === "string") {
      const n = Number(value);
      if (!isNaN(n)) coerced = n;
    }

    if (paramDef.type === "boolean" && typeof value === "string") {
      coerced = value === "true" || value === "1";
    }

    // Enum validation (values array)
    if (Array.isArray(paramDef.values) && paramDef.values.length > 0) {
      const strValue = String(coerced);
      const strValues = paramDef.values.map(String);
      if (!strValues.includes(strValue)) {
        throw new InvalidEnumValueError(paramName, coerced, paramDef.values);
      }
    }

    cleanInput[paramName] = coerced;
  }

  // Handle unknown parameters from rawInput
  for (const key of Object.keys(rawInput)) {
    if (key in schema || FRAMEWORK_EXEMPT.has(key)) {
      continue;
    }
    if (allowUnknown) {
      cleanInput[key] = rawInput[key];
    } else {
      throw new UnknownParameterError(key);
    }
  }

  // Evaluate conditional rules after all fields are validated
  if (rules.length > 0) {
    evaluateRules(rules, cleanInput, schema);
  }

  return cleanInput;
}

/**
 * Validates that cleanInput satisfies the specific binding's implementation constraints.
 * A binding can only NARROW the model universe (via valueMap or constraints), never widen it.
 *
 * @param {object} binding     - Resolved execution binding
 * @param {object} cleanInput  - Validated canonical input
 * @throws {UnsupportedCapabilityError} If an input value is not supported by this binding
 */
export function validateBindingConstraints(binding, cleanInput = {}) {
  if (!binding) return;

  // 1. Check parameterMap.valueMap narrowing
  if (binding.parameterMap) {
    for (const [canonicalParam, mappingDef] of Object.entries(binding.parameterMap)) {
      if (mappingDef && mappingDef.valueMap && typeof mappingDef.valueMap === "object") {
        const callerVal = cleanInput[canonicalParam];
        if (callerVal !== undefined && callerVal !== null) {
          const stringVal = String(callerVal);
          const supportedValues = Object.keys(mappingDef.valueMap);
          if (supportedValues.length > 0 && !supportedValues.includes(stringVal)) {
            throw new UnsupportedCapabilityError(
              `Binding "${binding.providerId}" for model "${binding.modelId}" does not support value "${callerVal}" for parameter "${canonicalParam}". Supported: ${supportedValues.join(", ")}`
            );
          }
        }
      }
    }
  }

  // 2. Check explicit binding.constraints narrowing if declared
  if (binding.constraints && typeof binding.constraints === "object") {
    for (const [param, allowedValues] of Object.entries(binding.constraints)) {
      const callerVal = cleanInput[param];
      if (callerVal !== undefined && callerVal !== null && Array.isArray(allowedValues)) {
        if (!allowedValues.includes(callerVal) && !allowedValues.includes(String(callerVal))) {
          throw new UnsupportedCapabilityError(
            `Binding "${binding.providerId}" constraint violation: parameter "${param}" value "${callerVal}" is not supported. Supported: ${allowedValues.join(", ")}`
          );
        }
      }
    }
  }
}

