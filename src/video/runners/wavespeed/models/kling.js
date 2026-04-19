import { WavespeedVideoRunner } from "../WavespeedVideoRunner.js";
import { CAPS                 } from "#core/capabilities.js";

// ─── Helper ──────────────────────────────────────────────────────────────────
function resolvePrompt(prompt, refs) {
    if (!refs?.length) return prompt;
    const named = refs.filter(r => r.name);
    if (!named.length) return prompt;
    const names    = named.map(r => r.name);
    const mentions = [...(prompt.matchAll(/@(\w+)/g) || [])].map(m => m[1]);
    const unknown  = mentions.filter(m => !names.includes(m));
    if (unknown.length)
        throw new Error(`Unknown references in prompt: ${unknown.join(", ")}`);
    let resolved = prompt;
    named.forEach((ref, i) => {
        resolved = resolved.replace(new RegExp(`@${ref.name}\\b`, "g"), `image ${i + 1}`);
    });
    return resolved;
}

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

class BaseSimpleT2v extends WavespeedVideoRunner {
    constructor({ modelName, displayName, tier = "std", pricing = {} }) {
        super({
            modelName, provider: "wavespeed", type: "t2v", maxReferences: 0,
            capabilities: [CAPS.TEXT, CAPS.OUTPUTS_VIDEO],
            displayName, category: "video", tier, pricing,
            modes: ["t2v"],
        });
    }
    adapt(form) {
        return { prompt: form.prompt, ratio: form.ratio, resolution: form.resolution, duration: parseFloat(form.duration) || 5, cameraControl: form.cameraControl };
    }
    toPayload({ prompt, ratio, resolution, duration, cameraControl }) {
        return { 
            prompt, aspect_ratio: ratio || "16:9", duration: duration || 5,
            ...(resolution    !== undefined && { resolution }),
            ...(cameraControl !== undefined && { camera_control: cameraControl })
        };
    }
}

class BaseSimpleI2v extends WavespeedVideoRunner {
    constructor({ modelName, displayName, tier = "std", pricing = {} }) {
        super({
            modelName, provider: "wavespeed", type: "i2v", maxReferences: 1,
            capabilities: [CAPS.TEXT, CAPS.IMAGE, CAPS.OUTPUTS_VIDEO],
            displayName, category: "video", tier, pricing,
            modes: ["t2v", "i2v"],
        });
    }
    adapt(form) {
        const refs = form.references || [];
        return {
            prompt:        form.prompt,
            ratio:         form.ratio,
            resolution:    form.resolution,
            duration:      parseFloat(form.duration) || 5,
            image:         form.image || form.image_base64 || refs.find(r => r.role === "start" || r.role === "normal")?.url || null,
            cameraControl: form.cameraControl,
        };
    }
    toPayload({ prompt, image, ratio, resolution, duration, cameraControl }) {
        return { 
            prompt, image, aspect_ratio: ratio || "16:9", duration: duration || 5,
            ...(resolution    !== undefined && { resolution }),
            ...(cameraControl !== undefined && { camera_control: cameraControl })
        };
    }
}

class BaseMotion extends WavespeedVideoRunner {
    constructor({ modelName, displayName, tier = "std", pricing = {} }) {
        super({
            modelName, provider: "wavespeed", type: "motion", maxReferences: 2,
            capabilities: [CAPS.TEXT, CAPS.IMAGE, CAPS.VIDEO_REF, CAPS.OUTPUTS_VIDEO],
            displayName, category: "video", tier, pricing,
            modes: ["motion", "v2v"],
        });
    }
    adapt(form) {
        const refs = form.references || [];
        return {
            prompt:        form.prompt,
            duration:      parseFloat(form.duration) || 10,
            resolution:    form.resolution,
            image:         form.image || form.image_base64 || refs.find(r => r.role === "start" || r.role === "normal" || r.role === "mc_image")?.url || null,
            endImage:      refs.find(r => r.role === "end")?.url || null,
            video:         form.video || form.video_base64 || refs.find(r => r.role === "video"  || r.role === "mc_video" || r.type === "video" || r.type === "video_url")?.url  || null,
            cameraControl: form.cameraControl,
        };
    }
    toPayload({ prompt, image, endImage, video, duration, resolution, cameraControl }) {
        return {
            image, video,
            end_image:             endImage,
            prompt:                prompt   || "",
            duration:              duration || 10,
            mode:                  "pro",
            character_orientation: "video",
            ...(resolution    !== undefined && { resolution }),
            ...(cameraControl  !== undefined && { camera_control: cameraControl })
        };
    }
}

