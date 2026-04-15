import { WavespeedImageRunner } from "../WavespeedImageRunner.js";
import { CAPS                 } from "#core/capabilities.js";

// ─── Helper ───────────────────────────────────────────────────────────────────
function sizeFromRatio(ratio = "1:1") {
    const map = {
        "1:1":  { width: 1024, height: 1024 },
        "16:9": { width: 1344, height: 768  },
        "9:16": { width: 768,  height: 1344 },
        "4:3":  { width: 1152, height: 896  },
        "3:4":  { width: 896,  height: 1152 },
        "3:2":  { width: 1216, height: 832  },
        "2:3":  { width: 832,  height: 1216 },
        "21:9": { width: 1536, height: 640  },
    };
    return map[ratio] || map["1:1"];
}

// ─── Base T2i ─────────────────────────────────────────────────────────────────
class BaseFlux2T2i extends WavespeedImageRunner {
    adapt(form) {
        const { width, height } = sizeFromRatio(form.ratio || form.aspectRatio);
        return {
            prompt:      form.prompt,
            aspectRatio: form.ratio || form.aspectRatio || "1:1",
            width:       form.width  || width,
            height:      form.height || height,
            seed:        form.seed   ?? -1,
        };
    }
    toPayload({ prompt, aspectRatio, seed }) {
        return {
            prompt,
            aspect_ratio: aspectRatio || "1:1",
            seed:         seed ?? -1,
        };
    }
}

