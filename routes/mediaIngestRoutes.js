import { Router } from "express";
import multer from "multer";
import { mediaIngestionService } from "../src/container.js";
import { requireAuth } from "../src/middleware/auth.js";
import { createSizeLimitedMemoryStorage } from "../src/middleware/sizeLimitedStorage.js";

const router = Router();
router.use(requireAuth);

const upload = multer({
    storage: createSizeLimitedMemoryStorage({
        imageLimit: 20 * 1024 * 1024,
        videoLimit: 100 * 1024 * 1024,
    }),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max (videos)
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")) {
            cb(null, true);
        } else {
            const err = new Error(`Unsupported file type: ${file.mimetype}`);
            err.statusCode = 415;
            err.code = "UNSUPPORTED_MEDIA_TYPE";
            cb(err);
        }
    },
});

/**
 * POST /api/media/ingest
 * Canonical ingestion endpoint: accepts multipart file, URL string, Base64 data URI, or media_id.
 */
router.post("/ingest", upload.single("file"), async (req, res) => {
    try {
        if (req.file && req.file.mimetype.startsWith("image/") && req.file.size > 20 * 1024 * 1024) {
            return res.status(413).json({
                ok: false,
                code: "PAYLOAD_TOO_LARGE",
                message: "Image file exceeds maximum allowed size of 20MB",
            });
        }

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
