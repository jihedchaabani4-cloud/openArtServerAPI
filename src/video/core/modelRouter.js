/**
 * ─── Model Dispatch Router ────────────────────────────────────────────────────
 *
 * THE ONLY FILE you need to edit to switch/add providers per model or per mode.
 *
 * Two routing styles supported:
 *
 *   1. SIMPLE   → one runner handles all modes for a model key
 *      "kling_v3": fromRegistry("kling_v3_wavespeed")
 *
 *   2. PER-MODE → different runner per mode  (e.g. replicate for motion)
 *      "kling_v3": fromRegistry("kling_v3_wavespeed", VIDEO_MODEL_TYPES.GENERATED, {
 *          motion: replicateModels["kling_v3_replicate"]?.motion,
 *      })
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Model Type Constants ──────────────────────────────────────────────────────
export const VIDEO_MODEL_TYPES = {
    GENERATED: "generated",
    UPSCALE:   "upscale",
};

// ── Per-Runner Registry Imports ───────────────────────────────────────────────
import { MODELS as wavespeedModels, MODEL_INFO as wavespeedInfo } from "#video/runners/wavespeed/registry.js";
import { MODELS as replicateModels, MODEL_INFO as replicateInfo } from "#video/runners/replicate/registry.js";
import { MODELS as googleModels,    MODEL_INFO as googleInfo     } from "#video/runners/google/registry.js";

// ── Combined Registry Lookup ──────────────────────────────────────────────────
const ALL_REGISTRY_MODELS = {
    ...wavespeedModels,
    ...replicateModels,
    ...googleModels,
};

// ── Aggregated MODEL_INFO (from all registries) ───────────────────────────────
export const MODEL_INFO = {
    ...googleInfo,
    ...wavespeedInfo,
    ...replicateInfo,
};

function fromRegistry(key, displayName = null, supportsEdit = false, supportsCamera = false, type = VIDEO_MODEL_TYPES.GENERATED, overrides = {}) {
    const group = ALL_REGISTRY_MODELS[key];
    const info = MODEL_INFO[key] ? { ...MODEL_INFO[key] } : {};
    
    if (displayName) {
        info.displayName = displayName;
    }

    if (!group) throw new Error(`[videoRouter] Model "${key}" not found in any registry`);
    return {
        t2v:      group.t2v      || null,
        i2v:      group.i2v      || null,
        i2v_se:   group.i2v_se   || null,
        motion:   group.motion   || null,
        r2v:      group.r2v      || null,
        v2v:      group.v2v      || null,
        upscale:  group.upscale  || null,
        _default: group._default || null,
        // store the registry key for getModelName()
        _registryKey: key,
        group,
        info,
        type,
        open: true,
        supportsEdit,
        supportsCamera,

        ...overrides,
    };
}

// ── Route Table ───────────────────────────────────────────────────────────────
export const MODEL_ROUTES = {
    // ── Google Models ─────────────────────────────────────────────────────────
    "nanobana_google": fromRegistry("nanobana_google", "Nano Banana Video"),
    "veo_google":      fromRegistry("veo_google", "Google Veo 3.1"),

    // ── Kling v2.6 ───────────────────────────────────────────────────────────
    "kling_v2":      fromRegistry("kling_v2_wavespeed", "Kling v2.6", false, true),
    "kling_v2_pro":  fromRegistry("kling_v2_pro_wavespeed", "Kling v2.6 Pro", false, true),

    // ── Kling v2.1 ───────────────────────────────────────────────────────────
    "kling_v21_pro": fromRegistry("kling_v21_pro_wavespeed", "Kling v2.1 Pro Keyframes", false, true),

    // ── Kling v3.0 ───────────────────────────────────────────────────────────
    "kling_v3":     fromRegistry("kling_v3_wavespeed", "Kling v3.0", false, true),
    "kling_v3_pro": fromRegistry("kling_v3_pro_wavespeed", "Kling v3.0 Pro", false, true),

    // ── Kling O3 ─────────────────────────────────────────────────────────────
    "kling_o3":     fromRegistry("kling_o3_wavespeed", "Kling O3", true, true),
    "kling_o3_pro": fromRegistry("kling_o3_pro_wavespeed", "Kling O3 Pro", false, true),



    // ── Seedance v1.5 Pro ───────────────────────────────────────────────────
    "seedance_v15_pro":       fromRegistry("seedance_v15_pro_wavespeed", "Seedance v1.5 Pro", true),
    "seedance_v15_pro_fast":  fromRegistry("seedance_v15_pro_fast_wavespeed", "Seedance v1.5 Pro Fast"),
    "seedance_v15_pro_spicy": fromRegistry("seedance_v15_pro_spicy_wavespeed", "Seedance v1.5 Pro Spicy", true),

    // ── RunwayML Gen-4 ───────────────────────────────────────────────────────
    "runway_gen4_turbo": fromRegistry("runway_gen4_turbo_wavespeed", "RunwayML Gen-4 Turbo", false, true),
    "runway_gen4_aleph": fromRegistry("runway_gen4_aleph_wavespeed", "RunwayML Gen-4 Aleph", true, true),

    // ── Topaz Video Models ───────────────────────────────────────────────────
    "topaz_video_upscale": fromRegistry("topaz_video_upscale_replicate", "Topaz Video Upscale", false, VIDEO_MODEL_TYPES.UPSCALE),
};


// ── Resolver ──────────────────────────────────────────────────────────────────
/**
 * getRunner(modelKey, mode)
 * Resolves the correct runner for a model + mode combination.
 * ONLY for GENERATED models.
 */
