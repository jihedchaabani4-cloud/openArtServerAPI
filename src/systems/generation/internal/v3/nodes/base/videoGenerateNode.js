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
      `[Billing] Pricing failure for model "${model}" in base.video_generate: invalid cost (${raw})`
    );
    err.code = "PRICING_CONFIG_ERROR";
    err.category = "SERVER_FAULT";
    err.statusCode = 500;
    throw err;
  }
  return raw;
}

/**
 * VideoGenerateNode (`base.video_generate`)
 *
 * Executes AI video generation via `#models/tools` (`executeGeneration` / `calculateCost`).
 * Enforces fail-closed pricing: any pricing error throws immediately.
 */
export const VideoGenerateNode = {
  type: "base.video_generate",
  category: "video",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {
      model: { type: "STRING" },
      prompt: { type: "STRING" },
    },
    optional: {
      start_image_url: { type: "IMAGE_URL" },
      end_image_url: { type: "IMAGE_URL" },
      input_video_url: { type: "VIDEO_URL" },
      duration: { type: "INT", default: 5 },
      aspect_ratio: { type: "STRING", default: "16:9" },
      parameters: { type: "JSON", default: {} },
    },
  },

  RETURN_TYPES: {
    video_url: "VIDEO_URL",
    metadata: "JSON",
  },

  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 1500,
    retryableCategories: ["UPSTREAM_FAULT", "RATE_LIMIT"],
  },

  estimateCost(plannedInputs = {}) {
    if (!plannedInputs.model) {
      throw new GenerationCompilationError("Missing required model for base.video_generate cost estimation");
    }
    const res = calculateCost(plannedInputs.model, {
      prompt: plannedInputs.prompt || "<planned>",
      ...(plannedInputs.parameters || {}),
      ...(plannedInputs.duration !== undefined ? { duration: plannedInputs.duration } : {}),
      ...(plannedInputs.aspect_ratio ? { aspect_ratio: plannedInputs.aspect_ratio } : {}),
      ...(plannedInputs.start_image_url ? { input_image: plannedInputs.start_image_url } : {}),
    });
    return extractAmount(res, plannedInputs.model);
  },

  async execute(inputs, ctx = {}) {
    if (!inputs.model) {
      throw new GenerationValidationError("model is required for base.video_generate", { field: "model" });
    }
    if (!inputs.prompt) {
      throw new GenerationValidationError("prompt is required for base.video_generate", { field: "prompt" });
    }

    const params = {
      ...(inputs.parameters || {}),
      prompt: inputs.prompt,
      ...(inputs.start_image_url ? { input_image: inputs.start_image_url } : {}),
      ...(inputs.end_image_url ? { last_frame: inputs.end_image_url } : {}),
      ...(inputs.input_video_url ? { input_video: inputs.input_video_url } : {}),
      ...(inputs.duration !== undefined ? { duration: inputs.duration } : {}),
      ...(inputs.aspect_ratio ? { aspect_ratio: inputs.aspect_ratio } : {}),
    };

    let res;
    if (typeof ctx.executeProvider === "function") {
      res = await ctx.executeProvider(inputs.model, params);
    } else if (typeof ctx.executeGeneration === "function") {
      res = await ctx.executeGeneration({
        modelId: inputs.model,
        prompt: inputs.prompt,
        params,
        userId: ctx.userId || null,
      });
    } else {
      getModelConfig(inputs.model);
      res = await executeGeneration({
        modelId: inputs.model,
        prompt: inputs.prompt,
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
      res?.url ||
      res?.videoUrl ||
      null;

    if (!url) {
      throw new GenerationUpstreamError("Provider returned no video URL", {
        context: { model: inputs.model },
      });
    }

    return {
      video_url: url,
      metadata: {
        model: inputs.model,
        ...(res?.metadata || {}),
      },
    };
  },
};

export default VideoGenerateNode;

