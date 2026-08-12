/**
 * V2 Payload Utilities & Normalization Helpers
 */

/**
 * Maps ratio string to standard V2 aspect_ratio enum ("1:1", "16:9", "9:16", "4:3", "3:4", "21:9").
 */
export function normalizeAspectRatio(ratio) {
  if (!ratio) return "1:1";
  const map = {
    "1:1": "1:1",
    "4:3": "4:3",
    "3:4": "3:4",
    "16:9": "16:9",
    "9:16": "9:16",
    "21:9": "21:9",
    "SQUARE": "1:1",
    "LANDSCAPE": "16:9",
    "PORTRAIT": "9:16",
  };
  return map[ratio] || "1:1";
}

/**
 * Normalizes a count value, ensuring at least 1.
 */
export function normalizeCount(count, num_images) {
  const val = Number(count ?? num_images ?? 1);
  return isNaN(val) ? 1 : Math.max(1, val);
}
