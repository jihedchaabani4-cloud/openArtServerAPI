import { WavespeedVideoRunner } from "../WavespeedVideoRunner.js";
import { CAPS                 } from "#core/capabilities.js";

// ═══════════════════════════════════════════════════════════════════════════
// FAMILY WRAPPER
// ═══════════════════════════════════════════════════════════════════════════

class ModelFamily extends WavespeedVideoRunner {
    constructor(displayName, variants, metaOverrides = {}) {
        const primary = Object.values(variants)[0];
        const allCaps = new Set();
        const allModes = new Set();
        let maxRefs = 0;
        Object.values(variants).forEach(v => {
            v.caps.forEach(c => allCaps.add(c));
            v.modes.forEach(m => allModes.add(m));
            if (v.maxReferences > maxRefs) maxRefs = v.maxReferences;
        });

        super({
            modelName: primary.modelName,
            displayName,
            provider: primary.provider,
            type: primary.type,
            capabilities: [...allCaps],
            modes: [...allModes],
            maxReferences: maxRefs,
            variants,
            ...metaOverrides
        });
    }

    adapt(form, mode) {
        const m = mode || "t2v"; // fallback
        const runner = this.variants[m] || Object.values(this.variants)[0];
        return runner.adapt(form);
    }

    toPayload(adapted, mode) {
        const m = mode || "t2v";
        const runner = this.variants[m] || Object.values(this.variants)[0];
        return runner.toPayload(adapted);
    }

