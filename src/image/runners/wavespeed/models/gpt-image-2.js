import { WavespeedImageRunner } from "../WavespeedImageRunner.js";
import { CAPS                 } from "#core/capabilities.js";

class GptImage2T2i extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:      "openai/gpt-image-2/text-to-image",
            provider:       "wavespeed",
            type:           "t2i",
            maxReferences:  0,
            capabilities:   [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName:    "GPT Image 2",
            category:       "image",
            tier:           "pro",
            supportedRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
            tags:           ["gpt", "creative", "high-quality"],
            pricing:        { image: 10 },
            modes:          ["t2i"],
        });
    }

    adapt(form) {
        return {
            prompt:         form.prompt,
            aspect_ratio:   form.ratio || "1:1",
            negativePrompt: form.negativePrompt,
            guidanceScale:  form.guidanceScale,
            steps:          form.steps,
        };
    }

    toPayload({ prompt, aspect_ratio, negativePrompt, guidanceScale, steps }) {
        return {
            prompt,
            aspect_ratio:        aspect_ratio || "1:1",
            negative_prompt:     negativePrompt || "",
            guidance_scale:      guidanceScale  || 7.5,
            num_inference_steps: steps          || 20,
        };
    }
}

class GptImage2Edit extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:     "openai/gpt-image-2/edit",
            provider:      "wavespeed",
            type:          "i2i",
            maxReferences: 5,
            capabilities:  [CAPS.TEXT, CAPS.IMAGE, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName:   "GPT Image 2 Edit",
            category:      "image",
            tier:          "pro",
            pricing:       { image: 12 },
            modes:         ["i2i"],
            hidden:        true,
        });
    }

    adapt(form) {
        const refs = form.references || [];
        return {
            prompt:         form.prompt,
            images:         refs.map(r => r.url || r).filter(Boolean),
            aspect_ratio:   form.ratio,
            negativePrompt: form.negativePrompt,
            guidanceScale:  form.guidanceScale,
            steps:          form.steps,
        };
    }

    toPayload({ prompt, images, aspect_ratio, negativePrompt, guidanceScale, steps }) {
        return {
            prompt, images,
            aspect_ratio:        aspect_ratio,
            negative_prompt:     negativePrompt || "",
            guidance_scale:      guidanceScale  || 7.5,
            num_inference_steps: steps          || 20,
        };
    }
}

export const t2i = new GptImage2T2i();
export const edit = new GptImage2Edit();
