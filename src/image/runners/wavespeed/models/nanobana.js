import { WavespeedImageRunner } from "../WavespeedImageRunner.js";
import { CAPS                 } from "#core/capabilities.js";

// ═══════════════════════════════════════════════════════════════════════════
// NANO BANANA (Original — Gemini 2.5 Flash Image)
// Fast, affordable, lightweight edits
// ═══════════════════════════════════════════════════════════════════════════

class NanobanaNormal extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:      "google/nano-banana/text-to-image",
            provider:       "wavespeed",
            type:           "t2i",
            maxReferences:  0,
            capabilities:   [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName:    "NanoBanana",
            category:       "image",
            tier:           "std",
            tags:           ["fast", "creative", "affordable"],
            pricing:        { image: 5 },
            modes:          ["t2i"],
        });
    }

    adapt(form) {
        return {
            prompt:         form.prompt,
            aspectRatio:    form.aspectRatio || form.ratio || "1:1",
            resolution:     form.quality || form.resolution || "1k",
            negativePrompt: form.negativePrompt,
            outputFormat:   "png",
        };
    }

    toPayload({ prompt, aspectRatio, resolution, negativePrompt, outputFormat }) {
        return {
            prompt,
            aspect_ratio:    aspectRatio || "1:1",
            resolution:      String(resolution  || "1k").toLowerCase(),
            negative_prompt: negativePrompt || "",
            output_format:   outputFormat   || "png",
        };
    }
}

class NanobanaEdit extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:     "google/nano-banana/edit",
            provider:      "wavespeed",
            type:          "i2i",
            maxReferences: 8,
            capabilities:  [CAPS.TEXT, CAPS.MULTI_IMAGE, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName:   "NanoBanana Edit",
            category:      "image",
            tier:          "std",
            tags:          ["fast", "edit"],
            pricing:       { image: 7 },
            modes:         ["i2i"],
            hidden:        true,
        });
    }

    adapt(form) {
        const refs = form.references || [];
        return {
            prompt:         form.prompt,
            images:         refs.map(r => r.url || r).filter(Boolean),
            aspectRatio:    form.aspectRatio || form.ratio || "1:1",
            resolution:     form.quality || form.resolution || "1k",
            negativePrompt: form.negativePrompt,
            outputFormat:   "png",
        };
    }

    toPayload({ prompt, images, aspectRatio, resolution, negativePrompt, outputFormat }) {
        return {
            prompt,
            images,
            aspect_ratio:    aspectRatio || "1:1",
            resolution:      String(resolution  || "1k").toLowerCase(),
            negative_prompt: negativePrompt || "",
            output_format:   outputFormat   || "png",
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// NANO BANANA 2 (Gemini 3.1 Flash Image)
// Pro-level quality at Flash speed
// Ratios: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9
// Max references: 14
// Pricing: 1K=$0.07, 2K=$0.105, 4K=$0.14
// ═══════════════════════════════════════════════════════════════════════════

class Nanobana2T2i extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:     "google/nano-banana-2/text-to-image",
            provider:      "wavespeed",
            type:          "t2i",
            maxReferences: 0,
            capabilities:  [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName:   "NanoBanana 2",
            category:      "image",
            tier:          "std",
            tags:          ["fast", "4k", "creative", "web-search"],
            pricing:       { image: 7 },
            modes:         ["t2i"],
        });
    }

    adapt(form) {
        return {
            prompt:          form.prompt,
            aspectRatio:     form.aspectRatio || form.ratio || "1:1",
            resolution:     form.quality || form.resolution || "1k",
            negativePrompt:  form.negativePrompt,
            enableWebSearch: form.enableWebSearch || false,
            outputFormat:    "png",
        };
    }

    toPayload({ prompt, aspectRatio, resolution, negativePrompt, enableWebSearch, outputFormat }) {
        return {
            prompt,
            aspect_ratio:      aspectRatio || "1:1",
            resolution:        String(resolution || "1k").toLowerCase(),
            negative_prompt:   negativePrompt || "",
            enable_web_search: enableWebSearch || false,
            output_format:     outputFormat    || "png",
        };
    }
}

