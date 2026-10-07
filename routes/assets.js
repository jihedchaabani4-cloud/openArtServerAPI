import { Router } from "express";
import multer from "multer";
import { workflowService, mediaIngestionService, db, folderService } from "../src/container.js";
import { requireAuth } from "../src/middleware/auth.js";
import { createSizeLimitedMemoryStorage } from "../src/middleware/sizeLimitedStorage.js";
import { assertOwns } from "../src/platform/security/ownership.js";
import { toAssetDto } from "../src/domain/assetDto.js";
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

// ─── PATCH /api/assets/:assetId/folder ──────────────────────────────────────
router.patch("/:assetId/folder", async (req, res, next) => {
    try {
        const { assetId } = req.params;
        const userId = req.user?.id;
        const rawFolderId = req.body?.folderId ?? req.body?.folder_id;

        routeLogger.debug({ assetId, userId, folderId: rawFolderId }, "PATCH /api/assets/:assetId/folder");

        // Normalize folderId: null, undefined, or "none" (case-insensitive) -> null
        let targetFolderId = null;
        if (rawFolderId !== null && rawFolderId !== undefined && String(rawFolderId).toLowerCase() !== "none") {
            if (typeof rawFolderId !== "string" || !rawFolderId.trim()) {
                return res.status(400).json({ ok: false, error: "Invalid folderId format" });
            }
            targetFolderId = rawFolderId.trim();
        }

        // 1. Assert asset ownership (returns 404 on missing or foreign asset)
        const asset = await assertOwns("workflow", assetId, userId);

        // 2. If targetFolderId is provided, validate folder is usable in this project
        if (targetFolderId !== null) {
            await folderService.assertFolderUsable(targetFolderId, userId, asset.project_id);
        }

        // 3. Update folder_id in DB scoped by user and project
        try {
            const updated = await db.workflows.updateFolderId(assetId, targetFolderId, userId, asset.project_id);
            return res.status(200).json(toAssetDto(updated || { ...asset, folder_id: targetFolderId }));
        } catch (dbErr) {
            if (dbErr.code === "23503") {
                return res.status(404).json({
                    ok: false,
                    errorCode: "NOT_FOUND",
                    message: "Target folder not found in project",
                });
            }
            throw dbErr;
        }
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
