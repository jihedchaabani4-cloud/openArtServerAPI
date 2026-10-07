import { Router } from "express";
import multer from "multer";
import { workflowService, mediaIngestionService } from "../src/container.js";
import { requireAuth } from "../src/middleware/auth.js";
import { createSizeLimitedMemoryStorage } from "../src/middleware/sizeLimitedStorage.js";
import { AppError } from "../src/utils/AppError.js";
import { createLogger } from "../src/infrastructure/logging/index.js";

const routeLogger = createLogger("route:assets");

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

        const sourceInput = req.file || req.body?.source || req.body?.base64;
        if (!sourceInput) {
            return res.status(400).json({ ok: false, error: "No file or base64 provided." });
        }

        const rawFolder = req.body?.folder_id ?? req.body?.folderId ?? req.body?.collection_id ?? req.body?.collectionId ?? req.query?.folder_id ?? req.query?.folderId ?? req.query?.collection_id ?? req.query?.collectionId ?? null;
        const normalizedFolder = (rawFolder && !["null", "undefined", "none", ""].includes(String(rawFolder).trim().toLowerCase()))
            ? String(rawFolder).trim()
            : null;

        const result = await mediaIngestionService.ingest({
            source: sourceInput,
            userId: req.user.id,
            projectId: req.body?.project_id || req.body?.projectId || null,
            folderId: normalizedFolder,
            displayName: req.file?.originalname || "Upload",
            purpose: "default",
            req,
        });

        return res.json({
            ok:            true,
            url:           result.url,
            media_id:      result.mediaId,
            workflow_id:   result.workflowId,
            folder_id:     result.folder_id ?? null,
            folderId:      result.folderId ?? null,
            collection_id: result.folder_id ?? null,
            collectionId:  result.folderId ?? null,
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
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                ok: false,
                errorCode: err.errorCode || (err.statusCode === 404 ? "NOT_FOUND" : "APP_ERROR"),
                message: err.message,
                error: err.message,
            });
        }
        return res.status(err.statusCode || 500).json({
            ok: false,
            errorCode: err.errorCode || (err.statusCode === 404 ? "NOT_FOUND" : "INTERNAL_ERROR"),
            message: err.message,
            error: err.message,
        });
    }
});

// ─── DELETE /api/assets/:id ────────────────────────────────────────────────
// :id = media.id
router.delete("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const result = await workflowService.deleteMedia({ mediaId: id, userId, req });

        routeLogger.info({ mediaId: id }, "Deleted media");
        return res.json({ ok: true, ...result });
    } catch (err) {
        routeLogger.error({ err, mediaId: req.params.id }, "Delete error");
        return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

// ─── PATCH /api/assets/:assetId/folder ──────────────────────────────────────
router.patch("/:assetId/folder", async (req, res, next) => {
    try {
        const { assetId } = req.params;
        const userId = req.user?.id;
        const rawFolderId = req.body?.folderId ?? req.body?.folder_id;

        routeLogger.debug({ assetId, userId, folderId: rawFolderId }, "PATCH /api/assets/:assetId/folder");

        const asset = await workflowService.moveToFolder({ assetId, folderId: rawFolderId, userId });
        return res.status(200).json(asset);
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                ok: false,
                errorCode: err.errorCode || "APP_ERROR",
                message: err.message,
            });
        }
        return next(err);
    }
});

export default router;
