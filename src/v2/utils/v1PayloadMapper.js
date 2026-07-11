/**
 * V1-to-V2 Payload Mapper
 *
 * Centralized translation layer that converts V1 API request bodies
 * into V2 workflow inputs (compatible with YAML workflow definitions).
 *
 * Usage:
 *   import { mapImageGenerationV1, mapEditImageV1, ... } from './v1PayloadMapper.js';
 */

import { normalizeImageModelName } from "../../../lib/modelRegistryKeys.js";

// ─────────────────────────────────────────────────────
// Normalization helpers
// ─────────────────────────────────────────────────────

/**
 * Maps V1 ratio string to V2 aspect_ratio enum.
 * V1 uses "1:1", "16:9", "9:16" etc.
 * V2 uses "SQUARE", "LANDSCAPE", "PORTRAIT", etc.
 */
export function normalizeAspectRatio(ratio) {
  if (!ratio) return "SQUARE";
  const map = {
    "1:1": "SQUARE",
    "4:3": "LANDSCAPE",
    "3:4": "PORTRAIT",
    "16:9": "LANDSCAPE",
    "9:16": "PORTRAIT",
    "21:9": "LANDSCAPE",
    "SQUARE": "SQUARE",
    "LANDSCAPE": "LANDSCAPE",
    "PORTRAIT": "PORTRAIT",
  };
  return map[ratio] || "SQUARE";
}

/**
 * Normalizes a count value from V1 body, ensuring at least 1.
 */
export function normalizeCount(count, num_images) {
  return Math.max(1, Number(count ?? num_images ?? 1));
}

// ─────────────────────────────────────────────────────
// Image Generation  →  simple-image-v1
// ─────────────────────────────────────────────────────

/**
 * Maps a V1 POST /api/images/generated(V2) body to V2 simple-image-v1 workflow inputs.
 */
export function mapImageGenerationV1(v1Body) {
  const { prompt, negative_prompt, ratio, quality, resolution, count, num_images, model_name, references = [] } = v1Body;
  return {
    prompt: prompt || "",
    negative_prompt: negative_prompt || "",
    model: normalizeImageModelName(model_name) || "fal",
    aspect_ratio: normalizeAspectRatio(ratio),
    quality: quality || resolution || "standard",
    count: normalizeCount(count, num_images),
    references,
  };
}

// ─────────────────────────────────────────────────────
// Image Edit  →  edit-image-v1
// ─────────────────────────────────────────────────────

/**
 * Maps a V1 image edit body to V2 edit-image-v1 workflow inputs.
 * @param {Object} v1Body         — parsed request body
 * @param {Object|null} sourceAsset — resolved { url, width, height } from DB
 */
export function mapEditImageV1(v1Body, sourceAsset) {
  const { prompt, ratio, quality, resolution, strength, model_name, references = [] } = v1Body;
  return {
    prompt: prompt || "",
    model: normalizeImageModelName(model_name) || null,
    aspect_ratio: normalizeAspectRatio(ratio),
    quality: quality || resolution || "standard",
    strength: strength ?? 0.75,
    source_asset: sourceAsset
      ? { url: sourceAsset.url, width: sourceAsset.width, height: sourceAsset.height }
      : null,
    references,
    mode: "image_edit",
  };
}

// ─────────────────────────────────────────────────────
// Video Generation  →  cinematic-video-v1
// ─────────────────────────────────────────────────────

/**
 * Maps a V1 POST /api/video/generated body to V2 cinematic-video-v1 workflow inputs.
 */
export function mapVideoGenerationV1(v1Body) {
  const { prompt, model, model_name, ratio = "16:9", duration = "5s", references = [], negativePrompt = "" } = v1Body;
  const rawModel = (model ?? model_name ?? "").trim();
  return {
    prompt: prompt || "",
    model: rawModel || null,
    aspect_ratio: normalizeAspectRatio(ratio),
    duration: duration,
    negative_prompt: negativePrompt || "",
    references,
  };
}

// ─────────────────────────────────────────────────────
// Edit / Extend / Motion Control Video → edit-video-v1
// ─────────────────────────────────────────────────────

/**
 * Maps a V1 video edit/extend body to V2 edit-video-v1 workflow inputs.
 * @param {Object} v1Body         — parsed request body
 * @param {Object|null} sourceAsset — resolved { url } from DB
 */
