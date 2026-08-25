/**
 * Model Reference Tag Transformer
 *
 * Different AI image models expect different reference tag syntax in prompts:
 * - Google/NanoBanana/Gemini: `input_file_0.png`, `input_file_1.png`
 * - Seedream/ByteDance/Doubao: `image 1`, `image 2`
 * - GPT-Image/OpenAI: `image 1`, `image 2`
 * - SDXL/Replicate: `[image 1]`, `[image 2]`
 * - Flux/Wavespeed/Fal/Midjourney: `@image1`, `@image2`
 *
 * This module dynamically maps and converts any reference tokens in the prompt
 * to the exact syntax expected by the active model runner.
 */

export const MODEL_REFERENCE_FORMATS = {
  // @image1, @image2 (1-indexed @ prefix) -> Default for Flux, Midjourney, Fal, Wavespeed
  AT_IMAGE_1: "at_image_1",

  // @image0, @image1 (0-indexed @ prefix)
  AT_IMAGE_0: "at_image_0",

  // input_file_0.png, input_file_1.png -> Google Gemini / NanoBanana multimodal edits
  INPUT_FILE_0: "input_file_0",

  // "image 1", "image 2" -> Seedream, ByteDance, GPT-Image
  IMAGE_1_PLAIN: "image_1_plain",

  // "image 0", "image 1"
  IMAGE_0_PLAIN: "image_0_plain",

  // "[image 1]", "[image 2]" -> SDXL / Replicate
  BRACKET_IMAGE_1: "bracket_image_1",
};

/**
 * Maps a model name to its preferred reference tag format.
 * @param {string} modelName
 * @returns {string} One of MODEL_REFERENCE_FORMATS
 */
export function resolveModelReferenceFormat(modelName = "") {
  const norm = String(modelName || "").toLowerCase().trim();

  // Google / Gemini / NanoBanana
  if (
    norm.includes("nano-banana") ||
    norm.includes("nanobana") ||
    norm.includes("gemini") ||
    norm.includes("google")
  ) {
    return MODEL_REFERENCE_FORMATS.INPUT_FILE_0;
  }

  // Seedream / ByteDance / Doubao
  if (
    norm.includes("seedream") ||
    norm.includes("bytedance") ||
    norm.includes("doubao")
  ) {
    return MODEL_REFERENCE_FORMATS.IMAGE_1_PLAIN;
  }

  // GPT / OpenAI DALL-E
  if (
    norm.includes("gpt") ||
    norm.includes("openai") ||
    norm.includes("dall-e")
  ) {
    return MODEL_REFERENCE_FORMATS.IMAGE_1_PLAIN;
  }

  // SDXL / Replicate / Stable Diffusion
  if (
    norm.includes("sdxl") ||
    norm.includes("stable-diffusion") ||
    norm.includes("replicate")
  ) {
    return MODEL_REFERENCE_FORMATS.BRACKET_IMAGE_1;
  }

  // Default for Flux, Midjourney, Fal, Wavespeed
  return MODEL_REFERENCE_FORMATS.AT_IMAGE_1;
}

/**
 * Generates the replacement tag string for a 1-based index according to format.
 * @param {number} oneBasedIndex (1, 2, 3...)
 * @param {string} format
 * @returns {string}
 */
export function formatTagForIndex(oneBasedIndex, format) {
  const idx0 = oneBasedIndex - 1; // 0-based
  const idx1 = oneBasedIndex;     // 1-based

  switch (format) {
    case MODEL_REFERENCE_FORMATS.INPUT_FILE_0:
      return `input_file_${idx0}.png`;
    case MODEL_REFERENCE_FORMATS.IMAGE_1_PLAIN:
      return `image ${idx1}`;
    case MODEL_REFERENCE_FORMATS.IMAGE_0_PLAIN:
      return `image ${idx0}`;
    case MODEL_REFERENCE_FORMATS.AT_IMAGE_0:
      return `@image${idx0}`;
    case MODEL_REFERENCE_FORMATS.BRACKET_IMAGE_1:
      return `[image ${idx1}]`;
    case MODEL_REFERENCE_FORMATS.AT_IMAGE_1:
    default:
      return `@image${idx1}`;
  }
}

/**
 * Transforms any reference tags in a prompt into the exact target format required by the model.
 *
 * Supports transforming from:
 * - @image1, @image2, @image0
 * - input_file_0.png, input_file_1.png
 * - image 1, image 2
 * - [image 1], [image 2]
 *
 * @param {string} prompt
 * @param {string} modelName
 * @returns {string}
 */
export function transformPromptForModel(prompt = "", modelName = "") {
  if (typeof prompt !== "string" || !prompt.trim()) return prompt;

  const targetFormat = resolveModelReferenceFormat(modelName);

  let transformed = prompt;

  // 1. Transform @imageN (1-based or 0-based)
  transformed = transformed.replace(/@image(\d+)/gi, (match, digits) => {
    const num = parseInt(digits, 10);
    const oneBasedIdx = num === 0 ? 1 : num;
    return formatTagForIndex(oneBasedIdx, targetFormat);
  });

  // 2. Transform input_file_N.png
  transformed = transformed.replace(/input_file_(\d+)\.png/gi, (match, digits) => {
    const num0 = parseInt(digits, 10);
    const oneBasedIdx = num0 + 1;
    return formatTagForIndex(oneBasedIdx, targetFormat);
  });

  // 3. Transform [image N]
  transformed = transformed.replace(/\[image\s*(\d+)\]/gi, (match, digits) => {
    const num = parseInt(digits, 10);
    const oneBasedIdx = num === 0 ? 1 : num;
    return formatTagForIndex(oneBasedIdx, targetFormat);
  });

  return transformed;
}
