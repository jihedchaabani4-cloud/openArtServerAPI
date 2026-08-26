import { calculateCost } from "../models/index.js";

// ── Inlined defaults ─────────────────────────────────────────────────────────
const UPSCALE_DEFAULTS    = { model: "nanobana", params: { scale: "2" } };

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
    upscale:         getPrice(UPSCALE_DEFAULTS.model, "image_upscale", UPSCALE_DEFAULTS.params),
    character_sheet: getPrice(SHEET_DEFAULTS.CHARACTER.model_name, "text_to_image", { quality: SHEET_DEFAULTS.CHARACTER.quality }),
    location_sheet:  getPrice(SHEET_DEFAULTS.LOCATION.model_name, "text_to_image", { quality: SHEET_DEFAULTS.LOCATION.quality }),
    product_sheet:   getPrice(SHEET_DEFAULTS.PRODUCT.model_name, "text_to_image", { quality: SHEET_DEFAULTS.PRODUCT.quality }),
};

export const APP_CONFIGS = {
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
    },
};
