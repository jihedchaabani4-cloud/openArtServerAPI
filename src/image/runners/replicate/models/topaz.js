import { ReplicateImageRunner } from "../ReplicateImageRunner.js";
import { CAPS } from "#core/capabilities.js";

class TopazImageUpscale extends ReplicateImageRunner {
    constructor() {
        super({
            modelName: "topazlabs/image-upscale",
            provider: "replicate",
            type: "upscale",
            capabilities: [CAPS.OUTPUTS_IMAGE],
            displayName: "Topaz Image Upscale",
            category: "image",
            tier: "pro",
            tags: ["upscale", "topaz"],
            pricing: { "image": 15 }
        });
        this.versionId = "topazlabs/image-upscale";
    }

    adapt(form) {
        const scale = form.scale || form.upscaleScale || "2";
        // Accept common scale shapes from UI ("2", "2x", "x2", numeric values).
        const scaleNum = parseFloat(scale.toString().toLowerCase().replace("x", "")) || 2;

        // Replicate Topaz expects enum values: "None" | "2x" | "4x" | "6x".
        const roundedScale = Math.round(scaleNum);
        const upscaleFactor =
            roundedScale >= 6 ? "6x" :
            roundedScale >= 4 ? "4x" :
            roundedScale >= 2 ? "2x" :
            "None";

        // Based on Replicate topazlabs/image-upscale schema
        return {
            image: form.image_url || form.image,
            upscale_factor: upscaleFactor,
            enhance_model: form.enhance_model || "Standard V2",
            face_enhancement: form.face_enhancement || false,
            output_format: form.output_format || "png"
        };
    }

    toPayload(adapted) {
        return adapted;
    }
}

export const imageUpscale = new TopazImageUpscale();