// ─── Base Edit ────────────────────────────────────────────────────────────────
class BaseFlux2Edit extends WavespeedImageRunner {
    adapt(form) {
        const refs = form.references || [];
        const { width, height } = sizeFromRatio(form.ratio || form.aspectRatio);
        return {
            prompt:      form.prompt,
            images:      refs.map(r => r.url || r).filter(Boolean),
            width:       form.width  || width,
            height:      form.height || height,
            seed:        form.seed ?? -1,
        };
    }
    toPayload({ prompt, images, width, height, seed }) {
        return {
            prompt,
            images,
            size: `${width}*${height}`,
            seed: seed ?? -1,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// FLUX 2 TURBO
// Speed-optimized — real-time workflows, ads, social posts
// t2i: wavespeed-ai/flux-2-turbo/text-to-image
// edit: wavespeed-ai/flux-2-turbo/edit (1–3 images)
// ═══════════════════════════════════════════════════════════════════════════

class Flux2TurboT2i extends BaseFlux2T2i {
    constructor() {
        super({
            modelName:     "wavespeed-ai/flux-2-turbo/text-to-image",
            provider:      "wavespeed",
            type:          "t2i",
            maxReferences: 0,
            capabilities:  [CAPS.TEXT, CAPS.OUTPUTS_IMAGE],
            displayName:   "Flux 2 Turbo",
            category:      "image",
            tier:          "std",
            tags:          ["ultra-fast", "real-time", "photoreal", "typography"],
            pricing:       { image: 2 },
            modes:         ["t2i"],
        });
    }
}

class Flux2TurboEdit extends BaseFlux2Edit {
    constructor() {
        super({
            modelName:     "wavespeed-ai/flux-2-turbo/edit",
            provider:      "wavespeed",
            type:          "i2i",
            maxReferences: 3,
            capabilities:  [CAPS.TEXT, CAPS.MULTI_IMAGE, CAPS.OUTPUTS_IMAGE],
            displayName:   "Flux 2 Turbo Edit",
            category:      "image",
            tier:          "std",
            tags:          ["ultra-fast", "edit", "composition-preserving"],
            pricing:       { image: 3 },
            modes:         ["i2i"],
            hidden:        true,
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// FLUX 2 FLEX
// Sweet spot quality/flexibility — best price-to-performance
// Stylistic range: product photos → stylized art
// Configurable: steps + guidance_scale
// t2i: wavespeed-ai/flux-2-flex/text-to-image
// edit: wavespeed-ai/flux-2-flex/edit
// ═══════════════════════════════════════════════════════════════════════════

class Flux2FlexT2i extends BaseFlux2T2i {
    constructor() {
        super({
            modelName:     "wavespeed-ai/flux-2-flex/text-to-image",
            provider:      "wavespeed",
            type:          "t2i",
            maxReferences: 0,
            capabilities:  [CAPS.TEXT, CAPS.CFG_SCALE, CAPS.OUTPUTS_IMAGE],
            displayName:   "Flux 2 Flex",
            category:      "image",
            tier:          "std",
            tags:          ["creative", "versatile", "best-value", "lora-ready"],
            pricing:       { image: 3 },
            modes:         ["t2i"],
        });
    }

    adapt(form) {
        return {
            ...super.adapt(form),
            guidanceScale: form.guidanceScale || 3.5,
            steps:         form.steps         || 28,
        };
    }

    toPayload({ prompt, aspectRatio, guidanceScale, steps, seed }) {
        return {
            prompt,
            aspect_ratio:   aspectRatio   || "1:1",
            guidance_scale: guidanceScale || 3.5,
            steps:          steps         || 28,
            seed:           seed ?? -1,
        };
    }
}

class Flux2FlexEdit extends BaseFlux2Edit {
    constructor() {
        super({
            modelName:     "wavespeed-ai/flux-2-flex/edit",
            provider:      "wavespeed",
            type:          "i2i",
            maxReferences: 3,
            capabilities:  [CAPS.TEXT, CAPS.MULTI_IMAGE, CAPS.CFG_SCALE, CAPS.OUTPUTS_IMAGE],
            displayName:   "Flux 2 Flex Edit",
            category:      "image",
            tier:          "std",
            tags:          ["creative", "versatile", "edit", "best-value"],
            pricing:       { image: 4 },
            modes:         ["i2i"],
            hidden:        true,
        });
    }

    adapt(form) {
        return {
            ...super.adapt(form),
            guidanceScale: form.guidanceScale || 3.5,
        };
    }

    toPayload({ prompt, images, width, height, guidanceScale, seed }) {
        return {
            prompt,
            images,
            size:           `${width}*${height}`,
            guidance_scale: guidanceScale || 3.5,
            seed:           seed ?? -1,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// FLUX 2 MAX
// Highest quality Flux 2 — 1168 LM Arena score
// Hero assets, marketing materials, client-facing content
// t2i: wavespeed-ai/flux-2-max/text-to-image
// edit: wavespeed-ai/flux-2-max/edit
// ═══════════════════════════════════════════════════════════════════════════

class Flux2MaxT2i extends BaseFlux2T2i {
    constructor() {
        super({
            modelName:     "wavespeed-ai/flux-2-max/text-to-image",
            provider:      "wavespeed",
            type:          "t2i",
            maxReferences: 0,
            capabilities:  [CAPS.TEXT, CAPS.CFG_SCALE, CAPS.OUTPUTS_IMAGE],
            displayName:   "Flux 2 Max",
            category:      "image",
            tier:          "pro",
            tags:          ["pro", "max-quality", "hero-assets", "cinematic"],
            pricing:       { image: 8 },
            modes:         ["t2i"],
        });
    }

    adapt(form) {
        return {
            ...super.adapt(form),
            guidanceScale: form.guidanceScale || 3.5,
        };
    }

    toPayload({ prompt, aspectRatio, guidanceScale, seed }) {
        return {
            prompt,
            aspect_ratio:   aspectRatio   || "1:1",
            guidance_scale: guidanceScale || 3.5,
            seed:           seed ?? -1,
        };
    }
}

class Flux2MaxEdit extends BaseFlux2Edit {
    constructor() {
        super({
            modelName:     "wavespeed-ai/flux-2-max/edit",
            provider:      "wavespeed",
            type:          "i2i",
            maxReferences: 3,
            capabilities:  [CAPS.TEXT, CAPS.MULTI_IMAGE, CAPS.CFG_SCALE, CAPS.OUTPUTS_IMAGE],
            displayName:   "Flux 2 Max Edit",
            category:      "image",
            tier:          "pro",
            tags:          ["pro", "max-quality", "edit", "detail-critical"],
            pricing:       { image: 10 },
            modes:         ["i2i"],
            hidden:        true,
        });
    }

    adapt(form) {
        return {
            ...super.adapt(form),
            guidanceScale: form.guidanceScale || 3.5,
        };
    }

    toPayload({ prompt, images, width, height, guidanceScale, seed }) {
        return {
            prompt,
            images,
            size:           `${width}*${height}`,
            guidance_scale: guidanceScale || 3.5,
            seed:           seed ?? -1,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// FLUX KONTEXT MAX
// 12B rectified flow — max performance editing + t2i
// Best prompt adherence + typography + character consistency
// t2i:   wavespeed-ai/flux-kontext-max/text-to-image
// edit:  wavespeed-ai/flux-kontext-max          (single image)
// multi: wavespeed-ai/flux-kontext-max/multi    (up to 5 refs)
// ═══════════════════════════════════════════════════════════════════════════

class FluxKontextMaxT2i extends BaseFlux2T2i {
    constructor() {
        super({
            modelName:     "wavespeed-ai/flux-kontext-max/text-to-image",
            provider:      "wavespeed",
            type:          "t2i",
            maxReferences: 0,
            capabilities:  [CAPS.TEXT, CAPS.CFG_SCALE, CAPS.OUTPUTS_IMAGE],
            displayName:   "Flux Kontext Max",
            category:      "image",
            tier:          "pro",
            tags:          ["pro", "kontext", "cinematic", "typography", "prompt-faithful"],
            pricing:       { image: 8 },
            modes:         ["t2i"],
        });
    }

    adapt(form) {
        return {
            prompt:        form.prompt,
            aspectRatio:   form.ratio || form.aspectRatio || "1:1",
            guidanceScale: form.guidanceScale || 3.5,
            seed:          form.seed ?? -1,
        };
    }

    toPayload({ prompt, aspectRatio, guidanceScale, seed }) {
        return {
            prompt,
            aspect_ratio:   aspectRatio   || "1:1",
            guidance_scale: guidanceScale || 3.5,
            seed:           seed ?? -1,
        };
    }
}

class FluxKontextMaxEdit extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:     "wavespeed-ai/flux-kontext-max",
            provider:      "wavespeed",
            type:          "i2i",
            maxReferences: 1,
            capabilities:  [CAPS.TEXT, CAPS.IMAGE, CAPS.CFG_SCALE, CAPS.OUTPUTS_IMAGE],
            displayName:   "Flux Kontext Max Edit",
            category:      "image",
            tier:          "pro",
            tags:          ["pro", "kontext", "character-consistency", "edit"],
            pricing:       { image: 8 },
            modes:         ["i2i"],
            hidden:        true,
        });
    }

    adapt(form) {
        const refs = form.references || [];
        const { width, height } = sizeFromRatio(form.ratio || form.aspectRatio);
        return {
            prompt:        form.prompt,
            image:         refs[0]?.url || refs[0] || null,
            width:         form.width  || width,
            height:        form.height || height,
            guidanceScale: form.guidanceScale || 3.5,
            seed:          form.seed ?? -1,
        };
    }

    toPayload({ prompt, image, width, height, guidanceScale, seed }) {
        return {
            prompt,
            image,
            size:           `${width}*${height}`,
            guidance_scale: guidanceScale || 3.5,
            seed:           seed ?? -1,
        };
    }
}

class FluxKontextMaxMulti extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:     "wavespeed-ai/flux-kontext-max/multi",
            provider:      "wavespeed",
            type:          "i2i",
            maxReferences: 5,
            capabilities:  [CAPS.TEXT, CAPS.MULTI_IMAGE, CAPS.CFG_SCALE, CAPS.OUTPUTS_IMAGE],
            displayName:   "Flux Kontext Max Multi",
            category:      "image",
            tier:          "pro",
            tags:          ["pro", "kontext", "multi-ref", "character-consistency", "cinematic"],
            pricing:       { image: 10 },
            modes:         ["i2i"],
            hidden:        true,
        });
    }

    adapt(form) {
        const refs = form.references || [];
        const { width, height } = sizeFromRatio(form.ratio || form.aspectRatio);
        return {
            prompt:        form.prompt,
            images:        refs.map(r => r.url || r).filter(Boolean),
            width:         form.width  || width,
            height:        form.height || height,
            guidanceScale: form.guidanceScale || 3.5,
            seed:          form.seed ?? -1,
        };
    }

    toPayload({ prompt, images, width, height, guidanceScale, seed }) {
        return {
            prompt,
            images,
            size:           `${width}*${height}`,
            guidance_scale: guidanceScale || 3.5,
            seed:           seed ?? -1,
        };
    }
}



class Flux2ProT2i extends BaseFlux2T2i {
    constructor() {
        super({
            modelName:     "wavespeed-ai/flux-2-pro/text-to-image",
            provider:      "wavespeed",
            type:          "t2i",
            maxReferences: 0,
            capabilities:  [CAPS.TEXT, CAPS.OUTPUTS_IMAGE],
            displayName:   "Flux 2 Pro",
            category:      "image",
            tier:          "pro",
            tags:          ["pro", "production", "campaign-ready", "brand-safe"],
            pricing:       { image: 5 },
            modes:         ["t2i"],
        });
    }

    // ← يرث adapt من BaseFlux2T2i مباشرة — ما يحتاجش override

    toPayload({ prompt, aspectRatio, seed }) {
        return {
            prompt,
            aspect_ratio: aspectRatio || "1:1",
            seed:         seed ?? -1,
            // ❌ guidance_scale → ما تحطوش
            // ❌ steps          → ما تحطوش
        };
    }
}

class Flux2ProEdit extends BaseFlux2Edit {
    constructor() {
        super({
            modelName:     "wavespeed-ai/flux-2-pro/edit",
            provider:      "wavespeed",
            type:          "i2i",
            maxReferences: 3,
            capabilities:  [CAPS.TEXT, CAPS.MULTI_IMAGE, CAPS.OUTPUTS_IMAGE],
            displayName:   "Flux 2 Pro Edit",
            category:      "image",
            tier:          "pro",
            tags:          ["pro", "production", "high-fidelity", "brand-safe"],
            pricing:       { image: 7 },
            modes:         ["i2i"],
            hidden:        true,
        });
    }

    // ← يرث adapt من BaseFlux2Edit — ما يحتاجش override

    toPayload({ prompt, images, width, height, seed }) {
        return {
            prompt,
            images,
            size: `${width}*${height}`,
            seed: seed ?? -1,
            // ❌ guidance_scale → ما تحطوش
            // ❌ steps          → ما تحطوش
        };
    }
}

// ─── أضيف للـ exports ──────────────────────────────────────────────────────────
export const proT2i  = new Flux2ProT2i();
export const proEdit = new Flux2ProEdit();
// ─── Exports ──────────────────────────────────────────────────────────────────

// Flux 2 Turbo
export const turboT2i        = new Flux2TurboT2i();
export const turboEdit       = new Flux2TurboEdit();

// Flux 2 Flex
export const flexT2i         = new Flux2FlexT2i();
export const flexEdit        = new Flux2FlexEdit();

// Flux 2 Max
export const maxT2i          = new Flux2MaxT2i();
export const maxEdit         = new Flux2MaxEdit();

// Flux Kontext Max
export const kontextMaxT2i   = new FluxKontextMaxT2i();
export const kontextMaxEdit  = new FluxKontextMaxEdit();
export const kontextMaxMulti = new FluxKontextMaxMulti();
