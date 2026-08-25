import { calculateCost } from "../models/index.js";

// ── Inlined defaults ─────────────────────────────────────────────────────────
const CAMERA_DEFAULTS     = { model: "gpt-image-2", params: { quality: "standard" } };
const LIGHTING_DEFAULTS   = { model: "gpt-image-2", params: { quality: "standard" } };
const UPSCALE_DEFAULTS    = { model: "nanobana",    params: { scale: "2" } };
const EDIT_VIDEO_DEFAULTS = { model: "kling-v3",    params: { resolution: "720p", durationSeconds: 5 } };

const SHEET_DEFAULTS = {
    CHARACTER: { model_name: "minimax",     quality: "standard" },
    LOCATION:  { model_name: "gpt-image-2", quality: "standard" },
    PRODUCT:   { model_name: "gpt-image-2", quality: "standard" },
};

function getPrice(model, op, input) {
    try {
        return parseFloat(calculateCost(model, op, input).amount);
    } catch {
        return 10;
    }
}

export const APP_PRICING = {
    camera:          getPrice(CAMERA_DEFAULTS.model, "edit", CAMERA_DEFAULTS.params),
    camera_video:    getPrice(EDIT_VIDEO_DEFAULTS.model, "text_to_video", EDIT_VIDEO_DEFAULTS.params),
    lighting:        getPrice(LIGHTING_DEFAULTS.model, "edit", LIGHTING_DEFAULTS.params),
    upscale:         getPrice(UPSCALE_DEFAULTS.model, "image_upscale", UPSCALE_DEFAULTS.params),
    character_sheet: getPrice(SHEET_DEFAULTS.CHARACTER.model_name, "text_to_image", { quality: SHEET_DEFAULTS.CHARACTER.quality }),
    location_sheet:  getPrice(SHEET_DEFAULTS.LOCATION.model_name, "text_to_image", { quality: SHEET_DEFAULTS.LOCATION.quality }),
    product_sheet:   getPrice(SHEET_DEFAULTS.PRODUCT.model_name, "text_to_image", { quality: SHEET_DEFAULTS.PRODUCT.quality }),
};

export const APP_CONFIGS = {
    camera: { 
        defaultModel: CAMERA_DEFAULTS.model, 
        defaultParams: CAMERA_DEFAULTS.params 
    },
    camera_video: { 
        defaultModel: EDIT_VIDEO_DEFAULTS.model, 
        defaultParams: EDIT_VIDEO_DEFAULTS.params 
    },
    lighting: { 
        defaultModel: LIGHTING_DEFAULTS.model, 
        defaultParams: LIGHTING_DEFAULTS.params 
    },
    upscale: { 
        defaultModel: UPSCALE_DEFAULTS.model, 
        defaultParams: UPSCALE_DEFAULTS.params 
    },
    character_sheet: {
        defaultModel: SHEET_DEFAULTS.CHARACTER.model_name,
        defaultParams: { quality: SHEET_DEFAULTS.CHARACTER.quality, operation: "generated" }
    },
    location_sheet: {
        defaultModel: SHEET_DEFAULTS.LOCATION.model_name,
        defaultParams: { quality: SHEET_DEFAULTS.LOCATION.quality, operation: "generated" }
    },
    product_sheet: {
        defaultModel: SHEET_DEFAULTS.PRODUCT.model_name,
        defaultParams: { quality: SHEET_DEFAULTS.PRODUCT.quality, operation: "generated" }
    }
};
