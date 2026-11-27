const VIDEO_EXTENSION_REGEX = /\.(?:mp4|webm|mov|m4v)(?:$|[?#])/i;

/**
 * Normalizes a list of allowed media type strings into a lowercase Set (or null if unrestricted).
 *
 * @param {string[]|null|undefined} raw
 * @returns {Set<string>|null}
 */
export function normalizeAllowedMediaTypes(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const normalized = raw
    .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
    .filter(Boolean);
  return normalized.length > 0 ? new Set(normalized) : null;
}

/**
 * Infers canonical media type ("image" | "video" | "audio") from explicit fields, MIME type,
 * step ID, or URL file extension. Defaults to "image" when undetermined.
 *
 * @param {Object} [info={}]
 * @returns {"image"|"video"|"audio"}
 */
export function inferMediaType({
  url = "",
  mimeType = null,
  mime_type = null,
  stepId = null,
  step_id = null,
  mediaType = null,
  media_type = null,
} = {}) {
  const explicitType = String(mediaType || media_type || "").trim().toLowerCase();
  if (explicitType === "video" || explicitType === "image" || explicitType === "audio") {
    return explicitType;
  }

  const mime = String(mimeType || mime_type || "").trim().toLowerCase();
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";

  const step = String(stepId || step_id || "").trim().toLowerCase();
  if (step === "video_generation" || step.startsWith("video_")) return "video";

  if (typeof url === "string" && url.trim()) {
    const trimmed = url.trim();
    try {
      const pathname = new URL(trimmed).pathname;
      if (VIDEO_EXTENSION_REGEX.test(pathname)) return "video";
    } catch {
      if (VIDEO_EXTENSION_REGEX.test(trimmed)) return "video";
    }
  }

  return "image";
}

export default { normalizeAllowedMediaTypes, inferMediaType };
