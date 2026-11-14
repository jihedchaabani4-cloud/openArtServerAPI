import { calculateCost, executeGeneration, getModelConfig } from "#models/tools";
import {
  GenerationUpstreamError,
  GenerationValidationError,
  GenerationCompilationError,
} from "../../../errors.js";

function extractAmount(costRes, model) {
  const raw =
    typeof costRes === "number"
      ? costRes
      : costRes && typeof costRes === "object"
        ? Number(costRes.amount ?? costRes.totalCredits ?? costRes.credits)
        : NaN;

  if (typeof raw !== "number" || Number.isNaN(raw) || !Number.isFinite(raw) || raw < 0) {
    const err = new GenerationCompilationError(
      `[Billing] Pricing failure for model "${model}" in base.image_generate: invalid cost (${raw})`
    );
    err.code = "PRICING_CONFIG_ERROR";
    err.category = "SERVER_FAULT";
    err.statusCode = 500;
    throw err;
  }
  return raw;
}

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
    return extractAmount(res, plannedInputs.model) * count;
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

    let res;
    if (typeof ctx.executeProvider === "function") {
      res = await ctx.executeProvider(inputs.model, params);
    } else if (typeof ctx.executeGeneration === "function") {
      res = await ctx.executeGeneration({
        modelId: inputs.model,
        prompt: inputs.prompt,
        params,
        references: inputs.reference_urls || [],
        userId: ctx.userId || null,
      });
    } else {
      // Verify model exists via #models/tools and execute through canonical model runner
      getModelConfig(inputs.model);
      res = await executeGeneration({
        modelId: inputs.model,
        prompt: inputs.prompt,
        params,
        references: inputs.reference_urls || [],
        userId: ctx.userId || "system",
        idempotencyKey: ctx.runId && ctx.nodeId ? `node:${ctx.runId}:${ctx.nodeId}` : undefined,
      });
    }

    const assets = Array.isArray(res?.assets)
      ? res.assets
      : Array.isArray(res?.images)
        ? res.images.map((u) => (typeof u === "string" ? { url: u } : u))
        : Array.isArray(res?.data?.images)
          ? res.data.images.map((u) => (typeof u === "string" ? { url: u } : u))
          : res?.url
            ? [{ url: res.url }]
            : [];

    const url = assets[0]?.url || (typeof assets[0] === "string" ? assets[0] : null);
    if (!url) {
      throw new GenerationUpstreamError("Provider returned no image URL", {
        context: { model: inputs.model },
      });
    }

    return {
      image_url: url,
      assets,
      metadata: {
        model: inputs.model,
        ...(res?.metadata || {}),
      },
    };
  },
};

export default ImageGenerateNode;