    async generate(adapted, mode) {
        const m = mode || "t2v";
        const runner = this.variants[m] || Object.values(this.variants)[0];
        return runner.generate(adapted, m);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// BASE CLASSES (Internal)
// ═══════════════════════════════════════════════════════════════════════════

class SeedanceT2v extends WavespeedVideoRunner {
    constructor({ modelName, displayName, tier = "pro", pricing = {} }) {
        super({
            modelName, provider: "wavespeed", type: "t2v", maxReferences: 0,
            capabilities: [CAPS.TEXT, CAPS.OUTPUTS_VIDEO, CAPS.SEED],
            displayName, category: "video", tier, pricing,
            modes: ["t2v"],
        });
    }
    adapt(form) {
        return { 
            prompt: form.prompt,
            duration: parseFloat(form.duration) || -1,
            ratio: form.ratio,
            resolution: form.resolution,
            cameraFixed: form.cameraControl ? false : true,
            seed: form.seed
        };
    }
    toPayload({ prompt, duration, ratio, resolution, cameraFixed, seed }) {
        const payload = { prompt };
        if (duration) payload.duration = duration;
        if (ratio) payload.aspect_ratio = ratio;
        if (resolution) payload.resolution = resolution;
        if (cameraFixed !== undefined) payload.camera_fixed = cameraFixed;
        if (seed !== undefined && seed !== null) payload.seed = parseInt(seed, 10);
        return payload;
    }
}

class SeedanceI2v extends WavespeedVideoRunner {
    constructor({ modelName, displayName, tier = "pro", pricing = {}, isFast = false, isSpicy = false }) {
        super({
            modelName, provider: "wavespeed", type: "i2v", maxReferences: 2,
            capabilities: [CAPS.TEXT, CAPS.IMAGE, CAPS.OUTPUTS_VIDEO, CAPS.SEED],
            displayName, category: "video", tier, pricing,
            modes: ["t2v", "i2v", "i2v_se"],
        });
        this.isFast = isFast;
        this.isSpicy = isSpicy;
    }
    adapt(form) {
        const refs = form.references || [];
        return {
            prompt: form.prompt,
            image: refs.find(r => r.role === "start" || r.role === "normal")?.url || null,
            duration: parseFloat(form.duration) || 5,
            ratio: form.ratio,
            resolution: form.resolution,
            cameraFixed: form.cameraControl ? false : true,
            seed: form.seed
        };
    }
    toPayload({ prompt, image, duration, ratio, resolution, cameraFixed, seed }) {
        const payload = { image };
        if (prompt) payload.prompt = prompt;
        if (duration) payload.duration = duration;
        if (ratio) payload.aspect_ratio = ratio;
        if (resolution) payload.resolution = resolution;
        if (cameraFixed !== undefined) payload.camera_fixed = cameraFixed;
        if (seed !== undefined && seed !== null) payload.seed = parseInt(seed, 10);
        return payload;
    }
}

class SeedanceV2v extends WavespeedVideoRunner {
    constructor({ modelName, displayName, tier = "pro", pricing = {}, isFast = false, isSpicy = false }) {
        super({
            modelName, provider: "wavespeed", type: "v2v", maxReferences: 2,
            capabilities: [CAPS.TEXT, CAPS.VIDEO_REF, CAPS.OUTPUTS_VIDEO, CAPS.SEED],
            displayName, category: "video", tier, pricing,
            modes: ["v2v"],
        });
        this.isFast = isFast;
        this.isSpicy = isSpicy;
    }
    adapt(form) {
        const refs = form.references || [];
        return {
            prompt: form.prompt,
            video: form.video || form.video_base64 || refs.find(r => r.role === "video" || r.type === "video")?.url || null,
            duration: parseFloat(form.duration) || 5,
            ratio: form.ratio,
            resolution: form.resolution,
            cameraFixed: form.cameraControl ? false : true,
            seed: form.seed
        };
    }
    toPayload({ prompt, video, duration, ratio, resolution, cameraFixed, seed }) {
        const payload = { video };
        if (prompt) payload.prompt = prompt;
        if (duration) payload.duration = duration;
        if (ratio) payload.aspect_ratio = ratio;
        if (resolution) payload.resolution = resolution;
        if (cameraFixed !== undefined) payload.camera_fixed = cameraFixed;
        if (seed !== undefined && seed !== null) payload.seed = parseInt(seed, 10);
        return payload;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

const SEEDANCE_PRICING = { "default": 0.5 }; // Example pricing

// Internal Mode-Specific Instances (Hidden)
const seedanceT2v      = new SeedanceT2v({ modelName: "bytedance/seedance-v1.5-pro/text-to-video", displayName: "Seedance T2V", pricing: SEEDANCE_PRICING, hidden: true });
const seedanceI2v      = new SeedanceI2v({ modelName: "bytedance/seedance-v1.5-pro/image-to-video", displayName: "Seedance I2V", pricing: SEEDANCE_PRICING, hidden: true });
const seedanceV2v      = new SeedanceV2v({ modelName: "bytedance/seedance-v1.5-pro/video-to-video", displayName: "Seedance V2V", pricing: SEEDANCE_PRICING, hidden: true });

const seedanceI2vFast  = new SeedanceI2v({ modelName: "bytedance/seedance-v1.5-pro/image-to-video-fast", displayName: "Seedance I2V Fast", pricing: SEEDANCE_PRICING, isFast: true, hidden: true });
const seedanceV2vFast  = new SeedanceV2v({ modelName: "bytedance/seedance-v1.5-pro/video-to-video-fast", displayName: "Seedance V2V Fast", pricing: SEEDANCE_PRICING, isFast: true, hidden: true });

const seedanceI2vSpicy = new SeedanceI2v({ modelName: "bytedance/seedance-v1.5-pro/image-to-video-spicy", displayName: "Seedance I2V Spicy", pricing: SEEDANCE_PRICING, isSpicy: true, hidden: true });
const seedanceV2vSpicy = new SeedanceV2v({ modelName: "bytedance/seedance-v1.5-pro/video-to-video-spicy", displayName: "Seedance V2V Spicy", pricing: SEEDANCE_PRICING, isSpicy: true, hidden: true });

// Final Family Exports
export const seedancePro = new ModelFamily("Seedance v1.5 Pro", {
    "t2v": seedanceT2v,
    "i2v": seedanceI2v,
    "v2v": seedanceV2v
}, { pricing: SEEDANCE_PRICING, tier: "pro" });

export const seedanceProFast = new ModelFamily("Seedance v1.5 Pro Fast", {
    "t2v": seedanceT2v,
    "i2v": seedanceI2vFast,
    "v2v": seedanceV2vFast
}, { pricing: SEEDANCE_PRICING, tier: "pro" });

export const seedanceProSpicy = new ModelFamily("Seedance v1.5 Pro Spicy", {
    "t2v": seedanceT2v,
    "i2v": seedanceI2vSpicy,
    "v2v": seedanceV2vSpicy
}, { pricing: SEEDANCE_PRICING, tier: "pro" });

// Mode-Specific Variant Exports for Registry
export {
    seedanceT2v,
    seedanceI2v,
    seedanceV2v,
    seedanceI2vFast,
    seedanceV2vFast,
    seedanceI2vSpicy,
    seedanceV2vSpicy
};
