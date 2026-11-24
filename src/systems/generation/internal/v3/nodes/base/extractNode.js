import { GenerationValidationError } from "../../../errors.js";
import { getValueByPath } from "../../core/GraphCompiler.js";

/**
 * ExtractNode (`base.extract`)
 *
 * Pure zero-credit data extraction node that reads a dot-separated field or array
 * index path (e.g. `"character_description"`, `"shots.0.prompt"`) from an upstream
 * JSON object/array with an optional fallback `default_value`.
 */
export const ExtractNode = {
  type: "base.extract",
  category: "data",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {
      data: { type: "ANY" },
      path: { type: "STRING" },
    },
    optional: {
      default_value: { type: "ANY" },
    },
  },

  RETURN_TYPES: {
    value: "ANY",
    text: "STRING",
  },

  estimateCost: () => 0,

  async execute(inputs = {}) {
    const safeInputs = inputs && typeof inputs === "object" ? inputs : {};
    const path = typeof safeInputs.path === "string" ? safeInputs.path.trim() : "";
    if (!path) {
      throw new GenerationValidationError("path is required for base.extract", {
        field: "path",
      });
    }

    const resolved = getValueByPath(safeInputs.data, path);
    const isEmpty =
      resolved === undefined ||
      resolved === null ||
      (typeof resolved === "string" && resolved.trim() === "");

    const value = isEmpty ? safeInputs.default_value : resolved;
    const text =
      value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);

    return { value, text };
  },
};

export default ExtractNode;
