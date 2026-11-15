import { calculateCost } from "#models/tools";
import {
  GenerationValidationError,
  GenerationCompilationError,
} from "../../../errors.js";
import {
  extractNodeCostAmount,
  invokeModelGeneration,
  extractVideoOutput,
} from "./mediaNodeHelpers.js";

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
    return extractNodeCostAmount(res, plannedInputs.model, "base.video_generate");
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

    const res = await invokeModelGeneration({
      model: inputs.model,
      prompt: inputs.prompt,
      params,
      ctx,
    });

    const { url } = extractVideoOutput(res, inputs.model, "Provider returned no video URL");

    return {
      video_url: url,
      metadata: {
        model: inputs.model,
        ...(res?._internal?.provider ? { provider: res._internal.provider } : {}),
        ...(res?.metadata || {}),
      },
    };
  },
};

export default VideoGenerateNode;

