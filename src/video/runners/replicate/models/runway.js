import { ReplicateVideoRunner } from "../ReplicateVideoRunner.js";
import { CAPS                 } from "#core/capabilities.js";

// ═══════════════════════════════════════════════════════════════════════════
// RUNWAYML GEN-4 TURBO (REPLICATE)
// ═══════════════════════════════════════════════════════════════════════════

class RunwayGen4Turbo extends ReplicateVideoRunner {
    constructor() {
        super({
            modelName:     "runwayml/gen4-turbo",
            provider:      "replicate",
            type:          "i2v",
            maxReferences: 1,
            capabilities:  [CAPS.TEXT, CAPS.IMAGE, CAPS.OUTPUTS_VIDEO],
            displayName:   "RunwayML Gen-4 Turbo",
            category:      "video",
            tier:          "pro",
            tags:          ["runwayml", "gen-4", "turbo", "replicate"],
            pricing:       { video: 18 },
            modes:         ["i2v"],
        });
    }
    adapt(form) {
        const refs = form.references || [];
        const image = refs[0]?.url || refs[0] || null;
        return {
            prompt:           form.prompt,
            image,
            aspect_ratio:     form.ratio || "16:9",
            duration:         parseFloat(form.duration) || 5,
        };
    }
    toPayload(adapted) {
        return adapted;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNWAYML GEN-4 ALEPH (REPLICATE)
// ═══════════════════════════════════════════════════════════════════════════

class RunwayGen4Aleph extends ReplicateVideoRunner {
    constructor() {
        super({
            modelName:     "runwayml/gen4-aleph",
            provider:      "replicate",
            type:          "v2v",
            maxReferences: 1,
            capabilities:  [CAPS.TEXT, CAPS.VIDEO, CAPS.OUTPUTS_VIDEO],
            displayName:   "RunwayML Gen-4 Aleph",
            category:      "video",
            tier:          "pro",
            tags:          ["runwayml", "gen-4", "v2v", "aleph", "replicate"],
            pricing:       { video: 18 },
            modes:         ["v2v"],
        });
    }
    adapt(form) {
        const refs = form.references || [];
        const video = refs[0]?.url || refs[0] || null;
        return {
            prompt:           form.prompt,
            video,
            aspect_ratio:     form.ratio || "16:9",
            duration:         parseFloat(form.duration) || 5,
        };
    }
    toPayload(adapted) {
        return adapted;
    }
}

export const gen4Turbo = new RunwayGen4Turbo();
export const gen4Aleph = new RunwayGen4Aleph();
