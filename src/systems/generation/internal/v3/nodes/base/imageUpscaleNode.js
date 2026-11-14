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
      `[Billing] Pricing failure for model "${model}" in base.image_upscale: invalid cost (${raw})`
    );
    err.code = "PRICING_CONFIG_ERROR";
    err.category = "SERVER_FAULT";
    err.statusCode = 500;
    throw err;
  }
  return raw;
}

/**
 * ImageUpscaleNode (`base.image_upscale`)
 *
 * Upscales an input image via `#models/tools` (`executeGeneration` / `calculateCost`).
 * Enforces fail-closed pricing: any pricing error throws immediately.
 */
export const ImageUpscaleNode = {
  type: "base.image_upscale",
  category: "image",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {
      image_url: { type: "IMAGE_URL" },
    },
    optional: {
      model: { type: "STRING", default: "wavespeed_upscale" },
      scale_factor: { type: "INT", default: 2 },
      prompt: { type: "STRING", default: "" },
    },
  },

  RETURN_TYPES: {
    image_url: "IMAGE_URL",
    metadata: "JSON",
  },

  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 1500,
    retryableCategories: ["UPSTREAM_FAULT", "RATE_LIMIT"],
  },

  estimateCost(plannedInputs = {}) {
    const model = plannedInputs.model || "wavespeed_upscale";
    const res = calculateCost(model, {
      input_image: plannedInputs.image_url || "https://cdn.example.com/placeholder.png",
      scale_factor: plannedInputs.scale_factor ?? 2,
    });
    return extractAmount(res, model);
  },

  async execute(inputs, ctx = {}) {
    if (!inputs.image_url) {
      throw new GenerationValidationError("image_url is required for base.image_upscale", { field: "image_url" });
    }

    const model = inputs.model || "wavespeed_upscale";
    const params = {
      input_image: inputs.image_url,
      scale_factor: inputs.scale_factor ?? 2,
      ...(inputs.prompt ? { prompt: inputs.prompt } : {}),
    };

    let res;
    if (typeof ctx.executeProvider === "function") {
      res = await ctx.executeProvider(model, params);
    } else if (typeof ctx.executeGeneration === "function") {
      res = await ctx.executeGeneration({ modelId: model, params, userId: ctx.userId || null });
    } else {
      getModelConfig(model);
      res = await executeGeneration({
        modelId: model,
        params,
        userId: ctx.userId || "system",
        idempotencyKey: ctx.runId && ctx.nodeId ? `node:${ctx.runId}:${ctx.nodeId}` : undefined,
      });
    }

    const url =
      res?.assets?.[0]?.url ||
      res?.images?.[0]?.url ||
      (typeof res?.images?.[0] === "string" ? res.images[0] : null) ||
      (typeof res?.data?.images?.[0] === "string" ? res.data.images[0] : res?.data?.images?.[0]?.url) ||
      res?.url ||
      null;

    if (!url) {
      throw new GenerationUpstreamError("Provider returned no upscaled image URL", {
        context: { model },
      });
    }

    return {
      image_url: url,
      metadata: {
        model,
        scale_factor: inputs.scale_factor ?? 2,
        ...(res?.metadata || {}),
      },
    };
  },
};

export default ImageUpscaleNode;

