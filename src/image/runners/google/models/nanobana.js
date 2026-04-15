import { GoogleImageRunner } from "../GoogleImageRunner.js";
import { CAPS               } from "#core/capabilities.js";

// ═══════════════════════════════════════════════════════════════════════════
// NANO BANANA 2 (Gemini 3.1 Flash Image Preview)
// ═══════════════════════════════════════════════════════════════════════════
class Nanobana2 extends GoogleImageRunner {
    constructor() {
        super({
            modelName:      "gemini-3.1-flash-image-preview",
            provider:       "google",
            type:           "t2i",
            maxReferences:  0,
            capabilities:   [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName:    "Nano Banana 2",
            description:    "Pro-level visual intelligence with Flash-speed efficiency and reality-grounded generation capabilities.",
            category:       "image",
            tier:           "std",
            tags:           ["new", "flash", "gemini-3.1"],
            pricing:        { per_image: 0.0672 },
            modes:          ["t2i"],
        });
    }
    adapt(form) {
        return {
            prompt:         form.prompt,
            aspect_ratio:    form.aspectRatio || form.ratio || "1:1",
            resolution:     form.quality || form.resolution || "1k",
            negative_prompt: form.negativePrompt,
            output_format:   "image/png",
        };
    }
    toPayload(adapted) { return adapted; }
}

// ═══════════════════════════════════════════════════════════════════════════
// NANO BANANA PRO (Gemini 3 Pro Image Preview)
// ═══════════════════════════════════════════════════════════════════════════
class NanobanaPro extends GoogleImageRunner {
    constructor() {
        super({
            modelName:      "gemini-3-pro-image-preview",
            provider:       "google",
            type:           "t2i",
            maxReferences:  0,
            capabilities:   [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName:    "Nano Banana Pro",
            description:    "State-of-the-art image generation and editing model.",
            category:       "image",
            tier:           "pro",
            tags:           ["pro", "gemini-3"],
            pricing:        { per_image: 0.134 },
            modes:          ["t2i"],
        });
    }
    adapt(form) {
        return {
            prompt:         form.prompt,
            aspect_ratio:    form.aspectRatio || form.ratio || "1:1",
            resolution:     form.quality || form.resolution || "1k",
            negative_prompt: form.negativePrompt,
            output_format:   "image/png",
        };
    }
    toPayload(adapted) { return adapted; }
}

// ═══════════════════════════════════════════════════════════════════════════
// NANO BANANA (Gemini 2.5 Flash Image)
// ═══════════════════════════════════════════════════════════════════════════
class Nanobana extends GoogleImageRunner {
    constructor() {
        super({
            modelName:      "gemini-2.5-flash-image",
            provider:       "google",
            type:           "t2i",
            maxReferences:  0,
            capabilities:   [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName:    "Nano Banana",
            description:    "Our state-of-the-art image generation and editing model.",
            category:       "image",
            tier:           "std",
            tags:           ["fast", "gemini-2.5"],
            pricing:        { per_image: 0.039 },
            modes:          ["t2i"],
        });
    }
    adapt(form) {
        return {
            prompt:         form.prompt,
            aspect_ratio:    form.aspectRatio || form.ratio || "1:1",
            resolution:     form.quality || form.resolution || "1k",
            negative_prompt: form.negativePrompt,
            output_format:   "image/png",
        };
    }
    toPayload(adapted) { return adapted; }
}

// ═══════════════════════════════════════════════════════════════════════════
// IMAGEN 4 (Gemini 3 Pro Image Preview)
// ═══════════════════════════════════════════════════════════════════════════
class Imagen4 extends GoogleImageRunner {
    constructor() {
        super({
            modelName:      "gemini-3-pro-image-preview",
            provider:       "google",
            type:           "t2i",
            maxReferences:  0,
            capabilities:   [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE, "typography"],
            displayName:    "Imagen 4",
            description:    "Our latest image generation model, with significantly better text rendering and better overall image quality.",
            category:       "image",
            tier:           "pro",
            tags:           ["new", "typography", "hd", "gemini-3"],
            pricing:        { per_image: 0.04 },
            modes:          ["t2i"],
        });
    }
    adapt(form) {
        return {
            prompt:         form.prompt,
            aspect_ratio:    form.aspectRatio || form.ratio || "1:1",
            resolution:     form.quality || form.resolution || "1k",
            negative_prompt: form.negativePrompt,
            output_format:   "image/png",
        };
    }
    toPayload(adapted) { return adapted; }
}

// ═══════════════════════════════════════════════════════════════════════════
// IMAGEN 4 ULTRA (Gemini 3 Pro Image Preview)
// ═══════════════════════════════════════════════════════════════════════════
class Imagen4Ultra extends GoogleImageRunner {
    constructor() {
        super({
            modelName:      "gemini-3-pro-image-preview",
            provider:       "google",
            type:           "t2i",
            maxReferences:  0,
            capabilities:   [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE, "typography"],
            displayName:    "Imagen 4 Ultra",
            description:    "Our latest image generation model, with significantly better text rendering and better overall image quality.",
            category:       "image",
            tier:           "pro",
            tags:           ["ultra", "typography", "hd", "gemini-3"],
            pricing:        { per_image: 0.06 },
            modes:          ["t2i"],
        });
    }
    adapt(form) {
        return {
            prompt:         form.prompt,
            aspect_ratio:    form.aspectRatio || form.ratio || "1:1",
            resolution:     form.quality || form.resolution || "1k",
            negative_prompt: form.negativePrompt,
            output_format:   "image/png",
        };
    }
    toPayload(adapted) { return adapted; }
}

// ═══════════════════════════════════════════════════════════════════════════
// IMAGEN 4 FAST (Gemini 3.1 Flash Image Preview)
// ═══════════════════════════════════════════════════════════════════════════
class Imagen4Fast extends GoogleImageRunner {
    constructor() {
        super({
            modelName:      "gemini-3.1-flash-image-preview",
            provider:       "google",
            type:           "t2i",
            maxReferences:  0,
            capabilities:   [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE, "typography"],
            displayName:    "Imagen 4 Fast",
            description:    "Our latest image generation model, with significantly better text rendering and better overall image quality.",
            category:       "image",
            tier:           "std",
            tags:           ["fast", "typography", "gemini-3.1"],
            pricing:        { per_image: 0.02 },
            modes:          ["t2i"],
        });
    }
    adapt(form) {
        return {
            prompt:         form.prompt,
            aspect_ratio:    form.aspectRatio || form.ratio || "1:1",
            resolution:     form.quality || form.resolution || "1k",
            negative_prompt: form.negativePrompt,
            output_format:   "image/png",
        };
    }
    toPayload(adapted) { return adapted; }
}

// ═══════════════════════════════════════════════════════════════════════════
// NANO BANANA 2.0 (Gemini 2.0 Flash)
// ═══════════════════════════════════════════════════════════════════════════
class Nanobana2_0 extends GoogleImageRunner {
    constructor() {
        super({
            modelName:      "gemini-2.0-flash",
            provider:       "google",
            type:           "t2i",
            maxReferences:  0,
            capabilities:   [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName:    "Nano Banana 2.0",
            description:    "High-speed generation with Gemini 2.0 reasoning and visual intelligence.",
            category:       "image",
            tier:           "std",
            tags:           ["fast", "gemini-2.0"],
            pricing:        { per_image: 0.03 },
            modes:          ["t2i"],
        });
    }
    adapt(form) {
        return {
            prompt:         form.prompt,
            aspect_ratio:    form.aspectRatio || form.ratio || "1:1",
            resolution:     form.quality || form.resolution || "1k",
            negative_prompt: form.negativePrompt,
            output_format:   "image/png",
        };
    }
    toPayload(adapted) { return adapted; }
}

export const MODELS = {
    "google/nanobana-2":     new Nanobana2(),
    "google/nanobana-2.0":   new Nanobana2_0(),
    "google/nanobana-pro":   new NanobanaPro(),
    "google/nanobana":       new Nanobana(),
    "google/imagen-4":       new Imagen4(),
    "google/imagen-4-ultra": new Imagen4Ultra(),
    "google/imagen-4-fast":  new Imagen4Fast(),
};
