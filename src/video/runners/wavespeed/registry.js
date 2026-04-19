/**
 * ─── Wavespeed Video Registry ─────────────────────────────────────────────────
 * Keys use the format: <model>_wavespeed
 */

import {
    v26Std, v26Pro, v21ProStartEnd,
    v3Std, v3Pro, o3Std, o3Pro
} from "./models/kling.js";

import {
    seedancePro, seedanceProFast, seedanceProSpicy
} from "./models/seedance.js";

import {
    gen4Turbo, gen4Aleph
} from "./models/runway.js";

export const MODELS = {
    // ── Kling v2.6 ───────────────────────────────────────────────────────────
    "kling_v2_wavespeed": {
        t2v:      v26Std,
        i2v:      v26Std,
        i2v_se:   v26Std,
        motion:   v26Std,
        v2v:      v26Std,
        _default: v26Std,
    },
    "kling_v2_pro_wavespeed": {
        t2v:      v26Pro,
        i2v:      v26Pro,
        i2v_se:   v26Pro,
        motion:   v26Pro,
        v2v:      v26Pro,
        _default: v26Pro,
    },
    
    // ── Kling v2.1 ───────────────────────────────────────────────────────────
    "kling_v21_pro_wavespeed": {
        i2v_se:   v21ProStartEnd,
        _default: v21ProStartEnd,
    },
    
    // ── Kling v3.0 ───────────────────────────────────────────────────────────
    "kling_v3_wavespeed": {
        t2v:      v3Std,
        i2v:      v3Std,
        i2v_se:   v3Std,
        motion:   v3Std,
        v2v:      v3Std,
        _default: v3Std,
    },
    "kling_v3_pro_wavespeed": {
        t2v:      v3Pro,
        i2v:      v3Pro,
        i2v_se:   v3Pro,
        motion:   v3Pro,
        v2v:      v3Pro,
        _default: v3Pro,
    },
    
    // ── Kling O3 ─────────────────────────────────────────────────────────────
    "kling_o3_wavespeed": {
        t2v:      o3Std,
        i2v:      o3Std,
        i2v_se:   o3Std,
        r2v:      o3Std,
        v2v:      o3Std,
        _default: o3Std,
    },
    "kling_o3_pro_wavespeed": {
        t2v:      o3Pro,
        i2v:      o3Pro,
        i2v_se:   o3Pro,
        r2v:      o3Pro,
        v2v:      o3Pro,
        _default: o3Pro,
    },
    

    
    // ── Seedance v1.5 Pro ───────────────────────────────────────────────────
    "seedance_v15_pro_wavespeed": {
        i2v:      seedancePro, 
        i2v_se:   seedancePro, 
        t2v:      seedancePro, 
        v2v:      seedancePro, 
        _default: seedancePro,
    },
    "seedance_v15_pro_fast_wavespeed": {
        i2v:      seedanceProFast, 
        i2v_se:   seedanceProFast, 
        v2v:      seedanceProFast, 
        _default: seedanceProFast,
    },
    "seedance_v15_pro_spicy_wavespeed": {
        i2v:      seedanceProSpicy, 
        i2v_se:   seedanceProSpicy, 
        v2v:      seedanceProSpicy, 
        _default: seedanceProSpicy,
    },
    
    // ── RunwayML Gen-4 ───────────────────────────────────────────────────────
    "runway_gen4_turbo_wavespeed": {
        i2v:      gen4Turbo,
        _default: gen4Turbo,
    },
    "runway_gen4_aleph_wavespeed": {
        v2v:      gen4Aleph,
        _default: gen4Aleph,
    },
};

