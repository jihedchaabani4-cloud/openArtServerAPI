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

import { MODELS as falModels         } from "#image/runners/fal/registry.js";
import { MODELS as replicateModels   } from "#image/runners/replicate/registry.js";
import { MODELS as googleModels      } from "#image/runners/google/registry.js";

// ── Combined Lookup ───────────────────────────────────────────────────────────
// Flat map of all model keys → ModelGroup across all providers
const ALL_REGISTRY_MODELS = {
    ...wavespeedModels,

    ...falModels,
    ...replicateModels,
    ...googleModels,
};

// ── Route Table ───────────────────────────────────────────────────────────────
export const IMAGE_MODEL_TYPES = {
    GENERATED: "generated",
    UPSCALE:   "upscale",
};

const DEFAULT_IMAGE_QUALITY_MULTIPLIERS = {
    standard: 1,
    hd: 1,
    "1k": 1,
    "2k": 1.5,
    "4k": 2.5,
};

const DEFAULT_UPSCALE_SCALE_MULTIPLIERS = {
    2: 1,
    4: 1.8,
};

function normalizeQualityKey(quality = "standard") {
    return String(quality || "standard").trim().toLowerCase();
}

function normalizeScaleKey(scale = 2) {
    const parsed = Number(scale);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
}

function roundCredits(value) {
    return Math.max(0, Math.ceil(Number(value) || 0));
}

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

function fromRegistry(
    key,
    supportsEdit = false,
    supportsCamera = false,
    type = IMAGE_MODEL_TYPES.GENERATED,
    pricing = {},
    isOpen = true,
    isHidden = false,
    overrides = {}
) {
    const group = ALL_REGISTRY_MODELS[key];
    if (!group) throw new Error(`[imageRouter] Model "${key}" not found in any registry`);
    return {
        t2i:      group.t2i      || null,
        i2i:      group.i2i      || null,
        i2iMulti: group.i2iMulti || null,
        _registryKey: key,
        group,
        type,
        open: isOpen,
        hidden: isHidden,
        supportsEdit,
        supportsCamera,
        pricing: {
            generatedBaseCredits: 10,
            editBaseCredits: 10,
            upscaleBaseCredits: 6,
            qualityMultipliers: DEFAULT_IMAGE_QUALITY_MULTIPLIERS,
            upscaleScaleMultipliers: DEFAULT_UPSCALE_SCALE_MULTIPLIERS,
            ...pricing,
        },
        ...overrides, // override specific variants here
    };
}

