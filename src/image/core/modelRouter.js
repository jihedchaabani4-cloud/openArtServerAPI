/**
 * ─── Image Model Dispatch Router ───────────────────────────────────────────────
 *
 * Builds its route table DIRECTLY from the per-runner registries.
 * Each ModelGroup in a registry already declares its own t2i / i2i / i2iMulti
 * runner instances — so the router just reads them.
 *
 * To swap a variant to a different provider:
 *   1. Create the runner in  runners/<provider>/models/<model>.js
 *   2. Add / override its ModelGroup in   runners/<provider>/registry.js
 *   3. Change the registry import for that key below (or override after build)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Per-Runner Registry Imports ───────────────────────────────────────────────
import { MODELS as wavespeedModels  } from "#image/runners/wavespeed/registry.js";
import { MODELS as sdxlModels       } from "#image/runners/sdxl/registry.js";
import { MODELS as falModels         } from "#image/runners/fal/registry.js";
import { MODELS as replicateModels   } from "#image/runners/replicate/registry.js";
import { MODELS as googleModels      } from "#image/runners/google/registry.js";

// ── Combined Lookup ───────────────────────────────────────────────────────────
// Flat map of all model keys → ModelGroup across all providers
const ALL_REGISTRY_MODELS = {
    ...wavespeedModels,
    ...sdxlModels,
    ...falModels,
    ...replicateModels,
    ...googleModels,
};

// ── Route Table ───────────────────────────────────────────────────────────────
export const IMAGE_MODEL_TYPES = {
    GENERATED: "generated",
    UPSCALE:   "upscale",
};

/**
 * IMAGE_ROUTES:
 *   [public_model_key]: {
 *       t2i:      runner,     ← from the ModelGroup's .t2i
 *       i2i:      runner,     ← from the ModelGroup's .i2i
 *       i2iMulti: runner,     ← from the ModelGroup's .i2iMulti
 *       group:    ModelGroup, ← used for .resolve() + .toMeta()
 *       type:     string      ← "generated" | "upscale"
 *   }
 *
 * Default: pulled directly from per-runner registry.
 * To override a single variant: add an explicit entry below.
 */

function fromRegistry(key, supportsEdit = false, supportsCamera = false, type = IMAGE_MODEL_TYPES.GENERATED, overrides = {}) {
    const group = ALL_REGISTRY_MODELS[key];
    if (!group) throw new Error(`[imageRouter] Model "${key}" not found in any registry`);
    return {
        t2i:      group.t2i      || null,
        i2i:      group.i2i      || null,
        i2iMulti: group.i2iMulti || null,
        _registryKey: key,
        group,
        type,
        open: true,
        supportsEdit,
        supportsCamera,
        ...overrides, // override specific variants here
    };
}

export const IMAGE_ROUTES = {

    // ── NanoBanana (wavespeed) ────────────────────────────────────────────────
    "nanobana":     fromRegistry("nanobana_wavespeed"),
    "nanobana2":    fromRegistry("nanobana2_wavespeed"),
    "nanobana_pro": fromRegistry("nanobana_pro_wavespeed", true),

    // ── Nano Banana (google native) ───────────────────────────────────────────
    // "nanobana_2_0_google": fromRegistry("nanobana_2_0_google"),
    // "nanobana_2_5_google": fromRegistry("nanobana_google"),
    // "nanobana_2_google":   fromRegistry("nanobana_2_google"),
    // "nanobana_pro_google": fromRegistry("nanobana_pro_google"),

    // ── Imagen 4 (google native) ─────────────────────────────────────────────
    "imagen_4":       fromRegistry("imagen_4_google"),
    "imagen_4_ultra": fromRegistry("imagen_4_ultra_google", true),
    "imagen_4_fast":  fromRegistry("imagen_4_fast_google"),

    // ── SeaDream (wavespeed) ──────────────────────────────────────────────────
    "seedream-standard": fromRegistry("seedream_standard_wavespeed"),
    "seedream-pro":      fromRegistry("seedream_pro_wavespeed"),

    // ── Z-Image (wavespeed) ───────────────────────────────────────────────────
    "z_image":      fromRegistry("z_image_wavespeed"),
    "z_image_base": fromRegistry("z_image_base_wavespeed"),

    // ── SDXL (local) ─────────────────────────────────────────────────────────
    "sdxl": fromRegistry("sdxl_sdxl"),



    // ── RunwayML (wavespeed) ─────────────────────────────────────────────────
    "runway_gen4_image":       fromRegistry("runway_gen4_image_wavespeed", true, true),
    "runway_gen4_image_turbo": fromRegistry("runway_gen4_image_turbo_wavespeed", false, true),

    // ── Topaz (replicate) ───────────────────────────────────────────────────
    "topaz_image_upscale": fromRegistry("topaz_image_upscale", false, IMAGE_MODEL_TYPES.UPSCALE),
};


// ── Resolver ──────────────────────────────────────────────────────────────────
/**
 * getImageRunner(modelKey, variant)
 *   Returns a specific runner for the given model key + variant.
 *   Variant: "t2i" | "i2i" | "i2iMulti"
 */
export function getImageRunner(modelKey, variant) {
    const route = IMAGE_ROUTES[modelKey];
    if (!route) return null;
    return route[variant] || null;
}

/**
 * getImageModel(modelKey)
 *   Returns the full route object { t2i, i2i, i2iMulti, group } ONLY if it's a GENERATED model.
 *   Used by ImageTreatment.
 */
export function getImageModel(modelKey) {
    const route = IMAGE_ROUTES[modelKey];
    if (route && route.type === IMAGE_MODEL_TYPES.GENERATED) {
        return route;
    }
    return null;
}

/**
 * getUpscaleModel(modelKey)
 *   Returns the full route object ONLY if it's an UPSCALE model.
 */
export function getUpscaleModel(modelKey) {
    const route = IMAGE_ROUTES[modelKey];
    if (route && route.type === IMAGE_MODEL_TYPES.UPSCALE) {
        return route;
    }
    return null;
}

/**
 * Lists of keys by type
 */
export const ROUTED_IMAGE_MODELS = Object.keys(IMAGE_ROUTES).filter(
    (key) => IMAGE_ROUTES[key].type === IMAGE_MODEL_TYPES.GENERATED
);

export const UPSCALE_IMAGE_MODELS = Object.keys(IMAGE_ROUTES).filter(
    (key) => IMAGE_ROUTES[key].type === IMAGE_MODEL_TYPES.UPSCALE
);
