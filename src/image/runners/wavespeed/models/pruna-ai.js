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

class PrunaTextToImage extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:     "pruna-ai/p-image/text-to-image",
            provider:      "wavespeed",
            type:          "t2i",
            maxReferences: 0,
            capabilities:  [CAPS.TEXT, CAPS.OUTPUTS_IMAGE],
            displayName:   "Pruna AI Text-to-Image",
            category:      "image",
            tier:          "pro",
            pricing:       { image: 10 },
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
            aspect_ratio: "custom",
            enable_base64_output: false,
            enable_sync_mode: false,
            height: height || 512,
            output_format: "png",
            prompt: prompt,
            seed: -1,
            width: width || 512,
        };
    }
}

class PrunaImageToImage extends WavespeedImageRunner {
    constructor() {
        super({
            modelName:     "pruna-ai/p-image/edit",
            provider:      "wavespeed",
            type:          "i2i",
            maxReferences: 5,
            capabilities:  [CAPS.TEXT, CAPS.IMAGE, CAPS.OUTPUTS_IMAGE],
            displayName:   "Pruna AI Image-to-Image",
            category:      "image",
            tier:          "pro",
            pricing:       { image: 12 },
            modes:         ["i2i"],
        });
    }

    adapt(form) {
        const refs = form.references || [];
        const images = [];
        if (form.image_url) images.push(form.image_url);
        for (const r of refs) {
            const url = r?.url || r;
            if (url && !images.includes(url)) images.push(url);
        }
        
        return {
            prompt: form.prompt,
            images: images,
            ratio: form.ratio || form.aspectRatio || "match_input_image",
        };
    }

    toPayload({ prompt, images, ratio }) {
        return {
            aspect_ratio: ratio,
            enable_base64_output: false,
            enable_sync_mode: false,
            images: images.length > 0 ? images : undefined,
            output_format: "png",
            prompt: prompt,
            seed: -1,
        };
    }
}

export const t2i = new PrunaTextToImage();
export const edit = new PrunaImageToImage();
