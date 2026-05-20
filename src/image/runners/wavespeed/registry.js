/**
 * ─── Wavespeed Image Registry ─────────────────────────────────────────────────
 * Keys use the format: <model>_wavespeed
 * This makes it clear which provider handles each model.
 * imageRouter.js maps public model keys → these internal keys.
 */

import * as nanobana from "./models/nanobana.js";
import * as seedream from "./models/seedream.js";
import * as zImage   from "./models/z-image.js";
import * as runway   from "./models/runway.js";
import * as gptImage from "./models/gpt-image-2.js";
import * as minimax  from "./models/minimax.js";
import * as pruna    from "./models/pruna-ai.js";
import { IMAGE_ICONS } from "../../utils/imageIcons.js";

const R_BASIC    = ["1:1", "16:9", "9:16", "3:2", "3:4"];
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

    // ─── GPT Image 2 ──────────────────────────────────────────────────────────
    "gpt_image_2_wavespeed": {
        displayName: "GPT Image 2",
        icon: IMAGE_ICONS.gpt,
        description: "High-quality text-to-image and editing powered by GPT Image 2",
        category: "image", tier: "pro",
        pricing:  { per_image: 13 },
        tags:     ["gpt", "creative", "high-quality"],
        support:  { 
            ratio: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"], 
            quality: ["1k", "2k"],
            references: { min: 0, max: 5 } 
        },
        t2i:      gptImage.t2i,
        i2i:      gptImage.edit,
    },

    // ─── Minimax ──────────────────────────────────────────────────────────────
    "minimax_wavespeed": {
        displayName: "Minimax Image-01",
        icon: IMAGE_ICONS.minimax,
        description: "High quality text-to-image and editing by Minimax",
        category: "image", tier: "pro",
        pricing:  { per_image: 0.10 },
        tags:     ["pro", "minimax", "photoreal"],
        support:  { 
            ratio: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"], 
            quality: ["1k", "2k", "4k"], 
            references: { min: 0, max: 1 } 
        },
        t2i:      minimax.t2i,
        i2i:      minimax.img2img,
    },

    // ─── Pruna AI ─────────────────────────────────────────────────────────────
    "pruna_ai_wavespeed": {
        displayName: "Pruna AI Image",
        icon: IMAGE_ICONS.nanobana || "",
        description: "High-quality text-to-image and editing powered by Pruna AI",
        category: "image", tier: "pro",
        pricing:  { per_image: 0.10 },
        tags:     ["pruna", "creative", "high-quality"],
        support:  { 
            ratio: ["match_input_image", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"], 
            quality: ["1k", "2k"],
            references: { min: 0, max: 5 } 
        },
        t2i:      pruna.t2i,
        i2i:      pruna.edit,
    },
};
