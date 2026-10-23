/**
 * Express REST Router for AI Element Reference System — V1 Simplified (Direct Save)
 * Feature: 018-element-reference-system
 *
 * Routes:
 *   POST   /api/v2/elements                    → createElement
 *   GET    /api/v2/elements/project/:projectId → listProjectElements
 *   GET    /api/v2/elements/:id                → getElementById
 *   DELETE /api/v2/elements/:id                → deleteElement
 *   POST   /api/v2/elements/build-prompt       → buildPrompt
 *   POST   /api/v2/elements/:id/images         → addImageToElement
 *   DELETE /api/v2/elements/:id/images/:mediaId→ removeImageFromElement
 *   PATCH  /api/v2/elements/:id/cover          → setElementCover
 */

import express from "express";
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
} from "../controllers/elementController.js";
import { requireAuth } from "../src/middleware/auth.js";
import { rateLimit } from "../src/middleware/rateLimit.js";
import { createUploadMiddleware } from "../src/middleware/uploadMiddleware.js";
import { preUploadElementCapacityGuard } from "../src/middleware/elementUploadGuard.js";
import { ELEMENT_REFERENCE_UPLOAD_POLICY } from "../src/platform/media-ingestion/UploadPolicy.js";

const upload = createUploadMiddleware(ELEMENT_REFERENCE_UPLOAD_POLICY);

const router = express.Router();

router.use(requireAuth);

// ─── POST /api/v2/elements ────────────────────────────────────────────────────
router.post("/", createElement);
router.post("/analyze", rateLimit("elementAnalysis"), analyzeElement);

// ─── GET /api/v2/elements/project/:projectId ──────────────────────────────────
router.get("/project/:projectId", listProjectElements);

// ─── POST /api/v2/elements/build-prompt ───────────────────────────────────────
router.post("/build-prompt", buildPrompt);

// ─── POST /api/v2/elements/:id/images ────────────────────────────────────────
// Pre-upload capacity guard checks ownership and workflow_media quota BEFORE multer consumes stream
router.post("/:id/images", preUploadElementCapacityGuard, upload, addImageToElement);

// ─── DELETE /api/v2/elements/:id/images/:mediaId ─────────────────────────────
router.delete("/:id/images/:mediaId", removeImageFromElement);

// ─── GET /api/v2/elements/:id ─────────────────────────────────────────────────
router.get("/:id", getElementById);

// ─── PATCH /api/v2/elements/:id ───────────────────────────────────────────────
router.patch("/:id", updateElement);

// ─── DELETE /api/v2/elements/:id ─────────────────────────────────────────────
router.delete("/:id", deleteElement);

export default router;
