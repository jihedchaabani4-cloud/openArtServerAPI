/**
 * ─── Google Video Registry ───────────────────────────────────────────────────
 * Keys use the format: <model>_google
 */

import { nanobanaVideo } from "./models/nanobana.js";

export const MODELS = {
    "nanobana_google": {
        t2v:      nanobanaVideo,
        _default: nanobanaVideo,
    },
    "veo_google": {
        t2v:      nanobanaVideo, // currently both use the same runner
        _default: nanobanaVideo,
    },
};

// ─── Model Info (display metadata per google key) ─────────────────────────────
export const MODEL_INFO = {
    "nanobana_google": {
        displayName:    "Nano Banana Video (Google)",
        provider:       "google",
        supportedModes: ["t2v"],
        pricing:        { "5s": 0.42, "10s": 0.84 },
        support: {
            ratio:      [{ value: "16:9" }, { value: "9:16" }, { value: "1:1" }],
            duration:   { min: 5, max: 10, step: 5, unit: "s" },
            frames:     { startFrame: false, endFrame: false },
            references: { min: 0, max: 0 },
            resolution: [{ value: "1080p", label: "1080p" }],
        },
    },
    "veo_google": {
        displayName:    "Google Veo 3.1 (Google)",
        provider:       "google",
        supportedModes: ["t2v"],
        pricing:        { "5s": 0.56, "10s": 1.12 },
        support: {
            ratio:      [{ value: "16:9" }, { value: "9:16" }, { value: "1:1" }],
            duration:   { min: 5, max: 10, step: 5, unit: "s" },
            frames:     { startFrame: false, endFrame: false },
            references: { min: 0, max: 0 },
            resolution: [{ value: "720p", label: "720p" }, { value: "1080p", label: "1080p" }],
        },
    },
};
