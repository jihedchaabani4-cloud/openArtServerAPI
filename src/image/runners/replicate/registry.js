import { ModelGroup } from "#core/ModelGroup.js";
import * as topaz   from "./models/topaz.js";
import * as runway  from "./models/runway.js";
import { IMAGE_ICONS } from "../../utils/imageIcons.js";

export const MODELS = {
    // ─── RunwayML ─────────────────────────────────────────────────────────────
    "runway_gen4_image_replicate": new ModelGroup({
        displayName: "RunwayML Gen-4 Image",
        icon: IMAGE_ICONS.runway || IMAGE_ICONS.google,
        description: "Precise images using up to 3 reference images",
        category: "image", tier: "pro",
        pricing:  { per_image: 0.08 },
        tags:     ["runwayml", "gen-4", "professional", "replicate"],
        support:  { 
            ratio: ["1:1", "16:9", "9:16", "4:3", "3:4"], 
            quality: ["720p", "1080p", "1k", "2k"],
            references: { min: 0, max: 3 } 
        },
        t2i:      runway.gen4Image,
        i2i:      runway.gen4Image,
    }),
    "runway_gen4_image_turbo_replicate": new ModelGroup({
        displayName: "RunwayML Gen-4 Image Turbo",
        icon: IMAGE_ICONS.runway || IMAGE_ICONS.google,
        description: "2.5x faster than Gen-4 Image with high fidelity",
        category: "image", tier: "pro",
        pricing:  { per_image: 0.05 },
        tags:     ["runwayml", "gen-4", "fast", "turbo", "replicate"],
        support:  { 
            ratio: ["1:1", "16:9", "9:16", "4:3", "3:4"], 
            quality: ["720p", "1080p", "1k", "2k"],
            references: { min: 0, max: 3 } 
        },
        t2i:      runway.gen4ImageTurbo,
        i2i:      runway.gen4ImageTurbo,
    }),

    "topaz_image_upscale": new ModelGroup({
        displayName: "Topaz Image Upscale",
        tier: "pro",
        pricing: { per_image: 0.15 },
        tags: ["upscale", "topaz"],
        support: { upscale: true },
        t2i: topaz.imageUpscale,
        i2i: topaz.imageUpscale,
    }),
};
