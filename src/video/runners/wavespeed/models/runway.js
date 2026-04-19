import { WavespeedVideoRunner } from "../WavespeedVideoRunner.js";
import { CAPS                 } from "#core/capabilities.js";

// ═══════════════════════════════════════════════════════════════════════════
// RUNWAYML GEN-4 TURBO (IMAGE-TO-VIDEO)
// ═══════════════════════════════════════════════════════════════════════════

class RunwayGen4Turbo extends WavespeedVideoRunner {
    constructor() {
        super({
            modelName:     "runwayml/gen4-turbo",
            provider:      "wavespeed",
            type:          "i2v",
            maxReferences: 1,
            capabilities:  [CAPS.TEXT, CAPS.IMAGE, CAPS.OUTPUTS_VIDEO],
            displayName:   "RunwayML Gen-4 Turbo",
            category:      "video",
            tier:          "pro",
            tags:          ["runwayml", "gen-4", "turbo", "high-quality"],
            pricing:       { video: 18 },
            modes:         ["i2v"],
        });
    }
    adapt(form) {
        const refs = form.references || [];
        const image = form.image || form.image_base64 || refs[0]?.url || refs[0] || null;
        return {
            prompt:      form.prompt,
            image,
            ratio:       form.ratio || "16:9",
            duration:    parseFloat(form.duration) || 5,
        };
    }
    toPayload({ prompt, image, ratio, duration }) {
        return {
            prompt,
            image,
            aspect_ratio: ratio || "16:9",
            ratio:        ratio || "16:9",
            resolution:   "1080p", // Enforce standard resolution
            duration:     duration || 5,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNWAYML GEN-4 ALEPH (VIDEO-TO-VIDEO)
// ═══════════════════════════════════════════════════════════════════════════

class RunwayGen4Aleph extends WavespeedVideoRunner {
    constructor() {
        super({
            modelName:     "runwayml/gen4-aleph",
            provider:      "wavespeed",
            type:          "v2v",
            maxReferences: 1,
            capabilities:  [CAPS.TEXT, CAPS.VIDEO, CAPS.OUTPUTS_VIDEO],
            displayName:   "RunwayML Gen-4 Aleph",
            category:      "video",
            tier:          "pro",
            tags:          ["runwayml", "gen-4", "v2v", "aleph"],
            pricing:       { video: 18 },
            modes:         ["v2v"],
        });
    }
    adapt(form) {
        const refs = form.references || [];
        const video = form.video || form.video_base64 || refs[0]?.url || refs[0] || null;
        return {
            prompt:      form.prompt,
            video,
            ratio:       form.ratio || "16:9",
            duration:    parseFloat(form.duration) || 5,
        };
    }
    toPayload({ prompt, video, ratio, duration }) {
        return {
            prompt,
            video,
            aspect_ratio: ratio || "16:9",
            duration:     duration || 5,
        };
    }
}

export const gen4Turbo = new RunwayGen4Turbo();
export const gen4Aleph = new RunwayGen4Aleph();