export function getRunner(modelKey, mode) {
    const route = MODEL_ROUTES[modelKey];
    if (!route || route.type !== VIDEO_MODEL_TYPES.GENERATED) return null;

    // Reject if model is completely disabled
    if (!route.open) return null;

    // Reject based on capabilities
    if (mode === "v2v" && !route.supportsEdit) return null;

    if (typeof route === "object" && !route.adapt) {
        return route[mode] || route["_default"] || null;
    }
    return route;
}

/**
 * getUpscaleRunner(modelKey)
 * Resolves the correct runner for an UPSCALE model.
 */
export function getUpscaleRunner(modelKey) {
    const route = MODEL_ROUTES[modelKey];
    if (!route || route.type !== VIDEO_MODEL_TYPES.UPSCALE) return null;

    if (!route.open) return null;

    if (typeof route === "object" && !route.adapt) {
        return route["upscale"] || route["_default"] || null;
    }
    return route;
}

/**
 * getModelName(modelKey, mode)
 * Returns the registry-level model name string for logging/DB storage.
 * Replaces MODEL_TYPE_MAP[model]?.[mode] from modelMap.js.
 */
export function getModelName(modelKey, mode) {
    const route = MODEL_ROUTES[modelKey];
    if (!route) return modelKey;

    const runner = route[mode] || route["_default"] || null;
    // runner may expose modelName (e.g. WavespeedVideoRunner.modelName)
    return runner?.modelName || runner?.model || `${route._registryKey}_${mode}` || modelKey;
}

// ── Model State Variables ─────────────────────────────────────────────────────

export const OPEN_MODELS = Object.keys(MODEL_ROUTES).filter(
    (key) => MODEL_ROUTES[key].open === true
);

export const CLOSED_MODELS = Object.keys(MODEL_ROUTES).filter(
    (key) => MODEL_ROUTES[key].open === false
);

export const EDIT_SUPPORT_MODELS = Object.keys(MODEL_ROUTES).filter(
    (key) => MODEL_ROUTES[key].supportsEdit === true
);

export const NO_EDIT_MODELS = Object.keys(MODEL_ROUTES).filter(
    (key) => MODEL_ROUTES[key].supportsEdit === false
);

export const ROUTED_MODELS = Object.keys(MODEL_ROUTES).filter(
    (key) => MODEL_ROUTES[key].type === VIDEO_MODEL_TYPES.GENERATED && MODEL_ROUTES[key].open
);

export const UPSCALE_MODELS = Object.keys(MODEL_ROUTES).filter(
    (key) => MODEL_ROUTES[key].type === VIDEO_MODEL_TYPES.UPSCALE && MODEL_ROUTES[key].open
);

export const AVAILABLE_MODELS = Object.keys(MODEL_ROUTES).filter(
    (key) => MODEL_ROUTES[key].open
);
