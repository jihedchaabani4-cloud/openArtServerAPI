export function normalizeRatioToNumeric(ratio) {
  if (!ratio) return "1:1";
  const normalized = String(ratio).trim().toUpperCase();
  if (normalized === "SQUARE") return "1:1";
  if (normalized === "LANDSCAPE") return "16:9";
  if (normalized === "PORTRAIT") return "9:16";
  return ratio;
}

export function buildGenerationConfig(nodeTypeOrConfig = {}, input = {}) {
  if (typeof nodeTypeOrConfig === "string") {
    const nodeType = nodeTypeOrConfig;
    const isEdit =
      nodeType === "media-transform" || Boolean(input?.source_asset);

    const rawRatio = input?.ratio || input?.aspect_ratio || "1:1";

    return {
      prompt: input?.prompt || "",
      model: input?.model || "unknown",
      aspect_ratio: normalizeRatioToNumeric(rawRatio),
      generation_type: isEdit ? "IMAGE_TO_IMAGE" : "TEXT_ONLY",
      seed: input?.seed || null,
    };
  }

  const {
    prompt = "",
    model = "unknown",
    aspect_ratio = "1:1",
    generation_type = "TEXT_ONLY",
    seed = null,
    ...extras
  } = nodeTypeOrConfig || {};

  const rawRatio = nodeTypeOrConfig?.ratio || aspect_ratio;

  return {
    prompt,
    model,
    aspect_ratio: normalizeRatioToNumeric(rawRatio),
    generation_type,
    seed,
    ...extras,
  };
}

export function buildDisplayName(promptOrInput = "") {
  const prompt =
    typeof promptOrInput === "string"
      ? promptOrInput
      : promptOrInput?.prompt || "";

  const raw = prompt.trim();
  if (!raw) return "Untitled Generation";
  return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
}

export function inferStepId(nodeType, input = {}) {
  if (nodeType === "media-transform") return "EDIT";
  if (nodeType === "video-generation") return "VID";
  if (nodeType === "upscale") return "UPSCALE";
  return "GEN";
}

export function getAspectRatio(width, height) {
  if (!width || !height) return "1:1";
  const ratio = width / height;
  if (ratio > 1.6) return "16:9";
  if (ratio > 1.3) return "4:3";
  if (ratio < 0.6) return "9:16";
  if (ratio < 0.8) return "3:4";
  return "1:1";
}
