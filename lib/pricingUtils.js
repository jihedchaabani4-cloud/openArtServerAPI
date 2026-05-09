/**
 * ─── Unified Pricing Calculator ───────────────────────────────────────────────
 *
 * One function to rule them all.
 * Automatically detects whether the model is an image or video model,
 * then delegates to the correct router calculator.
 *
 * Usage:
 *   calculateCredits({ modelKey: "kling_v3", durationSeconds: 5, resolution: "1080p" })
 *   calculateCredits({ modelKey: "nanobana", quality: "hd", operation: "edit" })
 *   calculateCredits({ modelKey: "nanobana", quality: "hd", count: 4 })
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
    MODEL_ROUTES,
    VIDEO_MODEL_TYPES,
    calculateVideoCredits,
    calculateUpscaleCredits as calculateVideoUpscaleCredits,
} from "#video/core/modelRouter.js";

import {
    IMAGE_ROUTES,
    IMAGE_MODEL_TYPES,
    calculateImageCredits,
    calculateUpscaleCredits as calculateImageUpscaleCredits,
} from "#image/core/modelRouter.js";

// ── Auto-Detect Model Type ─────────────────────────────────────────────────────
function detectModelDomain(modelKey) {
    if (MODEL_ROUTES[modelKey]) return "video";
    if (IMAGE_ROUTES[modelKey]) return "image";
    return null;
}

// ── Unified Calculator ─────────────────────────────────────────────────────────
/**
 * calculateCredits(params)
 *
 * @param {object} params
 * @param {string}  params.modelKey         - The public model key (e.g. "kling_v3", "nanobana")
 *
 * --- Video params ---
 * @param {number}  [params.durationSeconds] - Duration in seconds (e.g. 5, 10, 15)
 * @param {string}  [params.resolution]      - Resolution key: "720p" | "1080p" | "480p"
 *
 * --- Image params ---
 * @param {string}  [params.quality]         - Quality key: "standard" | "hd" | "2k" | "4k"
 * @param {string}  [params.operation]       - "generated" (default) or "edit"
 *
 * --- Shared ---
 * @param {number}  [params.count]           - Number of outputs (default: 1)
 *
 * @returns {{ credits: number, domain: string, modelKey: string, breakdown: object }}
 */
export function calculateCredits({
    modelKey,
    // video
    durationSeconds,
    resolution = "720p",
    // image
    quality = "standard",
    operation = "generated",
    // shared
    count = 1,
} = {}) {
    if (!modelKey) throw new Error("[pricingUtils] modelKey is required");

    const domain = detectModelDomain(modelKey);
    if (!domain) throw new Error(`[pricingUtils] Model "${modelKey}" not found in video or image routes`);

    // ── Video ────────────────────────────────────────────────────────────────
    if (domain === "video") {
        const route = MODEL_ROUTES[modelKey];

        // Upscale video model
        if (route?.type === VIDEO_MODEL_TYPES.UPSCALE) {
            const result = calculateVideoUpscaleCredits({ modelKey });
            return { domain, ...result };
        }

        // Generated video model
        const result = calculateVideoCredits({
            modelKey,
            durationSeconds: durationSeconds ?? 5,
            resolution,
            count,
        });
        return { domain, ...result };
    }

    // ── Image ────────────────────────────────────────────────────────────────
    if (domain === "image") {
        const route = IMAGE_ROUTES[modelKey];

        // Upscale image model
        if (route?.type === IMAGE_MODEL_TYPES.UPSCALE) {
            const result = calculateImageUpscaleCredits({ modelKey });
            return { domain, ...result };
        }

        // Generated / edited image model
        const result = calculateImageCredits({
            modelKey,
            quality,
            count,
            operation,
        });
        return { domain, ...result };
    }
}

/**
 * getModelDomain(modelKey)
 * Utility to check if a model is "video" or "image" without calculating price.
 *
 * @param {string} modelKey
 * @returns {"video" | "image" | null}
 */
export function getModelDomain(modelKey) {
    return detectModelDomain(modelKey);
}
