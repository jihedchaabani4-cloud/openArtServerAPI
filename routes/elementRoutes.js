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
 */

import express from "express";
import multer from "multer";
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

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max file size (images only)
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith("image/")) {
            cb(null, true);
        } else {
            const err = new Error(`Unsupported file type: ${file.mimetype}`);
            err.statusCode = 415;
            err.code = "UNSUPPORTED_MEDIA_TYPE";
            cb(err);
        }
    },
});

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
router.post("/:id/images", upload.single("file"), addImageToElement);

// ─── DELETE /api/v2/elements/:id/images/:mediaId ─────────────────────────────
router.delete("/:id/images/:mediaId", removeImageFromElement);

// ─── GET /api/v2/elements/:id ─────────────────────────────────────────────────
router.get("/:id", getElementById);

// ─── PATCH /api/v2/elements/:id ───────────────────────────────────────────────
router.patch("/:id", updateElement);

// ─── DELETE /api/v2/elements/:id ─────────────────────────────────────────────
router.delete("/:id", deleteElement);

export default router;
