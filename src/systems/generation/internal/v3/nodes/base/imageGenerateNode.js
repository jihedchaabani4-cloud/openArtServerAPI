import { calculateCost, getModelSchema } from "#models/tools";
import { createLogger } from "#shared";
import {
  GenerationValidationError,
  GenerationCompilationError,
} from "../../../errors.js";
import {
  extractNodeCostAmount,
  invokeModelGeneration,
  extractImageOutput,
} from "./mediaNodeHelpers.js";

const logger = createLogger("v3.image_generate");

function normalizeImages(rawImages) {
  if (typeof rawImages === "string") {
    const trimmed = rawImages.trim();
    return trimmed ? [trimmed] : [];
  }
  if (rawImages && typeof rawImages === "object" && !Array.isArray(rawImages)) {
    const trimmed = typeof rawImages.url === "string" ? rawImages.url.trim() : "";
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(rawImages)) {
    return [];
  }
  const seen = new Set();
  const urls = [];
  for (const item of rawImages) {
    const raw = typeof item === "string" ? item : item?.url;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        urls.push(trimmed);
      }
    }
  }
  return urls;
}

function getModelMaxImages(model) {
  try {
    const schema = getModelSchema(model);
    const maxVal = Number(schema?.parameters?.images?.max);
    if (Number.isInteger(maxVal) && maxVal >= 1) return maxVal;
    if (schema?.parameters?.input_image) return 1;
  } catch {
    // Unknown/test model not registered in catalog
  }
  return null;
}

function capImagesForModel(images, model) {
  const maxImages = getModelMaxImages(model);
  if (maxImages !== null && images.length > maxImages) {
    logger.warn(
      { model, receivedCount: images.length, maxImages },
      "Capping resolved reference images to model images.max limit"
    );
    return images.slice(0, maxImages);
  }
  return images;
}

function normalizeParameters(rawParameters) {
  return rawParameters && typeof rawParameters === "object" && !Array.isArray(rawParameters)
    ? rawParameters
    : {};
}

function isValidImageUrl(url) {
  return typeof url === "string" && /^https?:\/\/\S+$/i.test(url.trim());
}

function hasImagesParam(params) {
  return normalizeImages(params.images).length > 0;
}

function hasValidImagesParam(params) {
  return normalizeImages(params.images).some(isValidImageUrl);
}

function hasValidInputImageParam(params) {
  return isValidImageUrl(params.input_image);
}

function normalizeOperation(rawOperation) {
  return typeof rawOperation === "string" ? rawOperation.trim().toLowerCase() : "";
}

/**
 * ImageGenerateNode (`base.image_generate`)
 *
 * Model-agnostic image generation runner via `#models/tools` (`executeGeneration` / `calculateCost`).
 * Model-specific settings (e.g. `aspect_ratio`, `resolution`, `quality`, `output_format`) live in
 * `parameters` and fall back to `#models/tools` model manifests.
 * Enforces fail-closed pricing: any pricing error throws immediately.
 */