class BaseRichI2v extends WavespeedVideoRunner {
    constructor({ modelName, displayName, tier = "std", pricing = {} }) {
        super({
            modelName, provider: "wavespeed", type: "i2v", maxReferences: 1,
            capabilities: [
                CAPS.TEXT, CAPS.IMAGE, CAPS.END_IMAGE,
                CAPS.SOUND, CAPS.CFG_SCALE, CAPS.NEGATIVE, CAPS.OUTPUTS_VIDEO,
            ],
            displayName, category: "video", tier, pricing,
            modes: ["t2v", "i2v", "i2v_se"],
        });
    }
    adapt(form) {
        const refs = form.references || [];
        return {
            prompt:         form.prompt,
            ratio:          form.ratio,
            resolution:     form.resolution,
            duration:       parseFloat(form.duration) || 5,
            image:          form.image || form.image_base64 || refs.find(r => r.role === "start" || r.role === "normal" || r.role === "mc_image")?.url || null,
            endImage:       refs.find(r => r.role === "end")?.url || undefined,
            sound:          form.sound,
            cfgScale:       form.cfgScale,
            negativePrompt: form.negativePrompt,
            cameraControl:  form.cameraControl,
        };
    }
    toPayload({ prompt, image, endImage, ratio, resolution, duration, sound, cfgScale, negativePrompt, cameraControl }) {
        return {
            prompt, image,
            aspect_ratio: ratio    || "16:9",
            duration:     duration || 5,
            ...(resolution     !== undefined && { resolution     }),
            ...(endImage       !== undefined && { end_image:       endImage       }),
            ...(sound          !== undefined && { sound                           }),
            ...(cfgScale       !== undefined && { cfg_scale:       cfgScale       }),
            ...(negativePrompt !== undefined && { negative_prompt: negativePrompt }),
            ...(cameraControl  !== undefined && { camera_control:  cameraControl  }),
        };
    }
}

class BaseV3T2v extends WavespeedVideoRunner {
    constructor({ modelName, displayName, tier = "std", pricing = {} }) {
        super({
            modelName, provider: "wavespeed", type: "t2v", maxReferences: 0,
            capabilities: [CAPS.TEXT, CAPS.CFG_SCALE, CAPS.NEGATIVE, CAPS.MULTI_PROMPT, CAPS.SOUND, CAPS.OUTPUTS_VIDEO],
            displayName, category: "video", tier, pricing,
            modes: ["t2v"],
            minDuration: 3, maxDuration: 15,
        });
    }
    adapt(form) {
        return {
            prompt:         form.prompt,
            ratio:          form.ratio,
            resolution:     form.resolution,
            duration:       parseFloat(form.duration) || 5,
            cfgScale:       form.cfgScale,
            negativePrompt: form.negativePrompt,
            multiPrompt:    form.multiPrompt,
            sound:          form.sound,
        };
    }
    toPayload({ prompt, ratio, resolution, duration, cfgScale, negativePrompt, multiPrompt, sound }) {
        return {
            prompt,
            aspect_ratio: ratio    || "16:9",
            duration:     duration || 5,
            ...(resolution     !== undefined && { resolution     }),
            ...(cfgScale       !== undefined && { cfg_scale:       cfgScale       }),
            ...(negativePrompt !== undefined && { negative_prompt: negativePrompt }),
            ...(multiPrompt    !== undefined && { multi_prompt:    multiPrompt    }),
            ...(sound          !== undefined && { sound                           }),
        };
    }
}