export const IMAGE_ROUTES = {

    // ── NanoBanana (wavespeed) ────────────────────────────────────────────────
    "nanobana": fromRegistry("nanobana_wavespeed", false, false, IMAGE_MODEL_TYPES.GENERATED, {
        table: {
            generated: { standard: 8,  hd: 11, "2k": 16, "4k": 26 },
            edit:      { standard: 9,  hd: 12, "2k": 18, "4k": 30 },
        }
    }),
    "nanobana2": fromRegistry("nanobana2_wavespeed", false, false, IMAGE_MODEL_TYPES.GENERATED, {
        table: {
            generated: { standard: 9,  hd: 12, "2k": 18, "4k": 28 },
            edit:      { standard: 10, hd: 14, "2k": 20, "4k": 32 },
        }
    }),
    "nanobana_pro": fromRegistry("nanobana_pro_wavespeed", true, false, IMAGE_MODEL_TYPES.GENERATED, {
        table: {
            generated: { standard: 12, hd: 16, "2k": 24, "4k": 40 },
            edit:      { standard: 14, hd: 18, "2k": 28, "4k": 46 },
        }
    }),

    // ── Nano Banana (google native) ───────────────────────────────────────────
    // "nanobana_2_0_google": fromRegistry("nanobana_2_0_google"),
    // "nanobana_2_5_google": fromRegistry("nanobana_google"),
    // "nanobana_2_google":   fromRegistry("nanobana_2_google"),
    // "nanobana_pro_google": fromRegistry("nanobana_pro_google"),

    // ── Imagen 4 (google native) ─────────────────────────────────────────────
    "imagen_4": fromRegistry("imagen_4_google", false, false, IMAGE_MODEL_TYPES.GENERATED, {
        table: {
            generated: { standard: 11, hd: 15, "2k": 22, "4k": 36 },
            edit:      { standard: 12, hd: 16, "2k": 24, "4k": 40 },
        }
    }),
    "imagen_4_ultra": fromRegistry("imagen_4_ultra_google", true, false, IMAGE_MODEL_TYPES.GENERATED, {
        table: {
            generated: { standard: 15, hd: 20, "2k": 30, "4k": 50 },
            edit:      { standard: 17, hd: 23, "2k": 34, "4k": 56 },
        }
    }),
    "imagen_4_fast": fromRegistry("imagen_4_fast_google", false, false, IMAGE_MODEL_TYPES.GENERATED, {
        table: {
            generated: { standard: 8,  hd: 10, "2k": 14, "4k": 22 },
            edit:      { standard: 9,  hd: 11, "2k": 16, "4k": 26 },
        }
    }),

    // ── SeaDream (wavespeed) ──────────────────────────────────────────────────
    "seedream-standard": fromRegistry("seedream_standard_wavespeed", false, false, IMAGE_MODEL_TYPES.GENERATED, {
        table: {
            generated: { standard: 9,  hd: 12, "2k": 18, "4k": 30 },
            edit:      { standard: 10, hd: 14, "2k": 20, "4k": 34 },
        }
    }),
    "seedream-pro": fromRegistry("seedream_pro_wavespeed", false, false, IMAGE_MODEL_TYPES.GENERATED, {
        table: {
            generated: { standard: 12, hd: 16, "2k": 24, "4k": 40 },
            edit:      { standard: 14, hd: 18, "2k": 28, "4k": 46 },
        }
    }),

    // ── Z-Image (wavespeed) ───────────────────────────────────────────────────
    "z_image": fromRegistry("z_image_wavespeed", false, false, IMAGE_MODEL_TYPES.GENERATED, {
        table: {
            generated: { standard: 10, hd: 14, "2k": 20, "4k": 34 },
            edit:      { standard: 12, hd: 16, "2k": 24, "4k": 38 },
        }
    }),
    "z_image_base": fromRegistry("z_image_base_wavespeed", false, false, IMAGE_MODEL_TYPES.GENERATED, {
        table: {
            generated: { standard: 7,  hd: 9,  "2k": 14, "4k": 22 },
            edit:      { standard: 8,  hd: 10, "2k": 16, "4k": 26 },
        }
    }),

    // ── GPT Image 2 (wavespeed) ───────────────────────────────────────────────
    "gpt-image-2": fromRegistry("gpt_image_2_wavespeed", true, false, IMAGE_MODEL_TYPES.GENERATED, {
        table: {
            generated: { standard: 12, hd: 15, "2k": 18, "4k": 22 },
            edit:      { standard: 12, hd: 15, "2k": 18, "4k": 22 },
        }
    }),

    // ── RunwayML (wavespeed) ─────────────────────────────────────────────────
    "runway_gen4_image": fromRegistry("runway_gen4_image_wavespeed", true, true, IMAGE_MODEL_TYPES.GENERATED, {
        table: {
            generated: { standard: 14, hd: 18, "2k": 28, "4k": 46 },
            edit:      { standard: 16, hd: 21, "2k": 32, "4k": 52 },
        }
    }),
    "runway_gen4_image_turbo": fromRegistry("runway_gen4_image_turbo_wavespeed", false, true, IMAGE_MODEL_TYPES.GENERATED, {
        table: {
            generated: { standard: 11, hd: 14, "2k": 20, "4k": 34 },
            edit:      { standard: 13, hd: 16, "2k": 24, "4k": 38 },
        }
    }),

    // ── Topaz (replicate) ───────────────────────────────────────────────────
    "topaz_image_upscale": fromRegistry(
        "topaz_image_upscale",
        false,
        false,
        IMAGE_MODEL_TYPES.UPSCALE,
        { upscaleBaseCredits: 6, upscaleScaleMultipliers: { 2: 1, 4: 1.8, 6: 2.4 } },
        true,  // isOpen
        true   // isHidden — backend-only, never shown to users
    ),
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

export function getImagePricing(modelKey) {
    const route = IMAGE_ROUTES[modelKey];
    return route?.pricing || null;
}

export function calculateImageCredits({
    modelKey,
    quality = "standard",
    count = 1,
    operation = "generated",
}) {
    const route = getImageModel(modelKey);
    if (!route) {
        throw new Error(`Image pricing route not found for model "${modelKey}"`);
    }

    const pricing = route.pricing || {};
    const qualityKey = normalizeQualityKey(quality);
    const quantity = Math.max(1, Number(count) || 1);
    const op = operation === "edit" ? "edit" : "generated";

    let credits = 0;
    let baseCredits = 0;
    let qualityMultiplier = 1;

    // ── Exact Table Pricing (e.g. generated @ standard = 8 credits) ──
    if (pricing.table && pricing.table[op] && pricing.table[op][qualityKey] !== undefined) {
        credits = roundCredits(pricing.table[op][qualityKey] * quantity);
    }
    // ── Fallback Math Pricing ──
    else {
        baseCredits = op === "edit" ? pricing.editBaseCredits : pricing.generatedBaseCredits;
        qualityMultiplier =
            pricing.qualityMultipliers?.[qualityKey] ??
            DEFAULT_IMAGE_QUALITY_MULTIPLIERS[qualityKey] ??
            1;
        credits = roundCredits(baseCredits * qualityMultiplier * quantity);
    }

    return {
        credits,
        pricingVersion: "image-router-v1",
        breakdown: {
            modelKey,
            operation,
            baseCredits,
            quality: qualityKey,
            qualityMultiplier,
            count: quantity,
        },
    };
}

export function calculateUpscaleCredits({
    modelKey,
    upscaleScale = 2,
}) {
    const route = getUpscaleModel(modelKey);
    if (!route) {
        throw new Error(`Upscale pricing route not found for model "${modelKey}"`);
    }

    const pricing = route.pricing || {};
    const scaleKey = normalizeScaleKey(upscaleScale);
    const baseCredits = pricing.upscaleBaseCredits ?? 6;
    const scaleMultiplier =
        pricing.upscaleScaleMultipliers?.[scaleKey] ??
        DEFAULT_UPSCALE_SCALE_MULTIPLIERS[scaleKey] ??
        1;
    const credits = roundCredits(baseCredits * scaleMultiplier);

    return {
        credits,
        pricingVersion: "image-router-v1",
        breakdown: {
            modelKey,
            operation: "upscale",
            baseCredits,
            upscaleScale: scaleKey,
            scaleMultiplier,
        },
    };
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
