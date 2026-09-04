import { Router } from "express";
import { getCatalog, getSchema, estimatePrice } from "../src/models/index.js";

const router = Router();

// ── GET /api/models ───────────────────────────────────────────────────────
router.get("/", (req, res) => {
    console.log("--- FETCHING MODELS FROM MODELS MANAGEMENT SYSTEM ---");
    const { category, domain } = req.query;
    const targetDomain = category || domain;

    const catalog = getCatalog(targetDomain ? { domain: targetDomain } : {});

    let models = catalog.map((m) => {
        const isVideo = m.domain === "video";
        const opDetails = m.operationDetails || {};
        const mainOp = isVideo ? "text_to_video" : (opDetails.text_to_image ? "text_to_image" : Object.keys(opDetails)[0]);
        const opDef = opDetails[mainOp] || {};

        return {
            key:            m.modelFamily,
            displayName:    m.displayName,
            description:    m.description || "",
            category:       m.domain,
            tier:           m.badge || "standard",
            pricing:        opDef.pricing || {},
            tags:           m.badge ? [m.badge.toLowerCase()] : [],
            support:        {},
            supportsEdit:   m.operations.includes("edit"),
            supportsCamera: isVideo,
            variants: {
                t2i:      m.operations.includes("text_to_image"),
                i2i:      m.operations.includes("edit"),
                i2iMulti: m.operations.includes("edit"),
            },
            icon:           m.iconUrl || "",
            badge:          m.badge || null,
            operations:     m.operations,
            operationDetails: m.operationDetails,
        };
    });

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
        const isVideo = m.domain === "video";
        const opDetails = m.operationDetails || {};
        const mainOp = isVideo ? "text_to_video" : (opDetails.text_to_image ? "text_to_image" : Object.keys(opDetails)[0]);
        const opDef = opDetails[mainOp] || {};

        return res.json({
            success: true,
            data: {
                key:            m.modelFamily,
                displayName:    m.displayName,
                description:    m.description || "",
                category:       m.domain,
                tier:           m.badge || "standard",
                pricing:        opDef.pricing || {},
                tags:           m.badge ? [m.badge.toLowerCase()] : [],
                support:        {},
                supportsEdit:   m.operations.includes("edit"),
                supportsCamera: isVideo,
                variants: {
                    t2i:      m.operations.includes("text_to_image"),
                    i2i:      m.operations.includes("edit"),
                    i2iMulti: m.operations.includes("edit"),
                },
                icon:           m.iconUrl || "",
                badge:          m.badge || null,
                operations:     m.operations,
                operationDetails: m.operationDetails,
            },
        });
    }

    return res.status(404).json({
        success:   false,
        error:     `Model "${key}" not found`,
        available: catalog.map(entry => entry.modelFamily),
    });
});

// ── GET /api/models/:key/:operation/schema ──────────────────────────────────
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
        const estimate = estimatePrice(key, operation, req.body || {});
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