class BaseV3I2v extends WavespeedVideoRunner {
    constructor({ modelName, displayName, tier = "std", pricing = {} }) {
        super({
            modelName, provider: "wavespeed", type: "i2v", maxReferences: 1,
            capabilities: [
                CAPS.TEXT, CAPS.IMAGE, CAPS.END_IMAGE, CAPS.SOUND,
                CAPS.CFG_SCALE, CAPS.NEGATIVE, CAPS.MULTI_PROMPT, CAPS.OUTPUTS_VIDEO,
            ],
            displayName, category: "video", tier, pricing,
            modes: ["t2v", "i2v", "i2v_se", "motion"],
            minDuration: 3, maxDuration: 15,
        });
    }
    adapt(form) {
        const refs = form.references || [];
        return {
            prompt:         form.prompt,
            ratio:          form.ratio,
            resolution:     form.resolution,
            duration:       parseFloat(form.duration) || 5,
            image:          form.image || form.image_base64 || refs.find(r => r.role === "start" || r.role === "normal" || r.role === "mc_image")?.url || null,
            endImage:       refs.find(r => r.role === "end")?.url || undefined,
            sound:          form.sound,
            cfgScale:       form.cfgScale,
            negativePrompt: form.negativePrompt,
            multiPrompt:    form.multiPrompt,
            cameraControl:  form.cameraControl,
        };
    }
    toPayload({ prompt, image, endImage, ratio, resolution, duration, sound, cfgScale, negativePrompt, multiPrompt, cameraControl }) {
        return {
            prompt, image,
            aspect_ratio: ratio    || "16:9",
            duration:     duration || 5,
            ...(resolution     !== undefined && { resolution     }),
            ...(endImage       !== undefined && { end_image:       endImage       }),
            ...(sound          !== undefined && { sound                           }),
            ...(cfgScale       !== undefined && { cfg_scale:       cfgScale       }),
            ...(negativePrompt !== undefined && { negative_prompt: negativePrompt }),
            ...(multiPrompt    !== undefined && { multi_prompt:    multiPrompt    }),
            ...(cameraControl  !== undefined && { camera_control:  cameraControl  }),
        };
    }
}

class BaseO3I2v extends WavespeedVideoRunner {
    constructor({ modelName, displayName, tier = "std", pricing = {} }) {
        super({
            modelName, provider: "wavespeed", type: "i2v", maxReferences: 1,
            capabilities: [CAPS.TEXT, CAPS.IMAGE, CAPS.END_IMAGE, CAPS.SOUND, CAPS.OUTPUTS_VIDEO],
            displayName, category: "video", tier, pricing,
            modes: ["t2v", "i2v", "i2v_se", "r2v"],
            minDuration: 3, maxDuration: 15,
        });
    }
    adapt(form) {
        const refs = form.references || [];
        return {
            prompt:   form.prompt,
            ratio:    form.ratio,
            resolution: form.resolution,
            duration: parseFloat(form.duration) || 5,
            image:    form.image || form.image_base64 || refs.find(r => r.role === "start" || r.role === "normal")?.url || null,
            endImage: refs.find(r => r.role === "end")?.url || undefined,
            sound:    form.sound,
        };
    }
    toPayload({ prompt, image, endImage, ratio, resolution, duration, sound }) {
        return {
            prompt, image,
            aspect_ratio: ratio    || "16:9",
            duration:     duration || 5,
            ...(resolution !== undefined && { resolution }),
            ...(endImage !== undefined && { end_image: endImage }),
            ...(sound    !== undefined && { sound               }),
        };
    }
}

class BaseO3R2v extends WavespeedVideoRunner {
    constructor({ modelName, displayName, tier = "std", pricing = {} }) {
        super({
            modelName, provider: "wavespeed", type: "r2v", maxReferences: 7,
            capabilities: [CAPS.TEXT, CAPS.MULTI_IMAGE, CAPS.VIDEO_REF, CAPS.SOUND, CAPS.OUTPUTS_VIDEO],
            displayName, category: "video", tier, pricing,
            modes: ["r2v"],
            minDuration: 3, maxDuration: 15,
        });
    }
    adapt(form) {
        const refs  = form.references || [];
        const video = refs.find(r => r.role === "video" || r.type === "video")?.url;
        const ordered = [
            ...refs.filter(r => r.role === "subject"),
            ...refs.filter(r => r.role === "scene"),
            ...refs.filter(r => r.role === "style"),
            ...refs.filter(r => !["subject","scene","style","video"].includes(r.role)),
        ].filter(r => r.role !== "video");
        const images = ordered.slice(0, video ? 4 : 7).map(r => r.url);
        return {
            prompt:            resolvePrompt(form.prompt, refs),
            ratio:             form.ratio,
            resolution:        form.resolution,
            duration:          parseFloat(form.duration) || 5,
            images, video,
            sound:             form.sound,
            keepOriginalSound: video ? form.keepOriginalSound : undefined,
        };
    }
    toPayload({ prompt, images, ratio, resolution, duration, sound, keepOriginalSound, video }) {
        return {
            prompt:       prompt || "",
            images:       (images || []).map(r => typeof r === "string" ? r : r.url),
            aspect_ratio: ratio    || "16:9",
            duration:     duration || 5,
            ...(resolution        !== undefined && { resolution                             }),
            ...(video             !== undefined && { video                                  }),
            ...(sound             !== undefined && { sound                                  }),
            ...(keepOriginalSound !== undefined && { keep_original_sound: keepOriginalSound }),
        };
    }
}

