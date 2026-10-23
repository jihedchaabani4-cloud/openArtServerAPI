import { Router } from "express";
import { workflowService, assetUploadService } from "../src/container.js";
import { requireAuth } from "../src/middleware/auth.js";
import { createUploadMiddleware } from "../src/middleware/uploadMiddleware.js";
import { DEFAULT_UPLOAD_POLICY } from "../src/platform/media-ingestion/UploadPolicy.js";
import { AppError } from "../src/utils/AppError.js";
import { createLogger } from "../src/infrastructure/logging/index.js";
import { safePublicRouteError } from "../src/utils/safePublicRouteError.js";

const routeLogger = createLogger("route:assets");

const router = Router();
router.use(requireAuth);

const upload = createUploadMiddleware(DEFAULT_UPLOAD_POLICY);

// ─── POST /api/assets/upload ───────────────────────────────────────────────
router.post("/upload", upload, async (req, res) => {
    try {
        const sourceInput = req.file || req.body?.source || req.body?.base64;
        if (!sourceInput) {
            return res.status(400).json({ ok: false, error: "No file or base64 provided." });
        }

        const rawFolder = req.body?.folder_id ?? req.body?.folderId ?? req.body?.collection_id ?? req.body?.collectionId ?? req.query?.folder_id ?? req.query?.folderId ?? req.query?.collection_id ?? req.query?.collectionId ?? null;
        const normalizedFolder = (rawFolder && !["null", "undefined", "none", ""].includes(String(rawFolder).trim().toLowerCase()))
            ? String(rawFolder).trim()
            : null;

        const result = await assetUploadService.uploadAsset({
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
        const { statusCode, errorCode, publicMessage } = safePublicRouteError(err);
        routeLogger.error("Asset upload failed", {
            error: err.message,
            statusCode,
        });
        return res.status(statusCode).json({
            ok: false,
            errorCode,
            message: publicMessage,
            error: publicMessage,
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
        const { statusCode, errorCode, publicMessage } = safePublicRouteError(err);
        routeLogger.error("Delete failed", {
            error: err.message,
            statusCode,
            mediaId: req.params.id,
        });
        return res.status(statusCode).json({ ok: false, errorCode, error: publicMessage });
    }
});

// ─── PATCH /api/assets/:assetId/folder ──────────────────────────────────────
router.patch("/:assetId/folder", async (req, res, next) => {
    try {
        const { assetId } = req.params;
        const userId = req.user?.id;
        const body = req.body || {};
        const rawFolderId = body.folderId !== undefined ? body.folderId : (body.folder_id !== undefined ? body.folder_id : null);

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
