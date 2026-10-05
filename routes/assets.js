import { Router } from "express";
import multer from "multer";
import { workflowService, mediaIngestionService } from "../src/container.js";
import { requireAuth } from "../src/middleware/auth.js";
import { createSizeLimitedMemoryStorage } from "../src/middleware/sizeLimitedStorage.js";

const router = Router();
router.use(requireAuth);

// ─── Multer ────────────────────────────────────────────────────────────────
const upload = multer({
    storage: createSizeLimitedMemoryStorage({
        imageLimit: 20 * 1024 * 1024,
        videoLimit: 100 * 1024 * 1024,
    }),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max (videos)
    fileFilter: (req, file, cb) => {
        const allowed = [
            "image/jpeg", "image/png", "image/webp", "image/gif", "image/avif",
            "video/mp4", "video/webm", "video/quicktime",
        ];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            const err = new Error(`Unsupported file type: ${file.mimetype}`);
            err.statusCode = 415;
            err.code = "UNSUPPORTED_MEDIA_TYPE";
            cb(err);
        }
    },
});

// ─── POST /api/assets/upload ───────────────────────────────────────────────
router.post("/upload", upload.single("file"), async (req, res) => {
    try {
        if (req.file && req.file.mimetype.startsWith("image/") && req.file.size > 20 * 1024 * 1024) {
            return res.status(413).json({
                ok: false,
                code: "PAYLOAD_TOO_LARGE",
                message: "Image file exceeds maximum allowed size of 20MB",
            });
        }

        const userId    = req.user.id;
        const projectId = req.body?.project_id || null;
        const sessionId = req.body?.session_id || null;

        const sourceInput = req.file || req.body?.base64;
        if (!sourceInput) {
            return res.status(400).json({ ok: false, error: "No file or base64 provided." });
        }

        const result = await mediaIngestionService.ingest({
            source: sourceInput,
            userId,
            projectId,
            sessionId,
            displayName: req.file?.originalname || "Upload",
            purpose: "default",
            req,
        });

        return res.json({
            ok:            true,
            url:           result.url,
            media_id:      result.mediaId,
            workflow_id:   result.workflowId,
            workflow_type: "UPLOAD",
            asset_id:      result.mediaId, // backward compat alias
            type:          result.type,
            width:         result.width,
            height:        result.height,
            ratio:         result.ratio,
            resolution:    result.inspection?.resolution || null,
            size:          `${result.width}x${result.height}`,
        });

    } catch (err) {
        console.error("❌ [AssetsRoute] Upload error:", err.message);
        return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

// ─── DELETE /api/assets/:id ────────────────────────────────────────────────
// :id = media.id
router.delete("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const result = await workflowService.deleteMedia({ mediaId: id, userId, req });

        console.log(`✅ [AssetsRoute] Deleted media:${id}`);
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error("❌ [AssetsRoute] Delete error:", err.message);
        return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

export default router;
