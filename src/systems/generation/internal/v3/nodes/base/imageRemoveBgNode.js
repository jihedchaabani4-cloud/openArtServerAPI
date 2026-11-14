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
      `[Billing] Pricing failure for model "${model}" in base.image_remove_bg: invalid cost (${raw})`
    );
    err.code = "PRICING_CONFIG_ERROR";
    err.category = "SERVER_FAULT";
    err.statusCode = 500;
    throw err;
  }
  return raw;
}

/**
 * ImageRemoveBgNode (`base.image_remove_bg`)
 *
 * Isolates foreground subject / product by removing background via `#models/tools`.
 * Enforces fail-closed pricing: any pricing error throws immediately.
 */
export const ImageRemoveBgNode = {
  type: "base.image_remove_bg",
  category: "image",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {
      image_url: { type: "IMAGE_URL" },
    },
    optional: {
      model: { type: "STRING", default: "nanobana_2" },
    },
  },

  RETURN_TYPES: {
    image_url: "IMAGE_URL",
    metadata: "JSON",
  },

  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 1000,
    retryableCategories: ["UPSTREAM_FAULT", "RATE_LIMIT"],
  },

  estimateCost(plannedInputs = {}) {
    const model = plannedInputs.model || "nanobana_2";
    const res = calculateCost(model, {
      prompt: "Isolate foreground subject on transparent background",
      input_image: plannedInputs.image_url || "https://cdn.example.com/placeholder.png",
    });
    return extractAmount(res, model);
  },

  async execute(inputs, ctx = {}) {
    if (!inputs.image_url) {
      throw new GenerationValidationError("image_url is required for base.image_remove_bg", { field: "image_url" });
    }

    const model = inputs.model || "nanobana_2";
    const params = {
      prompt: "Isolate foreground subject on transparent background",
      input_image: inputs.image_url,
    };

    let res;
    if (typeof ctx.executeProvider === "function") {
      res = await ctx.executeProvider(model, params);
    } else if (typeof ctx.executeGeneration === "function") {
      res = await ctx.executeGeneration({
        modelId: model,
        prompt: params.prompt,
        params,
        userId: ctx.userId || null,
      });
    } else {
      getModelConfig(model);
      res = await executeGeneration({
        modelId: model,
        prompt: params.prompt,
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
      throw new GenerationUpstreamError("Provider returned no background-removed image URL", {
        context: { model },
      });
    }

    return {
      image_url: url,
      metadata: {
        model,
        ...(res?.metadata || {}),
      },
    };
  },
};

export default ImageRemoveBgNode;

