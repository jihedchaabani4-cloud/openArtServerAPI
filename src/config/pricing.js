/**
 * Centralized Pricing Configuration
 * Defines the default base prices and multipliers for all generation tools and studio apps.
 *
 * NOTE: Legacy treatment classes have been removed. The default model/param
 * constants they exported are now inlined here.
 */

import { calculateImageCredits, calculateUpscaleCredits } from "../image/core/modelRouter.js";
import { calculateVideoCredits } from "../video/core/modelRouter.js";

// ── Inlined defaults (previously exported from deleted V1 Treatment classes) ──
const CAMERA_DEFAULTS    = { model: "gpt-image-2",          params: { quality: "2k", operation: "edit" } };
const LIGHTING_DEFAULTS  = { model: "gpt-image-2",          params: { quality: "2k", operation: "edit" } };
const UPSCALE_DEFAULTS   = { model: "topaz_image_upscale",   params: {} };
const EDIT_VIDEO_DEFAULTS = { model: "kling_v3",             params: { resolution: "1080p", durationSeconds: 5, operation: "edit" } };

const SHEET_DEFAULTS = {
    CHARACTER: { model_name: "minimax",       ratio: "3:2", quality: "2k", steps: 40, guidance_scale: 9.0 },
    LOCATION:  { model_name: "gpt-image-2",   ratio: "3:2", quality: "2k", steps: 30, guidance_scale: 7.5 },
    PRODUCT:   { model_name: "gpt-image-2",   ratio: "3:2", quality: "2k", steps: 30, guidance_scale: 7.5 },
};

export const APP_PRICING = {
    camera: calculateImageCredits({ 
        modelKey: CAMERA_DEFAULTS.model, 
        ...CAMERA_DEFAULTS.params 
    }).credits,
    
    camera_video: calculateVideoCredits({ 
        modelKey: EDIT_VIDEO_DEFAULTS.model, 
        ...EDIT_VIDEO_DEFAULTS.params 
    }).credits, 
    
    lighting: calculateImageCredits({ 
        modelKey: LIGHTING_DEFAULTS.model, 
        ...LIGHTING_DEFAULTS.params 
    }).credits,
    
    upscale: calculateUpscaleCredits({ 
        modelKey: UPSCALE_DEFAULTS.model, 
        ...UPSCALE_DEFAULTS.params 
    }).credits,

    character_sheet: calculateImageCredits({
        modelKey: SHEET_DEFAULTS.CHARACTER.model_name,
        quality: SHEET_DEFAULTS.CHARACTER.quality,
        operation: "generated"
    }).credits,

    location_sheet: calculateImageCredits({
        modelKey: SHEET_DEFAULTS.LOCATION.model_name,
        quality: SHEET_DEFAULTS.LOCATION.quality,
        operation: "generated"
    }).credits,

    product_sheet: calculateImageCredits({
        modelKey: SHEET_DEFAULTS.PRODUCT.model_name,
        quality: SHEET_DEFAULTS.PRODUCT.quality,
        operation: "generated"
    }).credits,
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
