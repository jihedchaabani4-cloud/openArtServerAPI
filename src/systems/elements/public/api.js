/**
 * System 7: Elements — Public HTTP API Gateway (#elements/api)
 *
 * Exposes Element entity CRUD, AI vision taste analysis, prompt building,
 * and reference image management.
 *
 * Governed by:
 * - docs/architecture/constitution/01_business_systems_architecture.md (System 7)
 * - Rule 13: Express isolated strictly to public/api.js
 */

import { Router } from "express";
import {
    createElement,
    listProjectElements,
    getElementById,
    deleteElement,
    addImageToElement,
    removeImageFromElement,
    updateElement,
    analyzeElement,
    buildPrompt,
} from "../internal/controllers/elementController.js";
import { requireAuth, rateLimit } from "#identity/tools";
import { createUploadMiddleware } from "#media/api";
import { preUploadElementCapacityGuard, createPreUploadElementCapacityGuard } from "../internal/middleware/elementUploadGuard.js";
import { ELEMENT_REFERENCE_UPLOAD_POLICY } from "#media/tools";

const upload = createUploadMiddleware(ELEMENT_REFERENCE_UPLOAD_POLICY);

const router = Router();

router.use(requireAuth);

// ─── POST /api/v2/elements ────────────────────────────────────────────────────
router.post("/", createElement);
router.post("/analyze", rateLimit("elementAnalysis"), analyzeElement);

// ─── GET /api/v2/elements/project/:projectId ──────────────────────────────────
router.get("/project/:projectId", listProjectElements);

// ─── POST /api/v2/elements/build-prompt ───────────────────────────────────────
router.post("/build-prompt", buildPrompt);

// ─── POST /api/v2/elements/:id/images ────────────────────────────────────────
router.post("/:id/images", preUploadElementCapacityGuard, upload, addImageToElement);

// ─── DELETE /api/v2/elements/:id/images/:mediaId ─────────────────────────────
router.delete("/:id/images/:mediaId", removeImageFromElement);

// ─── GET /api/v2/elements/:id ─────────────────────────────────────────────────
router.get("/:id", getElementById);

// ─── PATCH /api/v2/elements/:id ───────────────────────────────────────────────
router.patch("/:id", updateElement);

// ─── DELETE /api/v2/elements/:id ─────────────────────────────────────────────
router.delete("/:id", deleteElement);

export {
    createElement,
    listProjectElements,
    getElementById,
    deleteElement,
    addImageToElement,
    removeImageFromElement,
    updateElement,
    analyzeElement,
    buildPrompt,
    preUploadElementCapacityGuard,
    createPreUploadElementCapacityGuard,
};

export const elementRoutes = router;
export default router;
