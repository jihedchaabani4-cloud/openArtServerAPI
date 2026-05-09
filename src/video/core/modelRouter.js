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

const DEFAULT_VIDEO_DURATION_SECONDS = 5;
const DEFAULT_VIDEO_RESOLUTION_MULTIPLIERS = {
    "480p": 0.8,
    "720p": 1,
    "1080p": 1.6,
};

function normalizeResolutionKey(resolution = "720p") {
    return String(resolution || "720p").trim().toLowerCase();
}

function normalizeDurationSeconds(durationSeconds = DEFAULT_VIDEO_DURATION_SECONDS) {
    const parsed = Number(durationSeconds);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_VIDEO_DURATION_SECONDS;
}

function roundCredits(value) {
    return Math.max(0, Math.ceil(Number(value) || 0));
}

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

function fromRegistry(
    key,
    displayName = null,
    supportsEdit = false,
    supportsCamera = false,
    type = VIDEO_MODEL_TYPES.GENERATED,
    pricing = {},
    isOpen = true,
    isHidden = false,
    overrides = {}
) {
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
        open: isOpen,
        hidden: isHidden,
        supportsEdit,
        supportsCamera,
        pricing: {
            baseCredits: 20,
            perSecondCredits: 4,
            resolutionMultipliers: DEFAULT_VIDEO_RESOLUTION_MULTIPLIERS,
            ...pricing,
        },

        ...overrides,
    };
}

