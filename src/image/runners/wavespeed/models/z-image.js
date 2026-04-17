import { WavespeedImageRunner } from "../WavespeedImageRunner.js";
import { CAPS                 } from "#core/capabilities.js";

// ─── Kling v2.6 Std — i2v ────────────────────────────────────────────────────

class ZImageTurbo extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:      "wavespeed-ai/z-image/turbo",
            provider:       "wavespeed",
            type:           "t2i",
            maxReferences:  0,
            capabilities:   [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName:    "Z-Image",
            category:       "image",
            tier:           "std",
            supportedRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
            tags:           ["fast", "realistic"],
            pricing:        { image: 5 },
            modes:          ["t2i"],
        });
    }

    adapt(form) {
        return {
            prompt:         form.prompt,
            width:          form.width  || 1024,
            height:         form.height || 1024,
            negativePrompt: form.negativePrompt,
            guidanceScale:  form.guidanceScale,
            steps:          form.steps,
        };
    }

    toPayload({ prompt, width, height, negativePrompt, guidanceScale, steps }) {
        return {
            prompt,
            size:                `${width || 1024}*${height || 1024}`,
            negative_prompt:     negativePrompt || "",
            guidance_scale:      guidanceScale  || 7.5,
            num_inference_steps: steps          || 20,
        };
    }
}

class ZImageImg2Img extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:     "wavespeed-ai/z-image-turbo/image-to-image",
            provider:      "wavespeed",
            type:          "i2i",
            maxReferences: 1,
            capabilities:  [CAPS.TEXT, CAPS.IMAGE, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName:   "Z-Image Edit",
            category:      "image",
            tier:          "std",
            pricing:       { image: 7 },
            modes:         ["i2i"],
            hidden:        true,
        });
    }

    adapt(form) {
        return {
            prompt:         form.prompt,
            image:          form.image_url || (form.references || [])[0] || null,
            width:          form.width,
            height:         form.height,
            negativePrompt: form.negativePrompt,
            guidanceScale:  form.guidanceScale,
            steps:          form.steps,
        };
    }

    toPayload({ prompt, image, width, height, negativePrompt, guidanceScale, steps }) {
        return {
            prompt, image,
            size:                `${width || 1024}*${height || 1024}`,
            negative_prompt:     negativePrompt || "",
            guidance_scale:      guidanceScale  || 7.5,
            num_inference_steps: steps          || 20,
        };
    }
}

// ─── Z-Image Base = Normal (ليس Pro) ─────────────────────────────────────────

class ZImageBase extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:      "wavespeed-ai/z-image/base",
            provider:       "wavespeed",
            type:           "t2i",
            maxReferences:  0,
            capabilities:   [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName:    "Z-Image Base",
            category:       "image",
            tier:           "std",
            supportedRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
            tags:           ["balanced", "realistic"],
            pricing:        { image: 10 },
            modes:          ["t2i"],
        });
    }

    adapt(form) {
        return {
            prompt:         form.prompt,
            width:          form.width  || 1024,
            height:         form.height || 1024,
            negativePrompt: form.negativePrompt,
            guidanceScale:  form.guidanceScale,
            steps:          form.steps,
        };
    }

    toPayload({ prompt, width, height, negativePrompt, guidanceScale, steps }) {
        return {
            prompt,
            size:                `${width || 1024}*${height || 1024}`,
            negative_prompt:     negativePrompt || "",
            guidance_scale:      guidanceScale  || 7.5,
            num_inference_steps: steps          || 20,
        };
    }
}

// ─── Exports ──────────────────────────────────────────────────────────────────
export const turbo   = new ZImageTurbo();
export const img2img = new ZImageImg2Img();
export const base    = new ZImageBase();
