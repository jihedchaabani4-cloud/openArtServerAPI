import { UnknownParameterError, InvalidEnumValueError, ValidationError } from "../errors/index.js";
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
