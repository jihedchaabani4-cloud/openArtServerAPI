import { ValidationError } from "../errors/AppError.js";
import { getValueByPath } from "./pathUtils.js";

const CONDITIONAL_BLOCK_REGEX = /\{\{([#^])([a-zA-Z0-9_.-]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
const VARIABLE_TOKEN_REGEX = /\{\{([a-zA-Z0-9_.-]+)\}\}/g;
const MAX_NESTING_PASSES = 8;

function isTemplateValuePresent(value) {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function resolveTemplateValue(key, variables, defaults) {
  const fromVars = getValueByPath(variables, key);
  if (fromVars !== undefined && fromVars !== null) return fromVars;
  return getValueByPath(defaults, key);
}

function formatTemplateValue(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.filter(isTemplateValuePresent).join(", ");
  return JSON.stringify(value);
}

/**
 * Pure deterministic template renderer supporting:
 * - `{{var}}` and dot-paths (`{{nested.key}}`)
 * - `{{#var}}...{{/var}}` conditional blocks
 * - `{{^var}}...{{/var}}` inverted blocks
 * - Preserves visual reference tags (`@image1`, `@Name`) untouched.
 */
export function renderTextTemplate(
  template,
  variables = {},
  { defaults = {}, strict = false, trim = true } = {}
) {
  if (typeof template !== "string") {
    throw new ValidationError("TEMPLATE_VALIDATION_ERROR", "template must be a string", {
      context: { field: "template" },
    });
  }

  const safeVars = variables && typeof variables === "object" ? variables : {};
  const safeDefaults = defaults && typeof defaults === "object" ? defaults : {};

  let rendered = template;
  for (let pass = 0; pass < MAX_NESTING_PASSES; pass++) {
    let changed = false;
    rendered = rendered.replace(CONDITIONAL_BLOCK_REGEX, (_match, prefix, key, inner) => {
      changed = true;
      const val = resolveTemplateValue(key, safeVars, safeDefaults);
      const present = isTemplateValuePresent(val);
      const shouldInclude = prefix === "#" ? present : !present;
      return shouldInclude ? inner : "";
    });
    if (!changed) break;
  }

  const missingSet = new Set();
  rendered = rendered.replace(VARIABLE_TOKEN_REGEX, (_match, key) => {
    const val = resolveTemplateValue(key, safeVars, safeDefaults);
    if (!isTemplateValuePresent(val)) {
      missingSet.add(key);
      return "";
    }
    return formatTemplateValue(val);
  });

  const missingVariables = Array.from(missingSet);
  if (strict && missingVariables.length > 0) {
    throw new ValidationError(
      "TEMPLATE_VALIDATION_ERROR",
      `Missing required template variable(s): ${missingVariables.join(", ")}`,
      {
        context: { field: "variables", missing_variables: missingVariables },
      }
    );
  }

  rendered = rendered
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n");

  if (trim) {
    rendered = rendered.trim();
  }

  return {
    text: rendered,
    missing_variables: missingVariables,
  };
}

export default { renderTextTemplate };
