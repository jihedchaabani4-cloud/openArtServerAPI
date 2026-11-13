/**
 * Media Metadata Resolver
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *   - Derives media-level metadata (aspect_ratio, width, height) needed for
 *     creating media records, placeholders, and storage assets.
 *   - Decoupled from Models Management (which owns semantic model contracts)
 *     and Workflow Execution (which only transports data).
 *
 * Priority rules for aspect_ratio:
 *   1. Explicit aspect_ratio in input or parameters (e.g. "16:9", "1:1")
 *   2. If width & height are provided → calculate closest standard aspect ratio
 *   3. Default fallback → "1:1"
 *
 * Priority rules for dimensions (width, height):
 *   1. Explicit width & height provided (> 0)
 *   2. Derived from aspect_ratio + resolution tier ("1k", "2k", "4k", "720p", "1080p")
 *   3. Default baseline dimensions (e.g. 1024x1024 for 1:1, 1344x768 for 16:9)
 */

// Canonical dimension tables by aspect ratio and resolution tier
const DIMENSION_TIERS = {
  "16:9": {
    "4k":      { width: 3840, height: 2160 },
    "2k":      { width: 2560, height: 1440 },
    "1080p":   { width: 1920, height: 1080 },
    "720p":    { width: 1280, height: 720  },
    "default": { width: 1344, height: 768  },
  },
  "9:16": {
    "4k":      { width: 2160, height: 3840 },
    "2k":      { width: 1440, height: 2560 },
    "1080p":   { width: 1080, height: 1920 },
    "720p":    { width: 720,  height: 1280 },
    "default": { width: 768,  height: 1344 },
  },
  "1:1": {
    "4k":      { width: 3840, height: 3840 },
    "2k":      { width: 2048, height: 2048 },
    "1080p":   { width: 1080, height: 1080 },
    "720p":    { width: 720,  height: 720  },
    "default": { width: 1024, height: 1024 },
  },
  "4:3": {
    "4k":      { width: 3840, height: 2880 },
    "2k":      { width: 2048, height: 1536 },
    "default": { width: 1152, height: 864  },
  },
  "3:4": {
    "4k":      { width: 2880, height: 3840 },
    "2k":      { width: 1536, height: 2048 },
    "default": { width: 864,  height: 1152 },
  },
  "21:9": {
    "4k":      { width: 3840, height: 1646 },
    "2k":      { width: 2560, height: 1097 },
    "default": { width: 1536, height: 640  },
  },
};

const STANDARD_RATIOS = [
  { ratio: "16:9", value: 16 / 9 },
  { ratio: "9:16", value: 9 / 16 },
  { ratio: "1:1",  value: 1 / 1  },
  { ratio: "4:3",  value: 4 / 3  },
  { ratio: "3:4",  value: 3 / 4  },
  { ratio: "21:9", value: 21 / 9 },
];

/**
 * Calculates the closest standard aspect ratio string from width and height.
 *
 * @param {number} width
 * @param {number} height
 * @returns {string} e.g. "16:9", "1:1", "9:16"
 */
export function calculateAspectRatio(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!w || !h || w <= 0 || h <= 0) return "1:1";

  const target = w / h;
  let closest = STANDARD_RATIOS[0];
  let minDiff = Math.abs(target - closest.value);

  for (let i = 1; i < STANDARD_RATIOS.length; i++) {
    const diff = Math.abs(target - STANDARD_RATIOS[i].value);
    if (diff < minDiff) {
      minDiff = diff;
      closest = STANDARD_RATIOS[i];
    }
  }

  // If reasonably close (< 0.15 relative difference), return standard ratio
  if (minDiff / target < 0.15) {
    return closest.ratio;
  }

  return `${w}:${h}`;
}

/**
 * Resolves complete media metadata from any input shape.
 *
 * @param {object} input - Can contain { aspect_ratio, ratio, width, height, resolution, parameters }
 * @returns {{ aspect_ratio: string, width: number, height: number }}
 */
export function resolveMediaMetadata(input = {}, defaultRatio = "1:1") {
  if (!input || typeof input !== "object") {
    const ratioTable = DIMENSION_TIERS[defaultRatio] || DIMENSION_TIERS["1:1"];
    const dims = ratioTable["default"] || { width: 1024, height: 1024 };
    return { aspect_ratio: defaultRatio, width: dims.width, height: dims.height };
  }

  const params = (input.parameters && typeof input.parameters === "object")
    ? input.parameters
    : {};

  // ── 1. Resolve aspect_ratio ───────────────────────────────────────────────
  let resolvedRatio = input.aspect_ratio || params.aspect_ratio || input.ratio || params.ratio || null;

  if (typeof resolvedRatio === "string") {
    resolvedRatio = resolvedRatio.trim();
  } else {
    resolvedRatio = null;
  }

  // If no explicit aspect_ratio, try deriving from width & height
  const explicitWidth  = Number(input.width || params.width) || null;
  const explicitHeight = Number(input.height || params.height) || null;

  if (!resolvedRatio) {
    if (explicitWidth && explicitHeight) {
      resolvedRatio = calculateAspectRatio(explicitWidth, explicitHeight);
    } else {
      resolvedRatio = defaultRatio;
    }
  }

  // ── 2. Resolve width & height ─────────────────────────────────────────────
  if (explicitWidth && explicitHeight && explicitWidth > 0 && explicitHeight > 0) {
    return {
      aspect_ratio: resolvedRatio,
      width: explicitWidth,
      height: explicitHeight,
    };
  }

  // Derive from aspect_ratio + resolution
  const resolution = String(input.resolution || params.resolution || "").trim().toLowerCase();
  const ratioTable = DIMENSION_TIERS[resolvedRatio] || DIMENSION_TIERS["1:1"];
  const dimensions = ratioTable[resolution] || ratioTable["default"] || { width: 1024, height: 1024 };

  return {
    aspect_ratio: resolvedRatio,
    width: dimensions.width,
    height: dimensions.height,
  };
}

export default resolveMediaMetadata;
