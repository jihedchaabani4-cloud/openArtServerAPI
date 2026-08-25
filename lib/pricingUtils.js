import { calculateCost, getCatalog } from "../src/models/index.js";

// ── Auto-Detect Model Type ─────────────────────────────────────────────────────
function detectModelDomain(modelKey) {
    const catalog = getCatalog();
    const entry = catalog.find(m => m.modelFamily === modelKey);
    return entry ? entry.domain : null;
}

// ── Unified Calculator ─────────────────────────────────────────────────────────
export function calculateCredits({
    modelKey,
    // video
    durationSeconds = 5,
    resolution = "720p",
    // image
    quality = "standard",
    operation = "text_to_image",
    scale = "2",
    // shared
    count = 1,
} = {}) {
    if (!modelKey) throw new Error("[pricingUtils] modelKey is required");

    const domain = detectModelDomain(modelKey) || "image";
    let targetOp = operation;
    if (operation === "generated") targetOp = domain === "video" ? "text_to_video" : "text_to_image";
    if (operation === "edit") targetOp = "edit";
    if (operation === "upscale") targetOp = domain === "video" ? "video_upscale" : "image_upscale";

    const input = domain === "video" 
        ? { durationSeconds, resolution }
        : (targetOp === "image_upscale" ? { scale } : { quality });

    const costResult = calculateCost(modelKey, targetOp, input);
    const credits = parseFloat(costResult.amount) * count;

    return {
        credits,
        domain,
        modelKey,
        breakdown: {
            base: costResult.amount,
            count,
            total: credits,
        },
    };
}

export function getModelDomain(modelKey) {
    return detectModelDomain(modelKey);
}
