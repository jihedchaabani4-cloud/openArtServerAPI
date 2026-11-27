import { renderTextTemplate, ValidationError } from "#shared";
import { WorkflowValidationError } from "../../errors.js";

export { renderTextTemplate };

/**
 * TextTemplateNode (`base.text_template`)
 *
 * Zero-credit, deterministic prompt/text builder node reusing `#shared` `renderTextTemplate`.
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
      throw new WorkflowValidationError("template is required for base.text_template", {
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

    try {
      return renderTextTemplate(template, mergedVars, {
        defaults: safeInputs.defaults || {},
        strict: Boolean(safeInputs.strict),
        trim: safeInputs.trim !== false,
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        throw new WorkflowValidationError(err.message, {
          field: err.context?.field || "template",
          context: err.context || {},
        });
      }
      throw err;
    }
  },
};

export default TextTemplateNode;
