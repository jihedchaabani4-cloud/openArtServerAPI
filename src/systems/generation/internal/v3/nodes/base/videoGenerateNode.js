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

function normalizeParameters(rawParameters) {
  return rawParameters && typeof rawParameters === "object" && !Array.isArray(rawParameters)
    ? rawParameters
    : {};
}

function normalizeOptionalUrl(rawUrl) {
  if (typeof rawUrl !== "string") {
    return null;
  }
  const trimmed = rawUrl.trim();
  return trimmed || null;
}

function hasNonEmptyParam(params, key) {
  const value = params[key];
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

function attachOptionalMediaParams(target, inputs = {}) {
  const startImageUrl = normalizeOptionalUrl(inputs.start_image_url);
  if (startImageUrl && !hasNonEmptyParam(target, "input_image")) {
    target.input_image = startImageUrl;
  }

  const endImageUrl = normalizeOptionalUrl(inputs.end_image_url);
  if (endImageUrl && !hasNonEmptyParam(target, "last_frame")) {
    target.last_frame = endImageUrl;
  }

  const inputVideoUrl = normalizeOptionalUrl(inputs.input_video_url);
  if (inputVideoUrl && !hasNonEmptyParam(target, "input_video")) {
    target.input_video = inputVideoUrl;
  }

  return target;
}

/**
 * VideoGenerateNode (`base.video_generate`)
 *
 * Model-agnostic video generation runner via `#models/tools` (`executeGeneration` / `calculateCost`).
 * Model-specific settings (e.g. `duration`, `aspect_ratio`, `resolution`, `fps`, `generate_audio`,
 * `camera_motion`, `seed`) live in `parameters` and fall back to `#models/tools` model manifests.
 * Enforces fail-closed pricing: any pricing error throws immediately.
 */
export const VideoGenerateNode = {
  type: "base.video_generate",
  category: "video",
  OUTPUT_NODE: false,
  CACHEABLE: false,

  INPUT_TYPES: {
    required: {
      model: { type: "STRING" },
      prompt: { type: "STRING" },
    },
    optional: {
      start_image_url: { type: "IMAGE_URL" },
      end_image_url: { type: "IMAGE_URL" },
      input_video_url: { type: "VIDEO_URL" },
      parameters: { type: "JSON", default: {} },
    },
  },

  RETURN_TYPES: {
    status: "STRING",
    video_url: "VIDEO_URL",
    assets: "ARRAY",
    metadata: "JSON",
  },

  retryPolicy: {
    maxAttempts: 1,
    backoffMs: 0,
    retryableCategories: [],
  },

  estimateCost(plannedInputs = {}) {
    if (!plannedInputs.model || (typeof plannedInputs.model === "string" && !plannedInputs.model.trim())) {
      throw new GenerationCompilationError("Missing required model for base.video_generate cost estimation");
    }
    const baseParams = normalizeParameters(plannedInputs.parameters);
    const costParams = attachOptionalMediaParams(
      {
        prompt: plannedInputs.prompt || "<planned>",
        ...baseParams,
      },
      plannedInputs
    );
    const res = calculateCost(plannedInputs.model, costParams);
    return extractNodeCostAmount(res, plannedInputs.model, "base.video_generate");
  },

  async execute(inputs = {}, ctx = {}) {
    if (!inputs.model || (typeof inputs.model === "string" && !inputs.model.trim())) {
      throw new GenerationValidationError("model is required for base.video_generate", { field: "model" });
    }
    if (!inputs.prompt || (typeof inputs.prompt === "string" && !inputs.prompt.trim())) {
      throw new GenerationValidationError("prompt is required for base.video_generate", { field: "prompt" });
    }

    const params = attachOptionalMediaParams(
      {
        ...normalizeParameters(inputs.parameters),
        prompt: inputs.prompt,
      },
      inputs
    );

    const res = await invokeModelGeneration({
      model: inputs.model,
      prompt: inputs.prompt,
      params,
      ctx,
    });

    const { url, assets } = extractVideoOutput(res, inputs.model, "Provider returned no video URL");

    return {
      status: "success",
      video_url: url,
      assets,
      metadata: {
        model: inputs.model,
        ...(res?._internal?.provider ? { provider: res._internal.provider } : {}),
        ...(res?.metadata || {}),
      },
    };
  },
};

export default VideoGenerateNode;