class BaseO3T2v extends WavespeedVideoRunner {
    constructor({ modelName, displayName, tier = "std", pricing = {} }) {
        super({
            modelName, provider: "wavespeed", type: "t2v", maxReferences: 0,
            capabilities: [CAPS.TEXT, CAPS.SOUND, CAPS.OUTPUTS_VIDEO],
            displayName, category: "video", tier, pricing,
            modes: ["t2v"],
            minDuration: 3, maxDuration: 15,
        });
    }
    adapt(form) {
        return {
            prompt:   form.prompt,
            ratio:    form.ratio,
            resolution: form.resolution,
            duration: parseFloat(form.duration) || 5,
            sound:    form.sound,
        };
    }
    toPayload({ prompt, ratio, resolution, duration, sound }) {
        return {
            prompt,
            aspect_ratio: ratio    || "16:9",
            duration:     duration || 5,
            ...(resolution !== undefined && { resolution }),
            ...(sound    !== undefined && { sound }),
        };
    }
}

class BaseO3V2v extends WavespeedVideoRunner {
    constructor({ modelName, displayName, tier = "std", pricing = {} }) {
        super({
            modelName, provider: "wavespeed", type: "v2v", maxReferences: 7,
            capabilities: [CAPS.TEXT, CAPS.VIDEO_REF, CAPS.MULTI_IMAGE, CAPS.OUTPUTS_VIDEO],
            displayName, category: "video", tier, pricing,
            modes: ["v2v"],
        });
    }
    adapt(form) {
        const refs  = form.references || [];
        const video = form.video || form.video_base64 || refs.find(r => r.role === "video" || r.type === "video")?.url || null;
        const images = refs.filter(r => r.role !== "video").map(r => r.url);
        
        return {
            prompt:            resolvePrompt(form.prompt, refs),
            video,
            images,
            keepOriginalSound: form.keepOriginalSound,
            cameraControl:     form.cameraControl,
        };
    }
    toPayload({ prompt, video, images, keepOriginalSound, cameraControl }) {
        return {
            prompt: prompt || "",
            video,
            ...(images && images.length > 0 && { images }),
            ...(keepOriginalSound !== undefined && { keep_original_sound: keepOriginalSound }),
            ...(cameraControl     !== undefined && { camera_control:      cameraControl     }),
        };
    }
}

