import * as nanobana from "./models/nanobana.js";
import { IMAGE_ICONS } from "../../utils/imageIcons.js";

const R_EXTENDED = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];
const Q_1K_4K    = ["1k", "2k", "4k"];

export const MODELS = {

    // ─── Nano Banana ──────────────────────────────────────────────────────────
    "nanobana_google": {
        displayName: "Nano Banana 2.5",
        icon: IMAGE_ICONS.nanobana,
        description: "State-of-the-art native image generation and editing designed for fast, creative workflows.",
        category: "image", tier: "std",
        pricing:  { per_image: 0.039 },
        tags:     ["fast", "gemini-2.5", "google"],
        support:  { ratio: R_EXTENDED, quality: Q_1K_4K, references: { min: 0, max: 0 } },
        t2i:      nanobana.MODELS["google/nanobana"],
    },
    "nanobana_2_0_google": {
        displayName: "Nano Banana 2.0",
        icon: IMAGE_ICONS.nanobana,
        description: "High-speed generation with Gemini 2.0 reasoning and visual intelligence.",
        category: "image", tier: "std",
        pricing:  { per_image: 0.03 },
        tags:     ["fast", "gemini-2.0", "google"],
        support:  { ratio: R_EXTENDED, quality: Q_1K_4K, references: { min: 0, max: 0 } },
        t2i:      nanobana.MODELS["google/nanobana-2.0"],
    },
    "nanobana_2_google": {
        displayName: "Nano Banana 2",
        icon: IMAGE_ICONS.nanobana,
        description: "High-efficiency production-scale visual creation with lightning-fast generation speeds.",
        category: "image", tier: "std",
        pricing:  { per_image: 0.0672 },
        tags:     ["new", "flash", "gemini-3.1", "google"],
        support:  { ratio: R_EXTENDED, quality: Q_1K_4K, references: { min: 0, max: 0 } },
        t2i:      nanobana.MODELS["google/nanobana-2"],
    },
    "nanobana_pro_google": {
        displayName: "Nano Banana Pro",
        icon: IMAGE_ICONS.nanobana,
        description: "Professional design engine for studio-quality 4K visuals, complex layouts, and precise text rendering.",
        category: "image", tier: "pro",
        pricing:  { per_image: 0.134 },
        tags:     ["pro", "gemini-3", "google"],
        support:  { ratio: R_EXTENDED, quality: Q_1K_4K, references: { min: 0, max: 0 } },
        t2i:      nanobana.MODELS["google/nanobana-pro"],
    },

    // ─── Imagen 4 ─────────────────────────────────────────────────────────────
    "imagen_4_google": {
        displayName: "Imagen 4",
        icon: IMAGE_ICONS.google,
        description: "Latest generation model with superior text rendering.",
        category: "image", tier: "pro",
        pricing:  { per_image: 0.04 },
        tags:     ["new", "typography", "hd", "google"],
        support:  { ratio: R_EXTENDED, quality: Q_1K_4K, references: { min: 0, max: 0 } },
        t2i:      nanobana.MODELS["google/imagen-4"],
    },
    "imagen_4_ultra_google": {
        displayName: "Imagen 4 Ultra",
        icon: IMAGE_ICONS.google,
        description: "Highest quality Imagen 4 model with best details.",
        category: "image", tier: "pro",
        pricing:  { per_image: 0.06 },
        tags:     ["ultra", "typography", "hd", "google"],
        support:  { ratio: R_EXTENDED, quality: Q_1K_4K, references: { min: 0, max: 0 } },
        t2i:      nanobana.MODELS["google/imagen-4-ultra"],
    },
    "imagen_4_fast_google": {
        displayName: "Imagen 4 Fast",
        icon: IMAGE_ICONS.google,
        description: "Fastest Imagen 4 model for quick high-quality outputs.",
        category: "image", tier: "std",
        pricing:  { per_image: 0.02 },
        tags:     ["fast", "typography", "google"],
        support:  { ratio: R_EXTENDED, quality: Q_1K_4K, references: { min: 0, max: 0 } },
        t2i:      nanobana.MODELS["google/imagen-4-fast"],
    },
};
