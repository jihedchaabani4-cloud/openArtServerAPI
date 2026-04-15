/**
 * ─── Wavespeed Image Registry ─────────────────────────────────────────────────
 * Keys use the format: <model>_wavespeed
 * This makes it clear which provider handles each model.
 * imageRouter.js maps public model keys → these internal keys.
 */

import * as nanobana from "./models/nanobana.js";
import * as seedream from "./models/seedream.js";
import * as zImage   from "./models/z-image.js";
import * as flux     from "./models/flux.js";
import * as runway   from "./models/runway.js";
import { IMAGE_ICONS } from "../../utils/imageIcons.js";

const R_BASIC    = ["1:1", "16:9", "9:16"];
const R_EXTENDED = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];
const Q_1K_4K    = ["1k", "2k", "4k"];
const Q_2K_4K    = ["2k", "4k"];

export const MODELS = {

    // ─── NanoBanana ──────────────────────────────────────────────────────────
    "nanobana_wavespeed": {
        displayName: "NanoBanana",
        icon: IMAGE_ICONS.nanobana,
        description: "Fast affordable image generation and editing",
        category: "image", tier: "std",
        pricing:  { per_image: 0.05 },
        tags:     ["fast", "affordable"],
        support:  { ratio: R_EXTENDED, quality: Q_1K_4K, references: { min: 0, max: 8 } },
        t2i:      nanobana.normal,    // google/nano-banana/text-to-image
        i2i:      nanobana.edit,      // google/nano-banana/edit
    },
    "nanobana2_wavespeed": {
        displayName: "NanoBanana 2",
        icon: IMAGE_ICONS.nanobana,
        description: "Pro-level quality at Flash speed — up to 14 references",
        category: "image", tier: "std",
        pricing:  { per_image: 0.07 },
        tags:     ["fast", "4k", "multi-ref", "web-search"],
        support:  { ratio: R_EXTENDED, quality: Q_1K_4K, references: { min: 0, max: 14 } },
        t2i:      nanobana.nb2T2i,    // google/nano-banana-2/text-to-image
        i2i:      nanobana.nb2Edit,   // google/nano-banana-2/edit
        i2iMulti: nanobana.nb2Edit,
    },
    "nanobana_pro_wavespeed": {
        displayName: "NanoBanana Pro",
        icon: IMAGE_ICONS.nanobana,
        description: "Maximum quality — 4K, advanced reasoning, typography",
        category: "image", tier: "pro",
        pricing:  { per_image: 0.14 },
        tags:     ["pro", "4k", "typography", "character-consistency"],
        support:  { ratio: R_EXTENDED, quality: Q_1K_4K, references: { min: 0, max: 8 } },
        t2i:      nanobana.pro,       // google/nano-banana-pro/text-to-image
        i2i:      nanobana.proEdit,   // google/nano-banana-pro/edit
    },

    // ─── SeaDream ─────────────────────────────────────────────────────────────
    "seedream_standard_wavespeed": {
        displayName: "SeaDream 5.0 Lite",
        icon: IMAGE_ICONS.seedream,
        description: "High quality creative image with strong typography",
        category: "image", tier: "std",
        pricing:  { per_image: 0.04 },
        tags:     ["creative", "typography"],
        support:  { ratio: R_BASIC, quality: Q_1K_4K, references: { min: 0, max: 10 } },
        t2i:      seedream.standard,  // bytedance/seedream-v5.0-lite
        i2i:      seedream.edit,      // bytedance/seedream-v5.0-lite/edit
    },
    "seedream_pro_wavespeed": {
        displayName: "SeaDream 5.0 Edit",
        icon: IMAGE_ICONS.seedream,
        description: "Premium 4K with advanced typography and prompt adherence",
        category: "image", tier: "pro",
        pricing:  { per_image: 0.07 },
        tags:     ["pro", "4k", "typography"],
        support:  { ratio: R_BASIC, quality: Q_2K_4K, references: { min: 0, max: 10 } },
        t2i:      seedream.pro,       // bytedance/seedream-v4.5
        i2i:      seedream.proEdit,   // bytedance/seedream-v4.5/edit
    },

    // ─── Z-Image ──────────────────────────────────────────────────────────────
    "z_image_wavespeed": {
        displayName: "Z-Image",
        icon: IMAGE_ICONS.zimage,
        description: "Ultra-fast bilingual image generation (EN/ZH)",
        category: "image", tier: "std",
        pricing:  { per_image: 0.05 },
        tags:     ["fast", "realistic"],
        support:  { ratio: R_BASIC, quality: Q_1K_4K, references: { min: 0, max: 1 } },
        t2i:      zImage.turbo,
        i2i:      zImage.img2img,
    },
    "z_image_base_wavespeed": {
        displayName: "Z-Image Base",
        icon: IMAGE_ICONS.zimage,
        description: "Balanced speed and quality",
        category: "image", tier: "std",
        pricing:  { per_image: 0.10 },
        tags:     ["balanced", "hd"],
        support:  { ratio: R_BASIC, quality: Q_1K_4K, references: { min: 0, max: 0 } },
        t2i:      zImage.base,
        i2i:      zImage.img2img,
    },

    // ─── Flux 2 ───────────────────────────────────────────────────────────────
    "flux_turbo_wavespeed": {
        displayName: "Flux 2 Turbo",
        icon: IMAGE_ICONS.flux,
        description: "Real-time photoreal generation — ultra-fast",
        category: "image", tier: "std",
        pricing:  { per_image: 0.02 },
        tags:     ["ultra-fast", "real-time", "photoreal"],
        support:  { ratio: R_BASIC, references: { min: 0, max: 3 } },
        t2i:      flux.turboT2i,      // wavespeed-ai/flux-2-turbo/text-to-image
        i2i:      flux.turboEdit,     // wavespeed-ai/flux-2-turbo/edit
        i2iMulti: flux.turboEdit,
    },
    "flux_flex_wavespeed": {
        displayName: "Flux 2 Flex",
        icon: IMAGE_ICONS.flux,
        description: "Best price-to-performance — versatile creative range",
        category: "image", tier: "std",
        pricing:  { per_image: 0.03 },
        tags:     ["creative", "versatile", "best-value"],
        support:  { ratio: R_BASIC, references: { min: 0, max: 3 } },
        t2i:      flux.flexT2i,
        i2i:      flux.flexEdit,
        i2iMulti: flux.flexEdit,
    },
    "flux_max_wavespeed": {
        displayName: "Flux 2 Max",
        icon: IMAGE_ICONS.flux,
        description: "Highest quality Flux — hero assets, client-facing content",
        category: "image", tier: "pro",
        pricing:  { per_image: 0.08 },
        tags:     ["pro", "max-quality", "cinematic"],
        support:  { ratio: R_BASIC, references: { min: 0, max: 3 } },
        t2i:      flux.maxT2i,
        i2i:      flux.maxEdit,       // ← swap to replicate: flux_max_replicate.i2i
        i2iMulti: flux.maxEdit,
    },
    "flux_kontext_max_wavespeed": {
        displayName: "Flux Kontext Max",
        icon: IMAGE_ICONS.flux,
        description: "12B — max prompt adherence, typography, character consistency",
        category: "image", tier: "pro",
        pricing:  { per_image: 0.08 },
        tags:     ["pro", "kontext", "multi-ref", "cinematic"],
        support:  { ratio: R_BASIC, references: { min: 0, max: 5 } },
        t2i:      flux.kontextMaxT2i,
        i2i:      flux.kontextMaxEdit,
        i2iMulti: flux.kontextMaxMulti,
    },
    "flux_pro_wavespeed": {
        displayName: "Flux 2 Pro",
        icon: IMAGE_ICONS.flux,
        description: "Flagship production model — just prompt, no tuning needed",
        category: "image", tier: "pro",
        pricing:  { per_image: 0.05 },
        tags:     ["pro", "production", "campaign-ready"],
        support:  { ratio: R_BASIC, references: { min: 0, max: 3 } },
        t2i:      flux.proT2i,
        i2i:      flux.proEdit,
        i2iMulti: flux.proEdit,
    },

    // ─── RunwayML ─────────────────────────────────────────────────────────────
    "runway_gen4_image_wavespeed": {
        displayName: "RunwayML Gen-4 Image",
        icon: IMAGE_ICONS.runway || IMAGE_ICONS.nanobana,
        description: "Precise images using up to 3 reference images",
        category: "image", tier: "pro",
        pricing:  { per_image: 0.08 },
        tags:     ["runwayml", "gen-4", "professional"],
        support:  { 
            ratio: ["1:1", "16:9", "9:16", "4:3", "3:4"], 
            quality: ["1k", "2k"],
            references: { min: 0, max: 3 } 
        },
        t2i:      runway.gen4Image,
        i2i:      runway.gen4Image,
    },
    "runway_gen4_image_turbo_wavespeed": {
        displayName: "RunwayML Gen-4 Image Turbo",
        icon: IMAGE_ICONS.runway || IMAGE_ICONS.nanobana,
        description: "2.5x faster than Gen-4 Image with high fidelity",
        category: "image", tier: "pro",
        pricing:  { per_image: 0.05 },
        tags:     ["runwayml", "gen-4", "fast", "turbo"],
        support:  { 
            ratio: ["1:1", "16:9", "9:16", "4:3", "3:4"], 
            quality: ["1k", "2k"],
            references: { min: 0, max: 3 } 
        },
        t2i:      runway.gen4ImageTurbo,
        i2i:      runway.gen4ImageTurbo,
    },
};
