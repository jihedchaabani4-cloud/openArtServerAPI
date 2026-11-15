import { calculateCost } from "#models/tools";
import {
  GenerationValidationError,
  GenerationCompilationError,
} from "../../../errors.js";
import {
  extractNodeCostAmount,
  invokeModelGeneration,
  extractImageOutput,
} from "./mediaNodeHelpers.js";

/**
 * ImageGenerateNode (`base.image_generate`)
 *
 * Executes image generation via `#models/tools` (`executeGeneration` / `calculateCost`).
 * Enforces fail-closed pricing: any pricing error throws immediately.
 */
export const ImageGenerateNode = {
  type: "base.image_generate",
  category: "image",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {
      model: { type: "STRING" },
      prompt: { type: "STRING" },
    },
    optional: {
      aspect_ratio: { type: "STRING", default: "1:1" },
      width: { type: "INT", default: 1024 },
      height: { type: "INT", default: 1024 },
      count: { type: "INT", default: 1 },
      input_image_url: { type: "IMAGE_URL" },
      reference_urls: { type: "ARRAY", default: [] },
      parameters: { type: "JSON", default: {} },
    },
  },

  RETURN_TYPES: {
    image_url: "IMAGE_URL",
    assets: "ARRAY",
    metadata: "JSON",
  },

  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 1500,
    retryableCategories: ["UPSTREAM_FAULT", "RATE_LIMIT"],
  },

  estimateCost(plannedInputs = {}) {
    if (!plannedInputs.model) {
      throw new GenerationCompilationError("Missing required model for base.image_generate cost estimation");
    }
    const { count: paramCount, ...cleanParams } = plannedInputs.parameters || {};
    const count = Math.max(1, Number(plannedInputs.count ?? paramCount ?? 1) || 1);
    const res = calculateCost(plannedInputs.model, {
      prompt: plannedInputs.prompt || "<planned>",
      ...cleanParams,
      ...(plannedInputs.aspect_ratio ? { aspect_ratio: plannedInputs.aspect_ratio } : {}),
    });
    return extractNodeCostAmount(res, plannedInputs.model, "base.image_generate") * count;
  },

  async execute(inputs, ctx = {}) {
    if (!inputs.model) {
      throw new GenerationValidationError("model is required for base.image_generate", { field: "model" });
    }
    if (!inputs.prompt) {
      throw new GenerationValidationError("prompt is required for base.image_generate", { field: "prompt" });
    }

    const params = {
      ...(inputs.parameters || {}),
      prompt: inputs.prompt,
      ...(inputs.aspect_ratio ? { aspect_ratio: inputs.aspect_ratio } : {}),
    };
    if (inputs.input_image_url) {
      params.input_image = inputs.input_image_url;
    }
    if (Array.isArray(inputs.reference_urls) && inputs.reference_urls.length > 0 && !params.images) {
      params.images = inputs.reference_urls;
    }

    const res = await invokeModelGeneration({
      model: inputs.model,
      prompt: inputs.prompt,
      params,
      references: inputs.reference_urls || [],
      ctx,
    });

    const { url, assets } = extractImageOutput(res, inputs.model, "Provider returned no image URL");

    return {
      image_url: url,
      assets,
      metadata: {
        model: inputs.model,
        ...(res?._internal?.provider ? { provider: res._internal.provider } : {}),
        ...(res?.metadata || {}),
      },
    };
  },
};

export default ImageGenerateNode;

