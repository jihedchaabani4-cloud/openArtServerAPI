/**
 * ─── SDXL Image Registry ──────────────────────────────────────────────────────
 * Key format: <model>_sdxl
 */

import * as sdxl from "./models/sdxl.js";
import { IMAGE_ICONS } from "../../utils/imageIcons.js";

export const MODELS = {
    "sdxl_sdxl": {
        displayName: "SDXL Ngrok",
        icon: IMAGE_ICONS.cinema, // SDXL usually uses cinema/stability icon
        description: "Stable Diffusion XL (local)",
        category: "image", tier: "std",
        pricing:  { per_image: 0.01 },
        tags:     ["sdxl", "stable-diffusion"],
        support:  { ratio: ["1:1", "16:9", "9:16"] },
        t2i: sdxl.ngrok,  // sdxl-ngrok
    },
};