// ─── Model Info (display metadata per wavespeed key) ─────────────────────────
export const MODEL_INFO = {
    "kling_v2_wavespeed": {
        displayName:    "Kling v2.6 (Wavespeed)",
        provider:       "wavespeed",
        supportedModes: ["t2v", "i2v", "motion", "v2v"],
        pricing:        { "5s": 0.10, "10s": 0.20 },
        support: {
            ratio:    [{ value: "16:9" }, { value: "9:16" }, { value: "1:1" }],
            duration: { min: 5, max: 10, step: 5, unit: "s" },
            frames:   { startFrame: true, endFrame: false },
            references: { min: 0, max: 1 },
            camera_control: true,
        },
    },
    "kling_v2_pro_wavespeed": {
        displayName:    "Kling v2.6 Pro (Wavespeed)",
        provider:       "wavespeed",
        supportedModes: ["t2v", "i2v", "i2v_se", "motion", "v2v"],
        pricing:        { "5s": 0.28, "10s": 0.56 },
        support: {
            ratio:    [{ value: "16:9" }, { value: "9:16" }, { value: "1:1" }],
            duration: { min: 5, max: 10, step: 5, unit: "s" },
            frames:   { startFrame: true, endFrame: true },
            references: { min: 0, max: 1 },
            camera_control: true,
        },
    },
    "kling_v21_pro_wavespeed": {
        displayName:    "Kling v2.1 Pro Keyframes (Wavespeed)",
        provider:       "wavespeed",
        supportedModes: ["i2v_se"],
        pricing:        { "5s": 0.28, "10s": 0.56 },
        support: {
            ratio:    [{ value: "16:9" }, { value: "9:16" }, { value: "1:1" }],
            duration: { min: 5, max: 10, step: 5, unit: "s" },
            frames:   { startFrame: true, endFrame: true },
            references: { min: 2, max: 2 },
        },
    },
    "kling_v3_wavespeed": {
        displayName:    "Kling v3.0 (Wavespeed)",
        provider:       "wavespeed",
        supportedModes: ["t2v", "i2v", "i2v_se", "motion", "v2v"],
        pricing:        { "5s": 0.35, "10s": 0.70 },
        support: {
            ratio:    [{ value: "16:9" }, { value: "9:16" }, { value: "1:1" }],
            duration: { min: 3, max: 15, step: 1, unit: "s" },
            frames:   { startFrame: true, endFrame: true },
            references: { min: 0, max: 1 },
            camera_control: true,
        },
    },
    "kling_v3_pro_wavespeed": {
        displayName:    "Kling v3.0 Pro (Wavespeed)",
        provider:       "wavespeed",
        supportedModes: ["t2v", "i2v", "i2v_se", "motion", "v2v"],
        pricing:        { "5s": 0.45, "10s": 0.90 },
        support: {
            ratio:    [{ value: "16:9" }, { value: "9:16" }, { value: "1:1" }],
            duration: { min: 3, max: 15, step: 1, unit: "s" },
            frames:   { startFrame: true, endFrame: true },
            references: { min: 0, max: 1 },
            camera_control: true,
        },
    },
    "kling_o3_wavespeed": {
        displayName:    "Kling O3 (Wavespeed)",
        provider:       "wavespeed",
        supportedModes: ["t2v", "i2v", "i2v_se", "r2v", "v2v"],
        pricing:        { "5s": 0.70, "10s": 1.40 },
        support: {
            ratio:    [{ value: "16:9" }, { value: "9:16" }, { value: "1:1" }],
            duration: { min: 3, max: 15, step: 1, unit: "s" },
            frames:   { startFrame: true, endFrame: true },
            references: { min: 0, max: 7 },
            camera_control: true,
        },
    },
    "kling_o3_pro_wavespeed": {
        displayName:    "Kling O3 Pro (Wavespeed)",
        provider:       "wavespeed",
        supportedModes: ["t2v", "i2v", "i2v_se", "r2v", "v2v"],
        pricing:        { "5s": 0.90, "10s": 1.80 },
        support: {
            ratio:    [{ value: "16:9" }, { value: "9:16" }, { value: "1:1" }],
            duration: { min: 3, max: 15, step: 1, unit: "s" },
            frames:   { startFrame: true, endFrame: true },
            references: { min: 0, max: 7 },
            camera_control: true,
        },
    },

    "seedance_v15_pro_wavespeed": {
        displayName:    "Seedance v1.5 Pro (Wavespeed)",
        provider:       "wavespeed",
        supportedModes: ["t2v", "i2v", "i2v_se", "v2v"],
        pricing:        { "5s": 0.40 },
        support: {
            ratio:    [
                { value: "16:9" }, { value: "9:16" }, { value: "1:1" },
                { value: "4:3" },  { value: "3:4" },  { value: "21:9" },
                { value: "auto" },
            ],
            duration: { min: 4, max: 12, step: 1, unit: "s", allowAuto: true },
            frames:   { startFrame: true, endFrame: false },
            references: { min: 0, max: 1 },
            camera_control: true,
        },
    },
    "seedance_v15_pro_fast_wavespeed": {
        displayName:    "Seedance v1.5 Pro Fast (Wavespeed)",
        provider:       "wavespeed",
        supportedModes: ["i2v", "i2v_se", "v2v"],
        pricing:        { "5s": 0.40 },
        support: {
            ratio:    [
                { value: "16:9" }, { value: "9:16" }, { value: "1:1" },
                { value: "4:3" },  { value: "3:4" },  { value: "21:9" },
                { value: "auto" },
            ],
            duration: { min: 4, max: 12, step: 1, unit: "s", allowAuto: true },
            frames:   { startFrame: true, endFrame: false },
            references: { min: 0, max: 1 },
            camera_control: true,
        },
    },
    "seedance_v15_pro_spicy_wavespeed": {
        displayName:    "Seedance v1.5 Pro Spicy (Wavespeed)",
        provider:       "wavespeed",
        supportedModes: ["i2v", "i2v_se", "v2v"],
        pricing:        { "5s": 0.40 },
        support: {
            ratio:    [
                { value: "16:9" }, { value: "9:16" }, { value: "1:1" },
                { value: "4:3" },  { value: "3:4" },  { value: "21:9" },
                { value: "auto" },
            ],
            duration: { min: 4, max: 12, step: 1, unit: "s" },
            frames:   { startFrame: true, endFrame: false },
            references: { min: 0, max: 1 },
            camera_control: true,
        },
    },
    "runway_gen4_turbo_wavespeed": {
        displayName:    "RunwayML Gen-4 Turbo (Wavespeed)",
        provider:       "wavespeed",
        supportedModes: ["i2v"],
        pricing:        { "5s": 0.75, "10s": 1.50 },
        support: {
            ratio:    [{ value: "16:9" }, { value: "9:16" }, { value: "1:1" }],
            duration: { min: 5, max: 10, step: 5, unit: "s" },
            frames:   { startFrame: true, endFrame: false },
            references: { min: 1, max: 1 },
        },
    },
    "runway_gen4_aleph_wavespeed": {
        displayName:    "RunwayML Gen-4 Aleph (Wavespeed)",
        provider:       "wavespeed",
        supportedModes: ["v2v"],
        pricing:        { "5s": 0.75, "10s": 1.50 },
        support: {
            ratio:    [{ value: "16:9" }, { value: "9:16" }, { value: "1:1" }],
            duration: { min: 5, max: 10, step: 5, unit: "s" },
            frames:   { startFrame: false, endFrame: false },
            references: { min: 1, max: 1 },
        },
    },
};
