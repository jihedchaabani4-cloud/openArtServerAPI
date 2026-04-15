import { GoogleVideoRunner } from "../GoogleVideoRunner.js";
import { CAPS              } from "#core/capabilities.js";

const RATIOS = [
    { value: "16:9", label: "16:9" },
    { value: "9:16", label: "9:16" },
    { value: "1:1",  label: "1:1"  },
];

const DURATION_SHORT = { min: 5, max: 10, step: 5, unit: "s" };

class GoogleNanobanaVideo extends GoogleVideoRunner {
    constructor() {
        super({
            modelName:     "veo-1", // Hitting veo-1 via AI Studio
            provider:      "google",
            type:          "t2v",
            maxReferences: 0,
            capabilities:  [CAPS.TEXT, CAPS.OUTPUTS_VIDEO],
            displayName:   "Google NanoBanana Video",
            category:      "video",
            tier:          "std",
            tags:          ["fast", "google", "aistudio"],
            pricing:       { "5s": 0.42, "10s": 0.84 },
            modes:         ["t2v"],
            supportedRatios: ["16:9", "9:16", "1:1"],
            maxDuration:   10,
            minDuration:   5,
        });
    }

    adapt(form) {
        return {
            prompt:       form.prompt,
            aspect_ratio:  form.ratio || "16:9",
            duration:     parseFloat(form.duration) || 5,
        };
    }

    toPayload(adapted) {
        return adapted;
    }
}

export const nanobanaVideo = new GoogleNanobanaVideo();
