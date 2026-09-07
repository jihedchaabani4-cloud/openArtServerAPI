import { Router } from "express";
import { getCatalog, getModelSchema, getSchema, estimatePrice } from "../src/models/index.js";

const router = Router();

function formatModelDto(m) {
    return {
        key:            m.modelFamily || m.id,
        displayName:    m.displayName,
        description:    m.description || "",
        category:       m.domain,
        tier:           m.badge || "standard",
        pricing:        m.retailPricing || {},
        tags:           m.badge ? [m.badge.toLowerCase()] : [],
        icon:           m.iconUrl || "",
        badge:          m.badge || null,
        parameters:     m.parameters || {},
    };
}

// ── GET /api/models ───────────────────────────────────────────────────────
router.get("/", (req, res) => {
    console.log("--- FETCHING MODELS FROM MODELS MANAGEMENT SYSTEM ---");
    const { category, domain } = req.query;
    const targetDomain = category || domain;

    const catalog = getCatalog(targetDomain ? { domain: targetDomain } : {});
    const models = catalog.map(formatModelDto);

    console.log("--- MODELS FETCHED ---", models.length);

    res.json({
        success: true,
        data: {
            total:  models.length,
            models,
            grouped: models.reduce((acc, m) => {
                (acc[m.category] = acc[m.category] || []).push(m);
                return acc;
            }, {}),
        },
    });
});

// ── GET /api/models/:key ──────────────────────────────────────────────────
router.get("/:key", (req, res) => {
    const { key } = req.params;
    console.log("--- FETCHING MODEL BY KEY ---", key);

    const catalog = getCatalog();
    const m = catalog.find(entry => entry.modelFamily === key);

    if (m) {
        return res.json({
            success: true,
            data: formatModelDto(m),
        });
    }

    return res.status(404).json({
        success:   false,
        error:     `Model "${key}" not found`,
        available: catalog.map(entry => entry.modelFamily),
    });
});

// ── GET /api/models/:key/schema ──────────────────────────────────────────
router.get("/:key/schema", (req, res) => {
    const { key } = req.params;
    try {
        const schema = getModelSchema(key);
        return res.json({
            success: true,
            data: schema
        });
    } catch (err) {
        return res.status(err.statusCode || 404).json({
            success: false,
            error: err.message,
            code: err.code || "SCHEMA_ERROR"
        });
    }
});

// ── GET /api/models/:key/:operation/schema (Legacy Compatibility) ───────────
router.get("/:key/:operation/schema", (req, res) => {
    const { key, operation } = req.params;
    try {
        const schema = getSchema(key, operation);
        return res.json({
            success: true,
            data: schema
        });
    } catch (err) {
        return res.status(err.statusCode || 400).json({
            success: false,
            error: err.message,
            code: err.code || "SCHEMA_ERROR"
        });
    }
});

// ── POST /api/models/:key/:operation/estimate-price ─────────────────────────
router.post("/:key/:operation/estimate-price", (req, res) => {
    const { key, operation } = req.params;
    try {
        const estimate = estimatePrice(key, req.body || {});
        return res.json({
            success: true,
            data: {
                credits: estimate.amount,
                amountString: estimate.amountString,
                currency: estimate.currency,
                pricingVersion: estimate.pricingVersion,
                breakdown: {
                    basePrice: estimate.basePrice,
                    modifiers: estimate.modifiersApplied
                }
            }
        });
    } catch (err) {
        return res.status(err.statusCode || 400).json({
            success: false,
            error: err.message,
            code: err.code || "PRICING_ESTIMATION_ERROR"
        });
    }
});

export default router;
