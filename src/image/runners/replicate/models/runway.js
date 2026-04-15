import { ReplicateImageRunner } from "../ReplicateImageRunner.js";
import { CAPS                 } from "#core/capabilities.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function resolveResolution(quality) {
    const q = (quality || "1080p").toLowerCase();
    if (q === "1k") return "720p";
    if (q === "2k" || q === "4k") return "1080p";
    return q;
}

// ─── Base Replicate Runway Image ──────────────────────────────────────────────
class BaseRunwayImage extends ReplicateImageRunner {
    adapt(form) {
        const refs = form.references || [];
        return {
            prompt:           form.prompt,
            reference_images: refs.map(r => r.url || r).filter(Boolean),
            aspect_ratio:     form.ratio || form.aspectRatio || "9:16",
            resolution:       resolveResolution(form.quality),
            seed:             form.seed ?? -1,
        };
    }

    toPayload(adapted) {
        return {
            prompt:           adapted.prompt,
            reference_images: (adapted.reference_images || []).length > 0 ? adapted.reference_images : undefined,
            aspect_ratio:     adapted.aspect_ratio,
            resolution:       adapted.resolution,
            seed:             adapted.seed ?? -1,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNWAYML GEN-4 IMAGE (REPLICATE)
// ═══════════════════════════════════════════════════════════════════════════

class RunwayGen4Image extends BaseRunwayImage {
    constructor() {
        super({
            modelName:     "runwayml/gen4-image",
            versionId:     "runwayml/gen4-image", // Note: Replicate often uses model name as slug if no specific version
            provider:      "replicate",
            type:          "t2i",
            maxReferences: 3,
            capabilities:  [CAPS.TEXT, CAPS.MULTI_IMAGE, CAPS.OUTPUTS_IMAGE],
            displayName:   "RunwayML Gen-4 Image",
            category:      "image",
            tier:          "pro",
            tags:          ["runwayml", "gen-4", "professional", "replicate"],
            pricing:       { image: 8 },
            modes:         ["t2i", "i2i"],
        });
    }
}

class RunwayGen4ImageTurbo extends BaseRunwayImage {
    constructor() {
        super({
            modelName:     "runwayml/gen4-image-turbo",
            versionId:     "runwayml/gen4-image-turbo",
            provider:      "replicate",
            type:          "t2i",
            maxReferences: 3,
            capabilities:  [CAPS.TEXT, CAPS.MULTI_IMAGE, CAPS.OUTPUTS_IMAGE],
            displayName:   "RunwayML Gen-4 Image Turbo",
            category:      "image",
            tier:          "pro",
            tags:          ["runwayml", "gen-4", "fast", "turbo", "replicate"],
            pricing:       { image: 5 },
            modes:         ["t2i", "i2i"],
        });
    }
}

export const gen4Image = new RunwayGen4Image();
export const gen4ImageTurbo = new RunwayGen4ImageTurbo();
