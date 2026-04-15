import { FalImageRunner } from "../FalImageRunner.js";
import { CAPS } from "#core/capabilities.js";

class FluxPro extends FalImageRunner {
    constructor() {
        super({
            modelName: "fal-ai/flux-pro",
            provider: "fal",
            type: "t2i",
            capabilities: [CAPS.TEXT, CAPS.OUTPUTS_IMAGE],
            displayName: "Flux Pro",
            category: "image",
            tier: "pro",
            supportedRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"],
            tags: ["high-quality", "pro"],
            pricing: { "image": 10 },
            modes: ["t2i"]
        });
    }

    adapt(form) {
        return {
            prompt: form.prompt,
            ratio: form.ratio || "1:1",
            steps: form.steps || 30,
            guidanceScale: form.guidanceScale || 4.0
        };
    }

    toPayload({ prompt, ratio, steps, guidanceScale }) {
        let image_size = "square";
        if (ratio === "16:9") image_size = "landscape_16_9";
        else if (ratio === "9:16") image_size = "portrait_16_9";
        else if (ratio === "4:3") image_size = "landscape_4_3";
        else if (ratio === "3:4") image_size = "portrait_4_3";
        else if (ratio === "3:2") image_size = "landscape_4_3";
        else if (ratio === "2:3") image_size = "portrait_4_3";
        else if (ratio === "21:9") image_size = "landscape_16_9"; 
        
        return {
            prompt,
            image_size,
            num_inference_steps: steps,
            guidance_scale: guidanceScale
        };
    }
}

export const pro = new FluxPro();