// ── Route Table ───────────────────────────────────────────────────────────────
export const MODEL_ROUTES = {

    // ── Kling v2.6 ───────────────────────────────────────────────────────────
    "kling_v2":      fromRegistry("kling_v2_wavespeed", "Kling v2.6", false, true, VIDEO_MODEL_TYPES.GENERATED, { 
        table: {
            "720p":  { 5: 14, 10: 28 },
            "1080p": { 5: 20, 10: 40 }
        }
    }),
    "kling_v2_pro":  fromRegistry("kling_v2_pro_wavespeed", "Kling v2.6 Pro", false, true, VIDEO_MODEL_TYPES.GENERATED, { 
        table: {
            "720p":  { 5: 35, 10: 70 },
            "1080p": { 5: 50, 10: 100 }
        }
    }),


    // ── Kling v3.0 ───────────────────────────────────────────────────────────
    "kling_v3":     fromRegistry("kling_v3_wavespeed", "Kling v3.0", false, true, VIDEO_MODEL_TYPES.GENERATED, { 
        table: {
            "720p":  { 3: 25, 5: 42, 10: 84, 15: 126 },
            "1080p": { 3: 35, 5: 60, 10: 120, 15: 180 }
        }
    }),
    "kling_v3_pro": fromRegistry("kling_v3_pro_wavespeed", "Kling v3.0 Pro", false, true, VIDEO_MODEL_TYPES.GENERATED, { 
        table: {
            "720p":  { 3: 34, 5: 56, 10: 112, 15: 168 },
            "1080p": { 3: 45, 5: 80, 10: 160, 15: 240 }
        }
    }),

    // ── Kling O3 ─────────────────────────────────────────────────────────────
    "kling_o3":     fromRegistry("kling_o3_wavespeed", "Kling O3", true, true, VIDEO_MODEL_TYPES.GENERATED, { 
        table: {
            "720p":  { 5: 84, 10: 168 },
            "1080p": { 5: 120, 10: 240 }
        }
    }),
    "kling_o3_pro": fromRegistry("kling_o3_pro_wavespeed", "Kling O3 Pro", false, true, VIDEO_MODEL_TYPES.GENERATED, { 
        table: {
            "720p":  { 5: 112, 10: 224 },
            "1080p": { 5: 150, 10: 300 }
        }
    }),


    // ── Seedance v1.5 Pro ───────────────────────────────────────────────────
    "seedance_v15_pro":       fromRegistry("seedance_v15_pro_wavespeed", "Seedance v1.5 Pro", true, false, VIDEO_MODEL_TYPES.GENERATED, { table: { "720p": { 4: 30, 5: 40, 10: 80 }, "1080p": { 4: 40, 5: 55, 10: 110 } } }),
    "seedance_v15_pro_fast":  fromRegistry("seedance_v15_pro_fast_wavespeed", "Seedance v1.5 Pro Fast", false, false, VIDEO_MODEL_TYPES.GENERATED, { table: { "720p": { 4: 30, 5: 40, 10: 80 }, "1080p": { 4: 40, 5: 55, 10: 110 } } }),
    "seedance_v15_pro_spicy": fromRegistry("seedance_v15_pro_spicy_wavespeed", "Seedance v1.5 Pro Spicy", true, false, VIDEO_MODEL_TYPES.GENERATED, { table: { "720p": { 4: 30, 5: 40, 10: 80 }, "1080p": { 4: 40, 5: 55, 10: 110 } } }),

    // ── RunwayML Gen-4 ───────────────────────────────────────────────────────
    "runway_gen4_turbo": fromRegistry("runway_gen4_turbo_wavespeed", "RunwayML Gen-4 Turbo", false, true, VIDEO_MODEL_TYPES.GENERATED, { table: { "720p": { 5: 75, 10: 150 }, "1080p": { 5: 100, 10: 200 } } }),
    "runway_gen4_aleph": fromRegistry("runway_gen4_aleph_wavespeed", "RunwayML Gen-4 Aleph", true, true, VIDEO_MODEL_TYPES.GENERATED, { table: { "720p": { 5: 75, 10: 150 }, "1080p": { 5: 100, 10: 200 } } }),

    // ── Topaz Video Models ───────────────────────────────────────────────────
    "topaz_video_upscale": fromRegistry("topaz_video_upscale_replicate", "Topaz Video Upscale", false, false, VIDEO_MODEL_TYPES.UPSCALE, { baseCredits: 12, perSecondCredits: 3 }, true, true),
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

export function getVideoPricing(modelKey) {
    const route = MODEL_ROUTES[modelKey];
    return route?.pricing || null;
}

export function calculateVideoCredits({
    modelKey,
    durationSeconds = DEFAULT_VIDEO_DURATION_SECONDS,
    resolution = "720p",
    count = 1,
}) {
    const route = MODEL_ROUTES[modelKey];
    if (!route || route.type !== VIDEO_MODEL_TYPES.GENERATED) {
        throw new Error(`Video pricing route not found for model "${modelKey}"`);
    }

    const pricing = route.pricing || {};
    const seconds = normalizeDurationSeconds(durationSeconds);
    const resolutionKey = normalizeResolutionKey(resolution);
    const quantity = Math.max(1, Number(count) || 1);
    
    let credits = 0;
    let baseCredits = 0;
    let perSecondCredits = 0;
    let resolutionMultiplier = 1;

    // ── Exact Table Pricing (e.g. 5s @ 720p = 45 credits) ──
    if (pricing.table && pricing.table[resolutionKey] && pricing.table[resolutionKey][seconds] !== undefined) {
        credits = roundCredits(pricing.table[resolutionKey][seconds] * quantity);
    } 
    // ── Fallback Math Pricing (e.g. base + time * perSecond) ──
    else {
        baseCredits = pricing.baseCredits ?? 20;
        perSecondCredits = pricing.perSecondCredits ?? 4;
        resolutionMultiplier =
            pricing.resolutionMultipliers?.[resolutionKey] ??
            DEFAULT_VIDEO_RESOLUTION_MULTIPLIERS[resolutionKey] ??
            1;

        credits = roundCredits(
            (baseCredits + perSecondCredits * seconds) * resolutionMultiplier * quantity
        );
    }

    return {
        credits,
        pricingVersion: "video-router-v1",
        breakdown: {
            modelKey,
            baseCredits,
            perSecondCredits,
            durationSeconds: seconds,
            resolution: resolutionKey,
            resolutionMultiplier,
            count: quantity,
        },
    };
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
    (key) => MODEL_ROUTES[key].type === VIDEO_MODEL_TYPES.GENERATED
          && MODEL_ROUTES[key].open
          && !MODEL_ROUTES[key].hidden
);

export const UPSCALE_MODELS = Object.keys(MODEL_ROUTES).filter(
    (key) => MODEL_ROUTES[key].type === VIDEO_MODEL_TYPES.UPSCALE
          && MODEL_ROUTES[key].open
          && !MODEL_ROUTES[key].hidden
);

export const AVAILABLE_MODELS = Object.keys(MODEL_ROUTES).filter(
    (key) => MODEL_ROUTES[key].open && !MODEL_ROUTES[key].hidden
);
