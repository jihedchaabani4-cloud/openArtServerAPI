import { getStandardSize } from "#utils/sizeUtils.js";

// ─── Parameter Validation & Clamping ───
export function verifyAndClampParams(provider, params) {
    let { steps, guidance_scale, ratio, quality, count, references } = params;

    // 1. References limit
    const maxRefs = provider.maxReferences ?? 0;
    const rawRefs = (references || []).slice(0, maxRefs);

    // 2. Steps clamping (if provider defines limits)
    if (steps !== undefined) {
        const minSteps = provider.minSteps || 1;
        const maxSteps = provider.maxSteps || 50; // generous default max
        steps = Math.min(Math.max(steps, minSteps), maxSteps);
    }

    // 3. Guidance scale clamping
    if (guidance_scale !== undefined) {
        const minGuid = provider.minGuidance || 1.0;
        const maxGuid = provider.maxGuidance || 20.0;
        guidance_scale = Math.min(Math.max(guidance_scale, minGuid), maxGuid);
    }

    // 4. Ratio Check
    if (ratio && provider.supportedRatios && !provider.supportedRatios.includes(ratio)) {
        ratio = provider.supportedRatios[0] || "1:1";
    }

    // 5. Quality / Resolution Check
    if (quality && provider.supportedQualities && !provider.supportedQualities.includes(quality)) {
        quality = provider.supportedQualities[0] || "1K";
    }

    // 6. Number of images (count)
    if (count !== undefined) {
        const maxCount = provider.maxImages || 4; // default max 4 shots
        count = Math.min(Math.max(count, 1), maxCount);
    }

    return { steps, guidance_scale, ratio, quality, count };
}

// ─── Helper: fail all items with structured error ───
export async function failItems(db, itemIds, err) {
    // ─── Internal log — always ───
    if (err.isInternal) {
        console.error(`🔒 [INTERNAL ERROR] ${err.code} @ ${err.step}: ${err.message}`);
    }

    for (const itemId of itemIds) {
        await db.updateItemStatus({
            item_id: itemId,
            status:  "error",
            error: {
                // hide details from user if internal error
                code:    err.isInternal ? "SERVER_ERROR" : err.code,
                status:  err.isInternal ? 500            : err.status,
                step:    err.isInternal ? null           : err.step,
                message: err.userMessage || err.message,
            }
        });
    }
}
