import { IMAGE_ROUTES }             from "#image/core/modelRouter.js";
import { MODEL_INFO as VIDEO_MODEL_INFO, MODEL_ROUTES } from "#video/core/modelRouter.js";

/** UI / legacy ids → registry keys */
const IMAGE_MODEL_ALIASES = {
    nanobana_normal: "nanobana",
};

export function normalizeImageModelName(name) {
    if (name == null || name === "") return undefined;
    const t = String(name).trim();
    if (!t) return undefined;
    return IMAGE_MODEL_ALIASES[t] ?? t;
}

// ── Cache for hidden models (O(1) lookup) ──
const HIDDEN_MODELS_CACHE = new Set();
function _initHiddenCache() {
    const isHiddenOrClosed = (route) => route && (route.hidden || route.open === false);
    for (const key in MODEL_ROUTES) {
        if (isHiddenOrClosed(MODEL_ROUTES[key])) {
            HIDDEN_MODELS_CACHE.add(key);
            if (MODEL_ROUTES[key]._registryKey) HIDDEN_MODELS_CACHE.add(MODEL_ROUTES[key]._registryKey);
        }
    }
    for (const key in IMAGE_ROUTES) {
        if (isHiddenOrClosed(IMAGE_ROUTES[key])) {
            HIDDEN_MODELS_CACHE.add(key);
            if (IMAGE_ROUTES[key]._registryKey) HIDDEN_MODELS_CACHE.add(IMAGE_ROUTES[key]._registryKey);
        }
    }
}
_initHiddenCache();

export function isModelHidden(name) {
    if (!name) return false;
    const key = String(name).trim();
    
    if (HIDDEN_MODELS_CACHE.has(key)) return true;
    
    for (const hiddenKey of HIDDEN_MODELS_CACHE) {
        if (key.startsWith(`${hiddenKey}_`)) return true;
    }
    
    return false;
}

/**
 * @returns {boolean} false if name is set but not in registry
 */
export function isImageModelRegistered(name) {
    if (name == null || name === "") return false;
    const key = String(name).trim();
    if (!key) return false;
    
    if (isModelHidden(key)) return false;
    
    return Boolean(IMAGE_ROUTES[key]);
}

/**
 * Video: either a family key (kling_v3, …) or a concrete registry slug.
 */
export function isVideoModelRegistered(name) {
    if (name == null || name === "") return false;
    const key = String(name).trim();
    if (!key) return false;
    
    if (isModelHidden(key)) return false;
    
    return Boolean(MODEL_ROUTES[key]);
}
