/**
 * Express REST Router for AI Element Reference System — V1 Simplified (Direct Save)
 * Feature: 018-element-reference-system
 *
 * Routes:
 *   POST   /api/v2/elements                    → createElement
 *   GET    /api/v2/elements/project/:projectId → listProjectElements
 *   GET    /api/v2/elements/:id                → getElementById
 *   DELETE /api/v2/elements/:id                → deleteElement
 *   POST   /api/v2/elements/build-prompt       → promptBuilderProService (generation-time)
 */

import express from "express";
import {
    createElement,
    listProjectElements,
    getElementById,
    deleteElement,
    addImageToElement,
    updateElement,
    analyzeElement,
} from "../controllers/elementController.js";
import promptBuilderProService from "../src/services/promptBuilderProService.js";
import elementRepository from "../src/db/ElementRepository.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = express.Router();

router.use(requireAuth);

// ─── POST /api/v2/elements ────────────────────────────────────────────────────

router.post("/", createElement);
router.post("/analyze", analyzeElement);

// ─── GET /api/v2/elements/project/:projectId ──────────────────────────────────
// IMPORTANT: must be declared before /:id to avoid route collision

router.get("/project/:projectId", listProjectElements);

// ─── POST /api/v2/elements/build-prompt ───────────────────────────────────────
// Generation-time: resolves @ElementName tokens and builds prompt payload
// IMPORTANT: must be declared before /:id to avoid route collision

router.post("/build-prompt", async (req, res) => {
    try {
        const { userPrompt, elements = [], elementIds = [], projectId } = req.body;

        const resolvedElements = [...elements];

        // Fetch any element IDs passed directly
        for (const id of elementIds) {
            const elem = await elementRepository.findById(id);
            if (elem) resolvedElements.push(elem);
        }

        const payload = await promptBuilderProService.buildMultiElementPayload({
            userPrompt,
            elements: resolvedElements,
            projectId,
        });

        return res.json({ status: "success", ...payload });

    } catch (err) {
        console.error("[elementRoutes] build-prompt error:", err);
        return res.status(400).json({ error: true, message: err.message || "Failed to build prompt payload" });
    }
});


// ─── POST /api/v2/elements/:id/images ────────────────────────────────────────
// IMPORTANT: must be declared before /:id to avoid route collision

router.post("/:id/images", addImageToElement);

// ─── GET /api/v2/elements/:id ─────────────────────────────────────────────────

router.get("/:id", getElementById);

// ─── PATCH /api/v2/elements/:id ───────────────────────────────────────────────

router.patch("/:id", updateElement);

// ─── DELETE /api/v2/elements/:id ─────────────────────────────────────────────

router.delete("/:id", deleteElement);

export default router;
