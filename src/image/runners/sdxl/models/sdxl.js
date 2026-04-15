import { SdxlImageRunner } from "../SdxlImageRunner.js";
import { CAPS            } from "#core/capabilities.js";

class SDXL extends SdxlImageRunner {
    constructor() {
        super({
            modelName: "sdxl-ngrok",
            provider: "sdxl",
            type: "t2i",
            capabilities: [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName: "SDXL Lightning",
            category: "image",
            tier: "std",
            supportedRatios: ["1:1", "16:9", "9:16", "4:3"],
            tags: ["fast", "realistic"],
            pricing: { "image": 1 },
            modes: ["t2i"],
            baseUrl: process.env.SDXL_NGROK_URL
        });
    }

    adapt(form) {
        let { w, h } = this._calculateDimensions(form.ratio, form.quality);
        return {
            prompt: form.prompt,
            negativePrompt: form.negativePrompt,
            width: form.width || w,
            height: form.height || h,
            steps: form.steps,
            guidanceScale: form.guidanceScale,
            seed: form.seed
        };
    }

    toPayload({ prompt, negativePrompt, width, height, steps, guidanceScale, seed }) {
        return {
            prompt,
            negative_prompt: negativePrompt || undefined,
            width: Math.min(Math.max(width, 512), 1024),
            height: Math.min(Math.max(height, 512), 1536),
            steps: Math.min(steps || 28, 40),
            guidance_scale: Math.min(guidanceScale || 6.5, 30),
            seed: seed || null
        };
    }

    adaptMultiRef(form) {
        let { w, h } = this._calculateDimensions(form.ratio, form.quality);
        return {
            prompts: form.prompts,
            image_url: form.image_url,
            negativePrompt: form.negativePrompt,
            width: form.width || w,
            height: form.height || h,
            strength: form.strength,
            steps: form.steps,
            guidanceScale: form.guidanceScale,
            seeds: form.seeds
        };
    }

    toMultiRefPayload({ prompts, image_url, negativePrompt, width, height, strength, steps, guidanceScale, seeds }) {
        return {
            prompts,
            negative_prompt: negativePrompt || undefined,
            image_url: image_url,
            width: Math.min(Math.max(width, 512), 1024),
            height: Math.min(Math.max(height, 512), 1536),
            strength: strength ?? 0.7,
            steps: Math.min(steps || 28, 40),
            guidance_scale: Math.min(guidanceScale || 6.5, 30),
            seeds: seeds || null
        };
    }
}

export const ngrok = new SDXL();
