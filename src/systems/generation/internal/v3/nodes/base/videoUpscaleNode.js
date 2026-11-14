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
      `[Billing] Pricing failure for model "${model}" in base.video_upscale: invalid cost (${raw})`
    );
    err.code = "PRICING_CONFIG_ERROR";
    err.category = "SERVER_FAULT";
    err.statusCode = 500;
    throw err;
  }
  return raw;
}

/**
 * VideoUpscaleNode (`base.video_upscale`)
 *
 * Upscales a generated video (e.g. to 4K / 60fps) via `#models/tools`.
 * Enforces fail-closed pricing: any pricing error throws immediately.
 */
export const VideoUpscaleNode = {
  type: "base.video_upscale",
  category: "video",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {
      video_url: { type: "VIDEO_URL" },
    },
    optional: {
      model: { type: "STRING", default: "wavespeed_upscale" },
      target_resolution: { type: "STRING", default: "4k" },
    },
  },

  RETURN_TYPES: {
    video_url: "VIDEO_URL",
    metadata: "JSON",
  },

  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 2000,
    retryableCategories: ["UPSTREAM_FAULT", "RATE_LIMIT"],
  },

  estimateCost(plannedInputs = {}) {
    const model = plannedInputs.model || "wavespeed_upscale";
    const res = calculateCost(model, {
      input_image: plannedInputs.video_url || "https://cdn.example.com/placeholder.mp4",
      target_resolution: plannedInputs.target_resolution ?? "4k",
    });
    return extractAmount(res, model);
  },

  async execute(inputs, ctx = {}) {
    if (!inputs.video_url) {
      throw new GenerationValidationError("video_url is required for base.video_upscale", { field: "video_url" });
    }

    const model = inputs.model || "wavespeed_upscale";
    const params = {
      input_video: inputs.video_url,
      input_image: inputs.video_url,
      target_resolution: inputs.target_resolution ?? "4k",
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
      res?.videos?.[0]?.url ||
      (typeof res?.videos?.[0] === "string" ? res.videos[0] : null) ||
      (typeof res?.data?.videos?.[0] === "string" ? res.data.videos[0] : res?.data?.videos?.[0]?.url) ||
      (typeof res?.images?.[0] === "string" ? res.images[0] : res?.images?.[0]?.url) ||
      res?.url ||
      null;

    if (!url) {
      throw new GenerationUpstreamError("Provider returned no upscaled video URL", {
        context: { model },
      });
    }

    return {
      video_url: url,
      metadata: {
        model,
        target_resolution: inputs.target_resolution ?? "4k",
        ...(res?.metadata || {}),
      },
    };
  },
};

export default VideoUpscaleNode;