class Nanobana2Edit extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:     "google/nano-banana-2/edit",
            provider:      "wavespeed",
            type:          "i2i",
            maxReferences: 14,
            capabilities:  [CAPS.TEXT, CAPS.MULTI_IMAGE, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName:   "NanoBanana 2 Edit",
            category:      "image",
            tier:          "std",
            tags:          ["fast", "4k", "multi-ref", "edit"],
            pricing:       { image: 7 },
            modes:         ["i2i"],
            hidden:        true,
        });
    }

    adapt(form) {
        const refs = form.references || [];
        return {
            prompt:          form.prompt,
            images:          refs.map(r => r.url || r).filter(Boolean),
            aspectRatio:     form.aspectRatio || form.ratio || "1:1",
            resolution:     form.quality || form.resolution || "1k",
            negativePrompt:  form.negativePrompt,
            enableWebSearch: form.enableWebSearch || false,
            outputFormat:    "png",
        };
    }

    toPayload({ prompt, images, aspectRatio, resolution, negativePrompt, enableWebSearch, outputFormat }) {
        return {
            prompt,
            images,
            aspect_ratio:      aspectRatio || "1:1",
            resolution:        String(resolution || "1k").toLowerCase(),
            negative_prompt:   negativePrompt || "",
            enable_web_search: enableWebSearch || false,
            output_format:     outputFormat    || "png",
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// NANO BANANA PRO (Gemini 3.0 Pro Image)
// Maximum quality, 4K, advanced reasoning
// Pricing: 1K/2K=$0.14, 4K=$0.24
// ═══════════════════════════════════════════════════════════════════════════

class NanobanaProT2i extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:     "google/nano-banana-pro/text-to-image",
            provider:      "wavespeed",
            type:          "t2i",
            maxReferences: 0,
            capabilities:  [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName:   "NanoBanana Pro",
            category:      "image",
            tier:          "pro",
            tags:          ["pro", "4k", "creative", "typography"],
            pricing:       { image: 14 },
            modes:         ["t2i"],
        });
    }

    adapt(form) {
        return {
            prompt:         form.prompt,
            aspectRatio:    form.aspectRatio || form.ratio || "1:1",
            resolution:     form.quality || form.resolution || "1k",
            negativePrompt: form.negativePrompt,
            outputFormat:   "png",
        };
    }

    toPayload({ prompt, aspectRatio, resolution, negativePrompt, outputFormat }) {
        return {
            prompt,
            aspect_ratio:    aspectRatio || "1:1",
            resolution:      String(resolution  || "1k").toLowerCase(),
            negative_prompt: negativePrompt || "",
            output_format:   outputFormat   || "png",
        };
    }
}

class NanobanaProEdit extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:     "google/nano-banana-pro/edit",
            provider:      "wavespeed",
            type:          "i2i",
            maxReferences: 8,
            capabilities:  [CAPS.TEXT, CAPS.MULTI_IMAGE, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName:   "NanoBanana Pro Edit",
            category:      "image",
            tier:          "pro",
            tags:          ["pro", "4k", "edit", "character-consistency"],
            pricing:       { image: 14 },
            modes:         ["i2i"],
            hidden:        true,
        });
    }

    adapt(form) {
        const refs = form.references || [];
        return {
            prompt:         form.prompt,
            images:         refs.map(r => r.url || r).filter(Boolean),
            aspectRatio:    form.aspectRatio || form.ratio || "1:1",
            resolution:     form.quality || form.resolution || "1k",
            negativePrompt: form.negativePrompt,
            outputFormat:   "png",
        };
    }

    toPayload({ prompt, images, aspectRatio, resolution, negativePrompt, outputFormat }) {
        return {
            prompt,
            images,
            aspect_ratio:    aspectRatio || "1:1",
            resolution:      String(resolution  || "1k").toLowerCase(),
            negative_prompt: negativePrompt || "",
            output_format:   outputFormat   || "png",
        };
    }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

// Nano Banana (Original)
export const normal   = new NanobanaNormal();
export const edit     = new NanobanaEdit();

// Nano Banana 2
export const nb2T2i   = new Nanobana2T2i();
export const nb2Edit  = new Nanobana2Edit();

// Nano Banana Pro
export const pro      = new NanobanaProT2i();
export const proEdit  = new NanobanaProEdit();