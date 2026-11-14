import { ValidationError } from "../errors/index.js";

/**
 * Conditional Rules Engine
 *
 * Evaluates declarative conditional constraints defined in model.json operation schemas.
 *
 * Rule schema (JSON):
 * ```json
 * "rules": [
 *   {
 *     "if": { "param": "aspect_ratio", "eq": "custom" },
 *     "then": { "require": ["width", "height"] }
 *   },
 *   {
 *     "if": { "param": "mode", "in": ["image_to_image", "inpaint"] },
 *     "then": { "require": ["image_url"] }
 *   },
 *   {
 *     "if": { "param": "temperature", "neq": 1 },
 *     "then": { "reject": "temperature must be exactly 1 for this model" }
 *   }
 * ]
 * ```
 *
 * Supported condition operators:
 *   eq    - cleanInput[param] === value
 *   neq   - cleanInput[param] !== value
 *   in    - cleanInput[param] is in array
 *   nin   - cleanInput[param] is not in array
 *   exists - cleanInput[param] is not null/undefined
 *
 * Supported consequence types:
 *   require  - listed params must be present and non-null in cleanInput
 *   reject   - always throw with provided message when condition is met
 *   default  - apply default values if param is absent
 */
export function evaluateRules(rules, cleanInput, schema = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return;

  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;

    const { if: condition, then: consequence } = rule;
    if (!condition || !consequence) continue;

    if (!_evaluateCondition(condition, cleanInput)) continue;

    // Condition is true — apply consequence
    _applyConsequence(consequence, cleanInput, schema, rule);
  }
}

function _evaluateCondition(condition, cleanInput) {
  const { param, eq, neq, in: inValues, nin, exists } = condition;

  if (!param) return false;

  const value = cleanInput[param];

  if (eq !== undefined) {
    // eslint-disable-next-line eqeqeq
    return value == eq; // intentional loose equality for "5" == 5
  }
  if (neq !== undefined) {
    // eslint-disable-next-line eqeqeq
    return value != neq;
  }
  if (Array.isArray(inValues)) {
    return inValues.map(String).includes(String(value));
  }
  if (Array.isArray(nin)) {
    return !nin.map(String).includes(String(value));
  }
  if (exists !== undefined) {
    const paramExists = value !== undefined && value !== null;
    return exists ? paramExists : !paramExists;
  }

  return false;
}

function _applyConsequence(consequence, cleanInput, schema, rule) {
  // require: listed params must be present
  if (Array.isArray(consequence.require)) {
    for (const paramName of consequence.require) {
      const val = cleanInput[paramName];
      if (val === undefined || val === null) {
        const condStr = _describeCondition(rule.if);
        throw new ValidationError(
          `Conditional rule: when ${condStr}, "${paramName}" is required but missing`,
          { field: paramName, safeMessage: `"${paramName}" is required for this configuration` }
        );
      }
    }
  }

  // reject: throw immediately with message
  if (consequence.reject) {
    throw new ValidationError(consequence.reject, {
      safeMessage: consequence.reject,
    });
  }

  // default: set default values for absent params
  if (consequence.default && typeof consequence.default === "object") {
    for (const [paramName, defaultValue] of Object.entries(consequence.default)) {
      if (cleanInput[paramName] === undefined || cleanInput[paramName] === null) {
        cleanInput[paramName] = defaultValue;
      }
    }
  }
}

function _describeCondition(condition) {
  const { param, eq, neq, in: inValues, nin, exists } = condition;
  if (eq !== undefined) return `"${param}" = "${eq}"`;
  if (neq !== undefined) return `"${param}" ≠ "${neq}"`;
  if (Array.isArray(inValues)) return `"${param}" in [${inValues.join(", ")}]`;
  if (Array.isArray(nin)) return `"${param}" not in [${nin.join(", ")}]`;
  if (exists !== undefined) return exists ? `"${param}" exists` : `"${param}" absent`;
  return param;
}
