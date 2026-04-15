/**
 * ─── Fal.ai Image Registry ────────────────────────────────────────────────────
 * Key format: <model>_fal
 */

import * as flux from "./models/flux.js";
import { IMAGE_ICONS } from "../../utils/imageIcons.js";

export const MODELS = {
    "flux_pro_fal": {
        displayName: "Flux Pro (Fal)",
        icon: IMAGE_ICONS.flux,
        description: "Fal.ai hosted Flux Pro",
        category: "image", tier: "pro",
        pricing:  { per_image: 0.10 },
        tags:     ["pro", "fal"],
        support:  { ratio: ["1:1", "16:9", "9:16", "4:3", "3:4"], references: { min: 0, max: 0 } },
        t2i: flux.pro,  // fal-ai/flux-pro
    },
};
