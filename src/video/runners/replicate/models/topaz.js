import { ReplicateVideoRunner } from "../ReplicateVideoRunner.js";
import { CAPS } from "#core/capabilities.js";

class TopazVideoUpscale extends ReplicateVideoRunner {
    constructor() {
        super({
            modelName: "topazlabs/video-upscale",
            provider: "replicate",
            type: "upscale",
            capabilities: [CAPS.OUTPUTS_VIDEO],
            displayName: "Topaz Video Upscale",
            category: "video",
            tier: "pro",
            tags: ["upscale", "topaz"],
            pricing: { "video": 15 }
        });
        // Note: Use official version ID if needed
        this.versionId = "topazlabs/video-upscale"; 
    }

    adapt(form) {
        // Based on Replicate topazlabs/video-upscale schema
        return {
            video: form.video_url,
            target_resolution: form.target_resolution || "1080p",
            target_fps: parseInt(form.target_fps || "30")
        };
    }

    toPayload(adapted) {
        return adapted;
    }
}

export const videoUpscale = new TopazVideoUpscale();
