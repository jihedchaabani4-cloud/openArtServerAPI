/**
 * ─── Replicate Video Registry ─────────────────────────────────────────────────
 * Keys use the format: <model>_replicate
 */

import { gen4Turbo, gen4Aleph } from "./models/runway.js";
import { videoUpscale } from "./models/topaz.js";

export const MODELS = {
    // ── RunwayML Gen-4 ───────────────────────────────────────────────────────
    "runway_gen4_turbo_replicate": {
        t2v:      gen4Turbo,
        i2v:      gen4Turbo,
        _default: gen4Turbo,
    },
    "runway_gen4_aleph_replicate": {
        v2v:      gen4Aleph,
        _default: gen4Aleph,
    },
    
    // ── Topaz Video ───────────────────────────────────────────────────────────
    "topaz_video_upscale_replicate": {
        upscale:  videoUpscale,
        _default: videoUpscale,
    },
};

// ─── Model Info (display metadata per replicate key) ─────────────────────────
export const MODEL_INFO = {
    "runway_gen4_turbo_replicate": {
        displayName:    "RunwayML Gen-4 Turbo (Replicate)",
        provider:       "replicate",
        supportedModes: ["t2v", "i2v"],
        pricing:        { "5s": 0.90, "10s": 1.80 },
        support: {
            ratio:      [{ value: "16:9" }, { value: "9:16" }, { value: "1:1" }],
            duration:   { min: 5, max: 10, step: 5, unit: "s" },
            frames:     { startFrame: true, endFrame: false },
            references: { min: 1, max: 1 },
        },
    },
    "runway_gen4_aleph_replicate": {
        displayName:    "RunwayML Gen-4 Aleph (Replicate)",
        provider:       "replicate",
        supportedModes: ["v2v"],
        pricing:        { "5s": 0.90, "10s": 1.80 },
        support: {
            ratio:      [{ value: "16:9" }, { value: "9:16" }, { value: "1:1" }],
            duration:   { min: 5, max: 10, step: 5, unit: "s" },
            frames:     { startFrame: false, endFrame: false },
            references: { min: 1, max: 1 },
        },
    },
    "topaz_video_upscale_replicate": {
        displayName:    "Topaz Video Upscale (Replicate)",
        provider:       "replicate",
        supportedModes: ["upscale"],
        pricing:        { "5s": 0.75, "10s": 1.50 },
        support: {
            ratio:      [{ value: "16:9" }, { value: "9:16" }, { value: "1:1" }],
            duration:   { min: 3, max: 15, step: 1, unit: "s" },
            frames:     { startFrame: false, endFrame: false },
            references: { min: 0, max: 0 },
        },
    },
};
