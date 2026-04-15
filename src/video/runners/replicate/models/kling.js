import { ReplicateVideoRunner } from "../ReplicateVideoRunner.js";
import { CAPS } from "#core/capabilities.js";

/**
 * ─── Kling on Replicate ────────────────────────────────────────────────────
 *
 * Populate modelName with the real Replicate model slug:
 *   e.g. "klingai/kling-1.6-pro"
 *
 * How to use in modelRouter.js:
 *   import { v3MotionReplicate } from "#video/runners/replicate/models/kling.js";
 *
 *   "kling_v3": {
 *       t2v:    v3Std,               // wavespeed
 *       i2v:    v3Std,               // wavespeed
 *       motion: v3MotionReplicate,   // ← replicate
 *   }
 */

// ── v3.0 Motion (Replicate) ───────────────────────────────────────────────────
class KlingV3MotionReplicate extends ReplicateVideoRunner {
    constructor() {
        super({
            modelName:    "klingai/kling-1.6-pro-motion-control", // ← set real replicate slug
            displayName:  "Kling v3.0 Motion (Replicate)",
            provider:     "replicate",
            type:         "motion",
            category:     "video",
            tier:         "std",
            maxReferences: 2,
            capabilities: [CAPS.TEXT, CAPS.IMAGE, CAPS.VIDEO_REF, CAPS.OUTPUTS_VIDEO],
            modes:        ["motion"],
            pricing:      { "5s": 0.28, "10s": 0.56 },
            tags:         ["camera-control", "motion"],
        });
    }

    adapt(form) {
        const refs = form.references || [];
        return {
            prompt:        form.prompt || "",
            duration:      parseFloat(form.duration) || 5,
            image:         refs.find(r => r.role === "start" || r.role === "normal")?.url || null,
            endImage:      refs.find(r => r.role === "end")?.url || null,
            cameraControl: form.cameraControl,
        };
    }

    toPayload({ prompt, image, endImage, duration, cameraControl }) {
        return {
            prompt,
            image,
            duration,
            ...(endImage       !== undefined && { end_image:      endImage       }),
            ...(cameraControl  !== undefined && { camera_control: cameraControl  }),
        };
    }
}

export const v3MotionReplicate = new KlingV3MotionReplicate();