// ─── Unique Class ─────────────────────────────────────────────────────────────
class KlingV21ProStartEnd extends WavespeedVideoRunner {
    constructor() {
        super({
            modelName:      "kwaivgi/kling-v2.1-i2v-pro-start-end-frame",
            provider:       "wavespeed",
            type:           "i2v",
            maxReferences:  2,
            capabilities:   [CAPS.TEXT, CAPS.IMAGE, CAPS.END_IMAGE, CAPS.OUTPUTS_VIDEO],
            displayName:    "Kling v2.1 Pro Keyframes",
            description:    "Precise start-to-end keyframe controlled generation",
            category:       "video",
            tier:           "pro",
            modes:          ["i2v_se"],
            pricing:        { "5s": 0.35, "10s": 0.70 },
            tags:           ["keyframes", "start-end", "precise"],
            minDuration:    5,
            maxDuration:    10,
        });
    }
    adapt(form) {
        const refs = form.references || [];
        return {
            prompt:   form.prompt,
            ratio:    form.ratio,
            resolution: form.resolution,
            duration: parseFloat(form.duration) || 5,
            image:    form.image || form.image_base64 || refs.find(r => r.role === "start" || r.role === "normal")?.url || null,
            endImage: refs.find(r => r.role === "end")?.url || null,
        };
    }
    toPayload({ prompt, image, endImage, ratio, resolution, duration }) {
        return {
            prompt:       prompt || "",
            image,
            end_image:    endImage,
            aspect_ratio: ratio    || "16:9",
            duration:     duration || 5,
            ...(resolution !== undefined && { resolution }),
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

const V2_PRICING     = { "5s": 0.14,  "10s": 0.28  };
const V2P_PRICING    = { "5s": 0.35,  "10s": 0.70  };
const V3_PRICING     = { "3s": 0.252, "5s": 0.42,  "10s": 0.84,  "15s": 1.26 };
const V3P_PRICING    = { "3s": 0.336, "5s": 0.56,  "10s": 1.12,  "15s": 1.68 };
const O3_PRICING     = { "5s": 0.84,  "10s": 1.68  };
const O3P_PRICING    = { "5s": 1.12,  "10s": 2.24  };

// Internal Mode-Specific Instances (Hidden)
const v26StdT2v    = new BaseSimpleT2v({ modelName: "kwaivgi/kling-v2.6-std/text-to-video",        displayName: "Kling v2.6",     tier: "std", pricing: V2_PRICING, hidden: true  });
const v26StdI2v    = new BaseSimpleI2v({ modelName: "kwaivgi/kling-v2.6-std/image-to-video",       displayName: "Kling v2.6",     tier: "std", pricing: V2_PRICING, hidden: true  });
const v26StdMotion = new BaseMotion   ({ modelName: "kwaivgi/kling-v2.6-std/motion-control",         displayName: "Kling v2.6",     tier: "std", pricing: V2_PRICING, hidden: true  });

const v26ProT2v    = new BaseSimpleT2v({ modelName: "kwaivgi/kling-v2.6-pro/text-to-video",    displayName: "Kling v2.6 Pro", tier: "pro", pricing: V2P_PRICING, hidden: true });
const v26ProI2v    = new BaseRichI2v  ({ modelName: "kwaivgi/kling-v2.6-pro/image-to-video",   displayName: "Kling v2.6 Pro", tier: "pro", pricing: V2P_PRICING, hidden: true });
const v26ProMotion = new BaseMotion   ({ modelName: "kwaivgi/kling-v2.6-pro/motion-control",         displayName: "Kling v2.6 Pro", tier: "pro", pricing: V2P_PRICING, hidden: true });

const v21ProStartEndInternal = new KlingV21ProStartEnd();
v21ProStartEndInternal.hidden = true;

const v3StdT2v    = new BaseV3T2v({ modelName: "kwaivgi/kling-v3.0-std/text-to-video",             displayName: "Kling v3.0",     tier: "std", pricing: V3_PRICING, hidden: true  });
const v3StdI2v    = new BaseV3I2v({ modelName: "kwaivgi/kling-v3.0-std/image-to-video",            displayName: "Kling v3.0",     tier: "std", pricing: V3_PRICING, hidden: true  });
const v3StdMotion = new BaseMotion({ modelName: "kwaivgi/kling-v3.0-std/motion-control",           displayName: "Kling v3.0",     tier: "std", pricing: V3_PRICING, hidden: true  });

const v3ProT2v    = new BaseV3T2v({ modelName: "kwaivgi/kling-v3.0-pro/text-to-video",             displayName: "Kling v3.0 Pro", tier: "pro", pricing: V3P_PRICING, hidden: true });
const v3ProI2v    = new BaseV3I2v({ modelName: "kwaivgi/kling-v3.0-pro/image-to-video",            displayName: "Kling v3.0 Pro", tier: "pro", pricing: V3P_PRICING, hidden: true });
const v3ProMotion = new BaseMotion({ modelName: "kwaivgi/kling-v3.0-pro/motion-control",           displayName: "Kling v3.0 Pro", tier: "pro", pricing: V3P_PRICING, hidden: true });

const o3StdT2v_int = new BaseO3T2v({ modelName: "kwaivgi/kling-video-o3-std/text-to-video",           displayName: "Kling O3",       tier: "std", pricing: O3_PRICING, hidden: true  });
const o3StdI2v_int = new BaseO3I2v({ modelName: "kwaivgi/kling-video-o3-std/image-to-video",           displayName: "Kling O3",       tier: "std", pricing: O3_PRICING, hidden: true  });
const o3StdR2v_int = new BaseO3R2v({ modelName: "kwaivgi/kling-video-o3-std/reference-to-video",       displayName: "Kling O3",       tier: "std", pricing: O3_PRICING, hidden: true  });
const o3StdV2v_int = new BaseO3V2v({ modelName: "kwaivgi/kling-video-o3-std/video-edit",             displayName: "Kling O3",       tier: "std", pricing: O3_PRICING, hidden: true  });

const o3ProT2v_int = new BaseO3T2v({ modelName: "kwaivgi/kling-video-o3-pro/text-to-video",           displayName: "Kling O3 Pro",   tier: "pro", pricing: O3P_PRICING, hidden: true });
const o3ProI2v_int = new BaseO3I2v({ modelName: "kwaivgi/kling-video-o3-pro/image-to-video",           displayName: "Kling O3 Pro",   tier: "pro", pricing: O3P_PRICING, hidden: true });
const o3ProR2v_int = new BaseO3R2v({ modelName: "kwaivgi/kling-video-o3-pro/reference-to-video",       displayName: "Kling O3 Pro",   tier: "pro", pricing: O3P_PRICING, hidden: true });
const o3ProV2v_int = new BaseO3V2v({ modelName: "kwaivgi/kling-video-o3-pro/video-edit",             displayName: "Kling O3 Pro",   tier: "pro", pricing: O3P_PRICING, hidden: true });

// Final Family Exports
export const v26Std = new ModelFamily("Kling v2.6", {
    "t2v":    v26StdT2v,
    "i2v":    v26StdI2v,
    "i2v_se": v26StdMotion,
    "motion": v26StdMotion,
    "v2v":    v26StdMotion
}, { pricing: V2_PRICING, tier: "std" });

export const v26Pro = new ModelFamily("Kling v2.6 Pro", {
    "t2v":    v26ProT2v,
    "i2v":    v26ProI2v,
    "i2v_se": v26ProMotion, // Keyframes mode
    "motion": v26ProMotion,
    "v2v":    v26ProMotion
}, { pricing: V2P_PRICING, tier: "pro" });

export const v21ProStartEnd = new ModelFamily("Kling v2.1 Pro Keyframes", {
    "i2v_se": v21ProStartEndInternal
}, { pricing: V2P_PRICING, tier: "pro" });

export const v3Std = new ModelFamily("Kling v3.0", {
    "t2v":    v3StdT2v,
    "i2v":    v3StdI2v,
    "i2v_se": v3StdI2v,
    "motion": v3StdMotion,
    "v2v":    v3StdMotion
}, { pricing: V3_PRICING, tier: "std" });

export const v3Pro = new ModelFamily("Kling v3.0 Pro", {
    "t2v":    v3ProT2v,
    "i2v":    v3ProI2v,
    "i2v_se": v3ProI2v,
    "motion": v3ProMotion,
    "v2v":    v3ProMotion
}, { pricing: V3P_PRICING, tier: "pro" });

export const o3Std = new ModelFamily("Kling O3", {
    "t2v": o3StdT2v_int,
    "i2v": o3StdI2v_int,
    "r2v": o3StdR2v_int,
    "v2v": o3StdV2v_int
}, { pricing: O3_PRICING, tier: "std" });

export const o3Pro = new ModelFamily("Kling O3 Pro", {
    "t2v": o3ProT2v_int,
    "i2v": o3ProI2v_int,
    "r2v": o3ProR2v_int,
    "v2v": o3ProV2v_int
}, { pricing: O3P_PRICING, tier: "pro" });

// Mode-Specific Variant Exports for Registry
export {
    v26StdT2v, v26StdI2v, v26StdMotion,
    v26ProT2v, v26ProI2v, v26ProMotion,
    v21ProStartEndInternal,
    v3StdT2v, v3StdI2v, v3StdMotion,
    v3ProT2v, v3ProI2v, v3ProMotion,
    o3StdT2v_int, o3StdI2v_int, o3StdR2v_int, o3StdV2v_int,
    o3ProT2v_int, o3ProI2v_int, o3ProR2v_int, o3ProV2v_int
};
