import { getCatalog } from "../src/models/index.js";

const IMAGE_MODEL_ALIASES = {
    nanobana_normal: "nanobana",
};

export function normalizeImageModelName(name) {
    if (name == null || name === "") return undefined;
    const t = String(name).trim();
    if (!t) return undefined;
    return IMAGE_MODEL_ALIASES[t] ?? t;
}

export function isModelHidden(name) {
    return false;
}

export function isImageModelRegistered(name) {
    if (!name) return false;
    const normalized = normalizeImageModelName(name);
    const catalog = getCatalog({ domain: "image" });
    return catalog.some(m => m.modelFamily === normalized);
}

/**
 * Video: check if a model family key exists in the active video catalog.
 */
export function isVideoModelRegistered(name) {
    if (name == null || name === "") return false;
    const key = String(name).trim();
    if (!key) return false;
    const catalog = getCatalog({ domain: "video" });
    return catalog.some(m => m.modelFamily === key);
}
