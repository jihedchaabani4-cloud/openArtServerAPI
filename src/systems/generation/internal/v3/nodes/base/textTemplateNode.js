import { GenerationValidationError } from "../../../errors.js";
import { getValueByPath } from "../../core/GraphCompiler.js";

const CONDITIONAL_BLOCK_REGEX = /\{\{([#^])([a-zA-Z0-9_.-]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
const VARIABLE_TOKEN_REGEX = /\{\{([a-zA-Z0-9_.-]+)\}\}/g;
const MAX_NESTING_PASSES = 8;

/**
 * Returns true when a template variable should be considered present.
 * Note: numeric `0` IS present so zero-valued angles/coordinates render cleanly.
 */
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
 * - `{{#var}}...{{/var}}` conditional block (entire enclosed sentence omitted when `var` is missing/empty/false)
 * - `{{^var}}...{{/var}}` inverted block (included only when `var` is missing/empty/false)
 * - Preserves visual reference tags (`@image1`, `@Name`) untouched.
 */
export function renderTextTemplate(
  template,
  variables = {},
  { defaults = {}, strict = false, trim = true } = {}
) {
  if (typeof template !== "string") {
    throw new GenerationValidationError("template must be a string for base.text_template", {
      field: "template",
    });
  }

  const safeVars = variables && typeof variables === "object" ? variables : {};
  const safeDefaults = defaults && typeof defaults === "object" ? defaults : {};

  // 1. Resolve conditional blocks ({{#key}}...{{/key}} and {{^key}}...{{/key}})
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

  // 2. Interpolate {{variable}} placeholders
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
    throw new GenerationValidationError(
      `Missing required template variable(s): ${missingVariables.join(", ")}`,
      { field: "variables", context: { missing_variables: missingVariables } }
    );
  }

  // 3. Clean up dangling horizontal spaces left by omitted blocks without flattening newlines
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

/**
 * TextTemplateNode (`base.text_template`)
 *
 * Zero-credit, deterministic ComfyUI-style prompt/text builder node.
 * Interpolates `{{variable}}` placeholders and omits `{{#optional}}...{{/optional}}`
 * clauses cleanly whenever an optional variable is absent or empty.
 */
export const TextTemplateNode = {
  type: "base.text_template",
  category: "data",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {
      template: { type: "STRING" },
    },
    optional: {
      variables: { type: "OBJECT", default: {} },
      defaults: { type: "OBJECT", default: {} },
      fallback_text: { type: "STRING", default: "" },
      strict: { type: "BOOLEAN", default: false },
      trim: { type: "BOOLEAN", default: true },
    },
  },

  RETURN_TYPES: {
    text: "STRING",
    missing_variables: "ARRAY",
  },

  estimateCost: () => 0,

  async execute(inputs = {}) {
    const safeInputs = inputs && typeof inputs === "object" ? inputs : {};
    const template = typeof safeInputs.template === "string" ? safeInputs.template : "";
    if (!template.trim()) {
      throw new GenerationValidationError("template is required for base.text_template", {
        field: "template",
      });
    }

    const baseVars =
      safeInputs.variables && typeof safeInputs.variables === "object"
        ? safeInputs.variables
        : {};
    const mergedVars =
      safeInputs.fallback_text !== undefined && !("fallback_text" in baseVars)
        ? { ...baseVars, fallback_text: safeInputs.fallback_text }
        : baseVars;

    return renderTextTemplate(template, mergedVars, {
      defaults: safeInputs.defaults || {},
      strict: Boolean(safeInputs.strict),
      trim: safeInputs.trim !== false,
    });
  },
};

export default TextTemplateNode;