export const ImageGenerateNode = {
  type: "base.image_generate",
  category: "image",
  OUTPUT_NODE: false,
  CACHEABLE: false,

  INPUT_TYPES: {
    required: {
      model: { type: "STRING" },
      prompt: { type: "STRING" },
    },
    optional: {
      images: { type: "ARRAY", default: [] },
      operation: { type: "STRING" },
      parameters: { type: "JSON", default: {} },
    },
  },

  RETURN_TYPES: {
    status: "STRING",
    image_url: "IMAGE_URL",
    assets: "ARRAY",
    metadata: "JSON",
  },

  retryPolicy: {
    maxAttempts: 1,
    backoffMs: 0,
    retryableCategories: [],
  },

  estimateCost(plannedInputs = {}) {
    if (!plannedInputs.model) {
      throw new GenerationCompilationError("Missing required model for base.image_generate cost estimation");
    }
    const baseParams = normalizeParameters(plannedInputs.parameters);
    const images = normalizeImages(plannedInputs.images);
    const operation = normalizeOperation(plannedInputs.operation);

    if (operation === "remove_background") {
      const trimmedPrompt = typeof plannedInputs.prompt === "string" ? plannedInputs.prompt.trim() : "";
      const sourceUrl =
        images[0] ||
        (typeof baseParams.input_image === "string" && baseParams.input_image.trim()) ||
        "https://planned.edit/source.png";
      const costInput = {
        ...baseParams,
        input_image: sourceUrl,
        ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
      };
      delete costInput.images;
      const res = calculateCost(plannedInputs.model, costInput);
      return extractNodeCostAmount(res, plannedInputs.model, "base.image_generate");
    }

    const costInput = {
      prompt: plannedInputs.prompt || "<planned>",
      ...baseParams,
      ...(images.length > 0 && !hasImagesParam(baseParams) ? { images } : {}),
    };
    if (operation === "edit") {
      costInput.operation = "edit";
      const hasPlannedSource =
        images.length > 0 ||
        hasImagesParam(baseParams) ||
        (typeof baseParams.input_image === "string" && baseParams.input_image.trim().length > 0);
      if (!hasPlannedSource) {
        costInput.images = ["https://planned.edit/source.png"];
      }
    }
    const res = calculateCost(plannedInputs.model, costInput);
    return extractNodeCostAmount(res, plannedInputs.model, "base.image_generate");
  },

  async execute(inputs = {}, ctx = {}) {
    if (!inputs.model || (typeof inputs.model === "string" && !inputs.model.trim())) {
      throw new GenerationValidationError("model is required for base.image_generate", { field: "model" });
    }

    const operation = normalizeOperation(inputs.operation);
    const images = normalizeImages(inputs.images);

    if (operation === "remove_background") {
      const baseParams = normalizeParameters(inputs.parameters);
      const sourceUrl = images.find(isValidImageUrl) || (isValidImageUrl(baseParams.input_image) ? baseParams.input_image.trim() : null);
      if (!sourceUrl) {
        throw new GenerationValidationError("Background removal requires a source image URL", {
          field: "images",
        });
      }
      const trimmedPrompt = typeof inputs.prompt === "string" ? inputs.prompt.trim() : "";
      const params = {
        ...baseParams,
        input_image: sourceUrl,
        ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
      };
      delete params.images;

      const res = await invokeModelGeneration({
        model: inputs.model,
        ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
        params,
        ctx,
      });

      const { url, assets } = extractImageOutput(res, inputs.model, "Provider returned no image URL");
      return {
        status: "success",
        image_url: url,
        assets,
        metadata: {
          model: inputs.model,
          ...(res?._internal?.provider ? { provider: res._internal.provider } : {}),
          ...(res?.metadata || {}),
        },
      };
    }

    if (!inputs.prompt || (typeof inputs.prompt === "string" && !inputs.prompt.trim())) {
      throw new GenerationValidationError("prompt is required for base.image_generate", { field: "prompt" });
    }

    const params = {
      ...normalizeParameters(inputs.parameters),
      prompt: inputs.prompt,
    };
    const cappedImages = capImagesForModel(images, inputs.model);
    if (cappedImages.length > 0 && !hasImagesParam(params)) {
      params.images = cappedImages;
    } else if (hasImagesParam(params)) {
      params.images = capImagesForModel(normalizeImages(params.images), inputs.model);
    }

    if (operation === "edit") {
      const hasEditSource =
        cappedImages.some(isValidImageUrl) ||
        hasValidImagesParam(params) ||
        hasValidInputImageParam(params);
      if (!hasEditSource) {
        throw new GenerationValidationError("Edit image generation requires a source image URL", {
          field: "images",
        });
      }
    }

    const res = await invokeModelGeneration({
      model: inputs.model,
      prompt: inputs.prompt,
      params,
      references: cappedImages,
      ctx,
    });

    const { url, assets } = extractImageOutput(res, inputs.model, "Provider returned no image URL");

    return {
      status: "success",
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

