import { Router } from "express";
import multer from "multer";
import { mediaIngestionService } from "../src/container.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = Router();
router.use(requireAuth);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
});

/**
 * POST /api/media/ingest
 * Canonical ingestion endpoint: accepts multipart file, URL string, Base64 data URI, or media_id.
 */
router.post("/ingest", upload.single("file"), async (req, res) => {
    try {
        const userId = req.user.id;
        const sourceInput = req.file || req.body?.source || req.body?.image_url || req.body?.media_id || req.body?.base64;

        if (!sourceInput) {
            return res.status(400).json({
                ok: false,
                error: "No source provided. Expected multipart file, URL, Base64, or media_id.",
            });
        }

        const {
            project_id,
            session_id,
            workflow_id,
            purpose = "default",
            folder,
            display_name,
        } = req.body || {};

        const result = await mediaIngestionService.ingest({
            source: sourceInput,
            userId,
            projectId: project_id,
            sessionId: session_id,
            workflowId: workflow_id,
            purpose,
            folder,
            displayName: display_name,
            req,
        });

        return res.json({
            ok: true,
            media_id: result.mediaId,
            workflow_id: result.workflowId,
            url: result.url,
            type: result.type,
            width: result.width,
            height: result.height,
            ratio: result.ratio,
            format: result.format,
            is_new: result.isNew,
            media: result.media,
        });
    } catch (err) {
        console.error("❌ [/api/media/ingest] Error:", err.message);
        return res.status(err.statusCode || 500).json({
            ok: false,
            error: err.message,
        });
    }
});

export default router;
