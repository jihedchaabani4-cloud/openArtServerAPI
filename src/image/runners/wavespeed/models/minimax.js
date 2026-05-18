import { WavespeedImageRunner } from "../WavespeedImageRunner.js";
import { CAPS                 } from "#core/capabilities.js";

// Helper to determine size from ratio if ratio is used
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

class MinimaxTextToImage extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:     "minimax/image-01/text-to-image",
            provider:      "wavespeed",
            type:          "t2i",
            maxReferences: 0,
            capabilities:  [CAPS.TEXT, CAPS.OUTPUTS_IMAGE],
            displayName:   "Minimax Text-to-Image",
            category:      "image",
            tier:          "pro",
            pricing:       { image: 10 }, // Pro price point
            modes:         ["t2i"],
        });
    }

    adapt(form) {
        const { width, height } = sizeFromRatio(form.ratio || form.aspectRatio);
        return {
            prompt: form.prompt,
            width:  form.width  || width,
            height: form.height || height,
        };
    }

    toPayload({ prompt, width, height }) {
        return {
            enable_base64_output: false,
            enable_sync_mode: false,
            num_images: 1,
            prompt: prompt,
            prompt_optimizer: false,
            size: `${width || 1024}*${height || 1024}`,
        };
    }
}

class MinimaxImageToImage extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:     "minimax/image-01/image-to-image",
            provider:      "wavespeed",
            type:          "i2i",
            maxReferences: 1,
            capabilities:  [CAPS.TEXT, CAPS.IMAGE, CAPS.OUTPUTS_IMAGE],
            displayName:   "Minimax Image-to-Image",
            category:      "image",
            tier:          "pro",
            pricing:       { image: 12 }, // Pro price point
            modes:         ["i2i"],
            hidden:        true,
        });
    }

    adapt(form) {
        const refs = form.references || [];
        const { width, height } = sizeFromRatio(form.ratio || form.aspectRatio);
        return {
            prompt: form.prompt,
            image:  form.image_url || refs[0]?.url || refs[0] || null,
            width:  form.width  || width,
            height: form.height || height,
        };
    }

    toPayload({ prompt, image, width, height }) {
        return {
            enable_base64_output: false,
            enable_sync_mode: false,
            image: image,
            num_images: 1,
            prompt: prompt,
            prompt_optimizer: false,
            size: `${width || 1024}*${height || 1024}`,
        };
    }
}

export const t2i = new MinimaxTextToImage();
export const img2img = new MinimaxImageToImage();