export function mapEditVideoV1(v1Body, sourceAsset) {
  const { prompt, model, model_name, ratio = "16:9", duration = "5s", references = [], camera_control } = v1Body;
  const rawModel = (model ?? model_name ?? "").trim();
  return {
    prompt: prompt || "",
    model: rawModel || null,
    source_asset: sourceAsset
      ? { url: sourceAsset.url, width: sourceAsset.width, height: sourceAsset.height }
      : null,
    mode: "video_to_video",
    duration,
    references,
    camera_control: camera_control || null,
  };
}

/**
 * Maps a V1 motion control request to V2 edit-video-v1.
 * Uses the image as the source_asset and the video as a motion reference.
 */
export function mapMotionControlV1(v1Body, imageUrl, videoUrl) {
  const { prompt, model, model_name, ratio = "16:9", duration = "5s", references = [] } = v1Body;
  const rawModel = (model ?? model_name ?? "").trim();
  
  // Combine incoming references with the motion video reference
  const combinedReferences = [...references];
  if (videoUrl) {
    combinedReferences.push({ type: "video", url: videoUrl, role: "motion_reference" });
  }

  return {
    prompt: prompt || "",
    model: rawModel || null,
    source_asset: imageUrl ? { url: imageUrl } : null,
    mode: "image_to_video",
    duration,
    references: combinedReferences,
  };
}

// ─────────────────────────────────────────────────────
// Upscale  →  upscale-v1
// ─────────────────────────────────────────────────────

/**
 * Maps a V1 upscale body to V2 upscale-v1 workflow inputs.
 * @param {Object} v1Body         — parsed request body
 * @param {Object|null} sourceAsset — resolved { url } from DB (primary media of workflow)
 */
export function mapUpscaleV1(v1Body, sourceAsset) {
  const { upscaleScale = 2, target_resolution } = v1Body;
  return {
    source_asset: sourceAsset
      ? { url: sourceAsset.url, width: sourceAsset.width, height: sourceAsset.height }
      : null,
    factor: Number(upscaleScale ?? 2),
    target_resolution: target_resolution || null,
  };
}

// ─────────────────────────────────────────────────────
// Element Sheet  →  character-sheet-v1
// ─────────────────────────────────────────────────────

/**
 * Maps a V1 element sheet body to V2 character-sheet-v1 (or equivalent) workflow inputs.
 */
export function mapElementSheetV1(v1Body, sheetType) {
  const { prompt, features, model_name, references = [] } = v1Body;
  const sheetWorkflowMap = {
    CHARACTER: "character-sheet-v1",
    LOCATION: "character-sheet-v1",   // reuses character sheet workflow for location
    PRODUCT: "character-sheet-v1",    // reuses character sheet workflow for product
  };
  return {
    workflowId: sheetWorkflowMap[sheetType] || "character-sheet-v1",
    input: {
      prompt: prompt || "",
      model: normalizeImageModelName(model_name) || null,
      characters: features ? [{ name: sheetType, description: prompt, traits: features }] : [],
      references,
    },
  };
}

// ─────────────────────────────────────────────────────
// Response builder
// ─────────────────────────────────────────────────────

/**
 * Builds a V1-compatible HTTP response object from a V2 run result
 * and the pre-created V1 placeholder IDs.
 *
 * @param {Object} opts
 * @param {string} opts.runId          — V2 run_id
 * @param {string|null} opts.v1WorkflowId    — placeholder workflow UUID
 * @param {string|null} opts.v1MediaId       — placeholder media UUID
 * @param {string|null} opts.projectId
 * @param {string|null} opts.sessionId
 * @returns {Object} JSON-serializable V1-compatible response
 */
export function buildV1CompatibleResponse({ runId, v1WorkflowId, v1MediaId, projectId = null, sessionId = null }) {
  const workflows = v1WorkflowId
    ? [{ id: v1WorkflowId, primary_media_id: v1MediaId }]
    : [];

  return {
    ok: true,
    status: "processing",
    taskId: runId,
    jobId: runId,
    batchId: null,
    configId: null,
    workflows,
    project_id: projectId,
    session_id: sessionId,
  };
}
