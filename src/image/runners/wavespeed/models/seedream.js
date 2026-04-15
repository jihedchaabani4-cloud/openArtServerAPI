import { WavespeedImageRunner } from "../WavespeedImageRunner.js";
import { CAPS                 } from "#core/capabilities.js";

class SeedreamStd extends WavespeedImageRunner {
    constructor() {
        super({
            modelName: "bytedance/seedream-v5.0-lite",
            provider: "wavespeed",
            type: "t2i",
            capabilities: [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName: "Seedream",
            category: "image",
            tier: "std",
            supportedRatios: ["1:1", "16:9", "9:16", "4:3"],
            tags: ["creative", "edit", "multi-ref"],
            pricing: { "image": 6 },
            modes: ["t2i"],
            maxReferences: 4
        });
        this.editVariant = "seedream_edit";
        this.editVariantMulti = "seedream_edit";
    }

    adapt(form) {
        return {
            prompt: form.prompt,
            ratio: form.ratio || "1:1",
            negativePrompt: form.negativePrompt,
            guidanceScale: form.guidanceScale,
            steps: form.steps
        };
    }

    toPayload({ prompt, ratio, negativePrompt, guidanceScale, steps }) {
        return {
            prompt,
            aspect_ratio: ratio,
            negative_prompt: negativePrompt || "",
            guidance_scale: guidanceScale || 7.5,
            num_inference_steps: steps || 20
        };
    }
}

class SeedreamEdit extends WavespeedImageRunner {
    constructor() {
        super({
            modelName: "bytedance/seedream-v5.0-lite/edit",
            provider: "wavespeed",
            type: "i2i",
            maxReferences: 4,
            capabilities: [CAPS.TEXT, CAPS.MULTI_IMAGE, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            category: "image",
            tier: "std",
            pricing: { "image": 8 },
            modes: ["i2i"],
            hidden: true,
            displayName: "Seedream Edit"
        });
    }

    adapt(form) {
        const refs = form.references || [];
        return {
            prompt: form.prompt,
            references: refs.slice(0, 4).map(r => r?.url || (typeof r === 'string' ? r : null)).filter(Boolean),
            ratio: form.ratio || "1:1",
            negativePrompt: form.negativePrompt
        };
    }

    toPayload({ prompt, references, ratio, negativePrompt }) {
        return {
            prompt,
            images: references,
            aspect_ratio: ratio,
            negative_prompt: negativePrompt || ""
        };
    }
}

class SeedreamPro extends WavespeedImageRunner {
    constructor() {
        super({
            modelName: "bytedance/seedream-v4.5",
            provider: "wavespeed",
            type: "t2i",
            capabilities: [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName: "Seedream Pro",
            category: "image",
            tier: "pro",
            supportedRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
            tags: ["hd", "realistic", "edit", "multi-ref"],
            pricing: { "image": 12 },
            modes: ["t2i"],
            maxReferences: 4
        });
        this.editVariant = "seedream_pro_edit";
        this.editVariantMulti = "seedream_pro_edit";
    }

    adapt(form) {
        return {
            prompt: form.prompt,
            ratio: form.ratio || "1:1",
            negativePrompt: form.negativePrompt,
            guidanceScale: form.guidanceScale,
            steps: form.steps
        };
    }

    toPayload({ prompt, ratio, negativePrompt, guidanceScale, steps }) {
        return {
            prompt,
            aspect_ratio: ratio,
            negative_prompt: negativePrompt || "",
            guidance_scale: guidanceScale || 7.5,
            num_inference_steps: steps || 20
        };
    }
}

class SeedreamProEdit extends WavespeedImageRunner {
    constructor() {
        super({
            modelName: "bytedance/seedream-v4.5/edit",
            provider: "wavespeed",
            type: "i2i",
            maxReferences: 4,
            capabilities: [CAPS.TEXT, CAPS.MULTI_IMAGE, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            category: "image",
            tier: "pro",
            pricing: { "image": 15 },
            modes: ["i2i"],
            hidden: true,
            displayName: "Seedream Pro Edit"
        });
    }

    adapt(form) {
        const refs = form.references || [];
        return {
            prompt: form.prompt,
            references: refs.slice(0, 4).map(r => r?.url || (typeof r === 'string' ? r : null)).filter(Boolean),
            ratio: form.ratio || "1:1",
            negativePrompt: form.negativePrompt
        };
    }

    toPayload({ prompt, references, ratio, negativePrompt }) {
        return {
            prompt,
            images: references,
            aspect_ratio: ratio,
            negative_prompt: negativePrompt || ""
        };
    }
}

export const standard = new SeedreamStd();
export const edit = new SeedreamEdit();
export const pro = new SeedreamPro();
export const proEdit = new SeedreamProEdit();
