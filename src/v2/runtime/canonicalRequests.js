export const CANONICAL_OPERATIONS = Object.freeze({
  IMAGE_GENERATION: "IMAGE_GENERATION",
  IMAGE_EDIT: "IMAGE_EDIT",
  IMAGE_UPSCALE: "IMAGE_UPSCALE",
  VIDEO_GENERATION: "VIDEO_GENERATION",
  VIDEO_EDIT: "VIDEO_EDIT",
  VIDEO_UPSCALE: "VIDEO_UPSCALE",
  LLM_TEXT: "LLM_TEXT",
  LLM_JSON: "LLM_JSON",
});

function normalizeOperation(operation, { domain = null, mode = null } = {}) {
  if (!operation && domain === "image") return CANONICAL_OPERATIONS.IMAGE_GENERATION;
  if (!operation && domain === "video") return CANONICAL_OPERATIONS.VIDEO_GENERATION;
  const raw = String(operation || "").trim();
  if (!raw) return null;
  if (Object.values(CANONICAL_OPERATIONS).includes(raw)) return raw;
  const key = raw.toLowerCase();
  if (key === "upscale" && domain === "video") return CANONICAL_OPERATIONS.VIDEO_UPSCALE;
  if (key === "upscale" && domain === "image") return CANONICAL_OPERATIONS.IMAGE_UPSCALE;
  if ((key === "media-transform" || key === "edit") && domain === "video") return CANONICAL_OPERATIONS.VIDEO_EDIT;
  if ((key === "media-transform" || key === "edit") && domain === "image") return CANONICAL_OPERATIONS.IMAGE_EDIT;
  if (mode === "v2v" || mode === "i2v") return CANONICAL_OPERATIONS.VIDEO_GENERATION;
  return raw.toUpperCase().replaceAll("-", "_");
}

export function buildCanonicalImageRequest(input = {}, { operation = CANONICAL_OPERATIONS.IMAGE_GENERATION } = {}) {
  return {
    operation: normalizeOperation(operation, { domain: "image" }),
    modelKey: input.modelKey || input.model || "gpt-image-2",
    prompt: input.prompt || "",
    negativePrompt: input.negativePrompt || input.negative_prompt || "",
    aspectRatio: input.aspectRatio || input.aspect_ratio || input.ratio || "1:1",
    width: input.width,
    height: input.height,
    quality: input.quality || "standard",
    count: Math.max(1, Number(input.count) || 1),
    seed: input.seed ?? null,
    references: input.references || input.input_assets || [],
    sourceImage: input.sourceImage || input.source_url || input.source_asset?.url || input.image || null,
    mask: input.mask || input.mask_url || null,
  };
}

export function buildCanonicalVideoRequest(input = {}, { operation = CANONICAL_OPERATIONS.VIDEO_GENERATION } = {}) {
  return {
    operation: normalizeOperation(operation, { domain: "video", mode: input.mode }),
    modelKey: input.modelKey || input.model || "kling-v3",
    mode: input.mode || (input.source_url || input.source_asset ? "i2v" : "t2v"),
    prompt: input.prompt || "",
    aspectRatio: input.aspectRatio || input.aspect_ratio || input.ratio || "16:9",
    durationSeconds: Number(input.durationSeconds ?? input.duration ?? 5),
    resolution: input.resolution || "720p",
    fps: input.fps,
    references: input.references || input.input_assets || [],
    startFrame: input.startFrame || input.start_frame || null,
    endFrame: input.endFrame || input.end_frame || null,
    cameraControl: input.cameraControl || input.camera_control || null,
  };
}

export function buildCanonicalRequest(input = {}, { domain = null, operation = null } = {}) {
  const resolvedDomain = domain || (String(operation || "").toLowerCase().includes("video") ? "video" : "image");
  return resolvedDomain === "video"
    ? buildCanonicalVideoRequest(input, { operation })
    : buildCanonicalImageRequest(input, { operation });
}
