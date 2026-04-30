import { IMAGE_ROUTES }             from "#image/core/modelRouter.js";
import { MODEL_INFO as VIDEO_MODEL_INFO, AVAILABLE_MODELS as VIDEO_FAMILY_KEYS, MODEL_ROUTES } from "#video/core/modelRouter.js";

/** UI / legacy ids → registry keys */
const IMAGE_MODEL_ALIASES = {
    nanobana_normal: "nanobana",
    runway_gen4:     "seedream-pro",
};

export function normalizeImageModelName(name) {
    if (name == null || name === "") return undefined;
    const t = String(name).trim();
    if (!t) return undefined;
    return IMAGE_MODEL_ALIASES[t] ?? t;
}

export function isModelHidden(name) {
    if (!name) return false;
    const key = String(name).trim();
    
    const isHiddenOrClosed = (route) => route && (route.hidden || route.open === false);

    if (isHiddenOrClosed(MODEL_ROUTES[key])) return true;
    if (isHiddenOrClosed(IMAGE_ROUTES[key])) return true;

    for (const rKey in MODEL_ROUTES) {
        if (isHiddenOrClosed(MODEL_ROUTES[rKey])) {
            const regKey = MODEL_ROUTES[rKey]._registryKey;
            if (key === regKey) return true;
            if (key.startsWith(`${regKey}_`)) return true; // Matches regKey_t2v, regKey_i2v, etc.
        }
    }

    for (const rKey in IMAGE_ROUTES) {
        if (isHiddenOrClosed(IMAGE_ROUTES[rKey])) {
            const regKey = IMAGE_ROUTES[rKey]._registryKey;
            if (key === regKey) return true;
            if (key.startsWith(`${regKey}_`)) return true;
        }
    }
    
    return false;
}

/**
 * @returns {boolean} false if name is set but not in registry
 */
export function isImageModelRegistered(name) {
    if (name == null || name === "") return true;
    const key = String(name).trim();
    if (!key) return true;
    
    if (isModelHidden(key)) return false;
    
    return Boolean(IMAGE_ROUTES[key]);
}

/**
 * Video: either a family key (kling_v3, …) or a concrete registry slug.
 */
export function isVideoModelRegistered(name) {
    if (name == null || name === "") return true;
    const key = String(name).trim();
    if (!key) return true;
    
    if (isModelHidden(key)) return false;
    
    // Check family keys (kling_v3) or direct routes (kling_v3_std_t2v)
    return Boolean(VIDEO_MODEL_INFO[key]) || Boolean(MODEL_ROUTES[key]) || VIDEO_FAMILY_KEYS.includes(key);
}
