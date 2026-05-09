import { Router } from "express";
import { MODEL_ROUTES, VIDEO_MODEL_TYPES } from "#video/core/modelRouter.js";
import { IMAGE_ROUTES, IMAGE_MODEL_TYPES } from "#image/core/modelRouter.js";
import { getModelMetadata, MODEL_FAMILIES } from "../src/utils/modelUtils.js";

const router = Router();

function videoModelInfoToPayload(key, route) {
    const info = route.info || {};
    return {
        key:         key,
        displayName: info.displayName || key,
        description: info.description || "",
        category:    info.category || "video",
        tier:        info.tier,
        pricing:     route.pricing,
        tags:        info.tags || [],
        supportedModes: info.supportedModes || [],
        support:     info.support || {},
        supportsEdit: route.supportsEdit,
        icon:        info.icon || getModelMetadata(key).iconUrl,
    };
}

// ── GET /api/models ───────────────────────────────────────────────────────
router.get("/", (req, res) => {
    console.log("--- FETCHING MODELS ---");
    const { category } = req.query;

    let videoModels = Object.entries(MODEL_ROUTES)
        .filter(([_, route]) => route.type === VIDEO_MODEL_TYPES.GENERATED && route.open !== false && !route.hidden)
        .map(([key, route]) => videoModelInfoToPayload(key, route));

    // ── Image models ──────────────────────────────────────────────────────
    let imageModels = Object.entries(IMAGE_ROUTES)
        .filter(([_, route]) => route.type === IMAGE_MODEL_TYPES.GENERATED && route.open !== false && !route.hidden)
        .map(([key, route]) => {
            const group = route.group;
        return {
            key,
            displayName: group.displayName,
            description: group.description || "",
            category:    group.category,
            tier:        group.tier,
            pricing:     route.pricing,
            tags:        group.tags || [],
            support:     group.support || {},
            supportsEdit: route.supportsEdit,
            variants: {
                t2i:      !!route.t2i,
                i2i:      !!route.i2i,
                i2iMulti: !!route.i2iMulti,
            },
            icon: group.icon || getModelMetadata(key).iconUrl,
        };
    });

    // ── Merge all ─────────────────────────────────────────────────────────
    let models = [...videoModels, ...imageModels];

    // Filter
    if (category) models = models.filter(m => m.category === category);
  
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

    const route = MODEL_ROUTES?.[key];
    const isOpen = route ? route.open !== false : false;

    if (route && route.type === VIDEO_MODEL_TYPES.GENERATED && isOpen && !route.hidden) {
        return res.json({ success: true, data: videoModelInfoToPayload(key, route) });
    }

    const imageGroup = IMAGE_ROUTES[key];
    if (imageGroup && imageGroup.type === IMAGE_MODEL_TYPES.GENERATED && imageGroup.open !== false && !imageGroup.hidden) {
        return res.json({
            success: true,
            data: {
                key,
                displayName: imageGroup.group.displayName,
                description: imageGroup.group.description || "",
                category:    imageGroup.group.category,
                tier:        imageGroup.group.tier,
                pricing:     imageGroup.pricing,
                tags:        imageGroup.group.tags || [],
                support:     imageGroup.group.support || {},
                supportsEdit: imageGroup.supportsEdit,
                variants: {
                    t2i:      !!imageGroup.t2i,
                    i2i:      !!imageGroup.i2i,
                    i2iMulti: !!imageGroup.i2iMulti,
                },
                icon: imageGroup.group.icon || getModelMetadata(key).iconUrl,
            },
        });
    }

    return res.status(404).json({
        success:   false,
        error:     `Model "${key}" not found`,
        available: [
            ...Object.keys(MODEL_ROUTES).filter(k => MODEL_ROUTES[k].type === VIDEO_MODEL_TYPES.GENERATED),
            ...Object.keys(IMAGE_ROUTES).filter(k => IMAGE_ROUTES[k].type === IMAGE_MODEL_TYPES.GENERATED),
        ],
    });
});

export default router;
