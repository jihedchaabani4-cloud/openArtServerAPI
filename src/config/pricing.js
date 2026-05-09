/**
 * Centralized Pricing Configuration
 * Defines the default base prices and multipliers for all generation tools and studio apps.
 */

import { CameraTreatment } from "../image/treatments/extendtretment/CameraEditTreatment.js";
import { LightingTreatment } from "../image/treatments/extendtretment/LightingTreatment.js";
import { UpscaleTreatment } from "../image/treatments/UpscaleTreatment.js";
import { EditVideoTreatment } from "../video/treatments/EditVideoTreatment.js";
import { ElementSheetTreatment, SHEET_DEFAULTS } from "../image/treatments/extendtretment/ElementSheetTreatment.js";

import { calculateImageCredits, calculateUpscaleCredits } from "../image/core/modelRouter.js";
import { calculateVideoCredits } from "../video/core/modelRouter.js";

export const APP_PRICING = {
    camera: calculateImageCredits({ 
        modelKey: CameraTreatment.DEFAULT_MODEL, 
        ...CameraTreatment.DEFAULT_PARAMS 
    }).credits,
    
    camera_video: calculateVideoCredits({ 
        modelKey: EditVideoTreatment.DEFAULT_MODEL, 
        ...EditVideoTreatment.DEFAULT_PARAMS 
    }).credits, 
    
    lighting: calculateImageCredits({ 
        modelKey: LightingTreatment.DEFAULT_MODEL, 
        ...LightingTreatment.DEFAULT_PARAMS 
    }).credits,
    
    upscale: calculateUpscaleCredits({ 
        modelKey: UpscaleTreatment.DEFAULT_MODEL, 
        ...UpscaleTreatment.DEFAULT_PARAMS 
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
        defaultModel: CameraTreatment.DEFAULT_MODEL, 
        defaultParams: CameraTreatment.DEFAULT_PARAMS 
    },
    camera_video: { 
        defaultModel: EditVideoTreatment.DEFAULT_MODEL, 
        defaultParams: EditVideoTreatment.DEFAULT_PARAMS 
    },
    lighting: { 
        defaultModel: LightingTreatment.DEFAULT_MODEL, 
        defaultParams: LightingTreatment.DEFAULT_PARAMS 
    },
    upscale: { 
        defaultModel: UpscaleTreatment.DEFAULT_MODEL, 
        defaultParams: UpscaleTreatment.DEFAULT_PARAMS 
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

