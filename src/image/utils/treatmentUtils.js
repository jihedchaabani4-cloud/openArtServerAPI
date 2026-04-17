import { getStandardSize } from "#utils/sizeUtils.js";

// ─── Parameter Validation, Clamping & Default Injection ───
/**
 * Validates, clamps, and fills-in missing parameters before they reach the runner.
 *
 * Priority for each param:
 *   1. User-supplied value (valid & in range)
 *   2. provider.defaultParams[key]   ← model declares its own safe defaults
 *   3. Hard-coded universal fallbacks ← last resort
 *
 * This guarantees that adapt() / toPayload() always receive a defined value,
 * so individual runners don't need to repeat the same || "1:1" everywhere.
 */
export function verifyAndClampParams(provider, params) {
    let { steps, guidance_scale, ratio, quality, count, references } = params;

    // Shorthand: model-level defaults (optional on provider)
    const def = provider.defaultParams || {};

    // 1. References limit
    const maxRefs = provider.maxReferences ?? 0;
    const rawRefs = (references || []).slice(0, maxRefs);

    // 2. Steps — apply default if missing, then clamp
    if (steps === undefined || steps === null) {
        steps = def.steps ?? undefined; // keep undefined if model doesn't care
    }
    if (steps !== undefined) {
        const minSteps = provider.minSteps || 1;
        const maxSteps = provider.maxSteps || 150;
        steps = Math.min(Math.max(steps, minSteps), maxSteps);
    }

    // 3. Guidance scale — apply default if missing, then clamp
    if (guidance_scale === undefined || guidance_scale === null) {
        guidance_scale = def.guidance_scale ?? undefined;
    }
    if (guidance_scale !== undefined) {
        const minGuid = provider.minGuidance || 1.0;
        const maxGuid = provider.maxGuidance || 20.0;
        guidance_scale = Math.min(Math.max(guidance_scale, minGuid), maxGuid);
    }

    // 4. Ratio — validate against supportedRatios, fallback to provider default or "1:1"
    if (!ratio) {
        // User didn't send ratio → use model default → last resort "1:1"
        ratio = def.ratio ?? (provider.supportedRatios?.[0]) ?? "1:1";
    } else if (provider.supportedRatios && !provider.supportedRatios.includes(ratio)) {
        // User sent an unsupported ratio → replace with model default
        console.warn(`⚠️ [verifyAndClampParams] Ratio "${ratio}" not supported by ${provider.modelName}. Falling back to "${def.ratio ?? provider.supportedRatios[0]}".`);
        ratio = def.ratio ?? provider.supportedRatios[0];
    }

    // 5. Quality / Resolution — validate & fallback
    if (!quality) {
        quality = def.quality ?? (provider.supportedQualities?.[0]) ?? "1k";
    } else if (provider.supportedQualities && !provider.supportedQualities.includes(quality)) {
        console.warn(`⚠️ [verifyAndClampParams] Quality "${quality}" not supported by ${provider.modelName}. Falling back to "${def.quality ?? provider.supportedQualities[0]}".`);
        quality = def.quality ?? provider.supportedQualities[0];
    }

    // 6. Count
    if (count === undefined || count === null) {
        count = def.count ?? 1;
    }
    const maxCount = provider.maxImages || 4;
    count = Math.min(Math.max(count, 1), maxCount);

    return { steps, guidance_scale, ratio, quality, count };
}

// ─── Video Parameter Validation, Clamping & Default Injection ───
/**
 * Validates and fills-in missing video parameters before they reach the runner.
 *
 * Priority for each param:
 *   1. User-supplied value (valid & in range)
 *   2. provider.defaultParams[key]   ← model declares its own safe defaults
 *   3. Hard-coded universal fallbacks ← last resort
 *
 * @param {object} provider  — the resolved runner instance
 * @param {object} params    — { ratio, duration, cfgScale, negativePrompt, ... }
 * @returns {object}         — sanitised params ready for form building
 */
export function verifyAndClampVideoParams(provider, params) {
    let { ratio, duration, cfgScale } = params;

    // Shorthand: model-level defaults (optional on provider)
    const def = provider.defaultParams || {};

    // 1. Ratio — validate against supportedRatios, fallback to provider default or "16:9"
    if (!ratio) {
        ratio = def.ratio ?? (provider.supportedRatios?.[0]) ?? "16:9";
    } else if (provider.supportedRatios && !provider.supportedRatios.includes(ratio)) {
        console.warn(`⚠️ [verifyAndClampVideoParams] Ratio "${ratio}" not supported by ${provider.modelName}. Falling back to "${def.ratio ?? provider.supportedRatios[0]}".`);
        ratio = def.ratio ?? provider.supportedRatios[0];
    }

    // 2. Duration — parse, clamp between model min/max, apply default
    const rawDuration = parseFloat(String(duration));
    if (!rawDuration || isNaN(rawDuration)) {
        duration = def.duration ?? 5;
    } else {
        const minDur = provider.minDuration || 3;
        const maxDur = provider.maxDuration || 15;
        duration = Math.min(Math.max(rawDuration, minDur), maxDur);
    }

    // 3. cfgScale — apply default if missing
    if (cfgScale === undefined || cfgScale === null) {
        cfgScale = def.cfgScale ?? undefined; // keep undefined if model doesn't care
    }

    return { ...params, ratio, duration, cfgScale };
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
