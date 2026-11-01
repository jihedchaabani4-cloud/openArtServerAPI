/**
 * Catalog Presentation Helper
 * Formats model catalog entries for client consumption, calculating default costs and caching the presentation model.
 */

import { calculateCost, getCatalog } from "./index.js";

function safeCalculateCost(modelKey, input) {
    try {
        return calculateCost(modelKey, input);
    } catch {
        return null; // Model not in V2 registry yet — degrade gracefully
    }
}

let cachedModelConfig = null;

export function getModelConfig(options = {}) {
    if (cachedModelConfig && !options.fresh) return cachedModelConfig;

    const catalog = getCatalog();
    const models = catalog.map((m) => {
        const defaultCost = safeCalculateCost(
            m.modelFamily || m.id,
            m.domain === "video" ? { duration: 5, resolution: "720p" } : { quality: "standard" }
        );

        return {
            key:            m.modelFamily || m.id,
            displayName:    m.displayName,
            description:    m.description || "",
            category:       m.domain,
            tier:           m.badge || "standard",
            pricing:        { ...(m.retailPricing || {}), defaultCost },
            tags:           m.badge ? [m.badge.toLowerCase()] : [],
            supportedModes: m.domain ? [m.domain] : [],
            icon:           m.iconUrl || "",
            badge:          m.badge || null,
            parameters:     m.parameters || {},
        };
    });

    cachedModelConfig = { models };
    return cachedModelConfig;
}

export function clearModelConfigCache() {
    cachedModelConfig = null;
}
