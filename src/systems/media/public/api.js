/**
 * System 4: Media & Storage — Public HTTP Gateway (Rule 1, Rule 3, Rule 4, Rule 13)
 *
 * Exposes Express routes for media ingestion, uploads, retrieval, and deletion.
 */

import { Router } from "express";
import { createLogger } from "#shared";
import { safePublicRouteError, AppError } from "#shared";
import { requireAuth } from "../../../middleware/auth.js";
import { createUploadMiddleware } from "../../../middleware/uploadMiddleware.js";
import { DEFAULT_UPLOAD_POLICY } from "../internal/ingestion/UploadPolicy.js";
import {
    assetUploadService,
    workflowService,
} from "../../../container.js";
import {
    getMediaById,
    deleteMedia,
    getMediaRepository,
} from "./tools.js";

const routeLogger = createLogger("route:media");

export const mediaRouter = Router();
export const assetsRouter = Router();
export const mediaIngestRouter = Router();

// Middleware setup
const upload = createUploadMiddleware(DEFAULT_UPLOAD_POLICY);

// ── Ingestion Handler ────────────────────────────────────────────────────────
export async function handleMediaIngest(req, res) {
    try {
        const userId = req.user?.id;
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
            display_name,
        } = req.body || {};

        if (req.body?.purpose !== undefined && req.body?.purpose !== null) {
            const rawPurpose = String(req.body.purpose).replace(/[\x00-\x1F\x7F-\x9F]/g, "").trim();
            const sanitizedPurpose = rawPurpose.length > 64 ? `${rawPurpose.slice(0, 64)}…` : rawPurpose;
            routeLogger.warn("Client supplied deprecated 'purpose' parameter; ignoring in favor of DEFAULT_UPLOAD_POLICY", {
                purpose: sanitizedPurpose,
                userId,
            });
        }

        const rawFolder = req.body?.folder_id ?? req.body?.folderId ?? req.body?.collection_id ?? req.body?.collectionId ?? req.query?.folder_id ?? req.query?.folderId ?? req.query?.collection_id ?? req.query?.collectionId ?? null;
        const normalizedFolder = (rawFolder && !["null", "undefined", "none", ""].includes(String(rawFolder).trim().toLowerCase()))
            ? String(rawFolder).trim()
            : null;

        const result = await assetUploadService.uploadAsset({
            source: sourceInput,
            userId,
            projectId: project_id,
            sessionId: session_id,
            workflowId: workflow_id,
            folderId: normalizedFolder,
            displayName: display_name,
            req,
        });

        return res.json({
            ok: true,
            media_id: result.mediaId,
            workflow_id: result.workflowId,
            folder_id: result.folder_id ?? null,
            folderId: result.folderId ?? null,
            collection_id: result.folder_id ?? null,
            collectionId: result.folderId ?? null,
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
        const { statusCode, errorCode, publicMessage } = safePublicRouteError(err);
        routeLogger.error("Failed to ingest media", {
            error: err.message,
            statusCode,
        });
        return res.status(statusCode).json({
            ok: false,
            errorCode,
            error: publicMessage,
        });
    }
}

// ── Asset Upload Handler ─────────────────────────────────────────────────────
export async function handleAssetUpload(req, res) {
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
            asset_id:      result.mediaId,
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
}

// ── Delete Media Handler ─────────────────────────────────────────────────────
export async function handleDeleteMedia(req, res) {
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
}

// ── Move to Folder Handler ───────────────────────────────────────────────────
export async function handleMoveToFolder(req, res, next) {
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
}

// ── GET Single Media Handler ─────────────────────────────────────────────────
export async function handleGetMedia(req, res) {
    try {
        const { id } = req.params;
        const media = await getMediaById(id);
        if (!media) {
            return res.status(404).json({ ok: false, error: "Media not found" });
        }
        return res.json({ ok: true, media });
    } catch (err) {
        const { statusCode, errorCode, publicMessage } = safePublicRouteError(err);
        return res.status(statusCode).json({ ok: false, errorCode, error: publicMessage });
    }
}

// ── Wire Routers ─────────────────────────────────────────────────────────────

// Canonical mediaRouter: handles /ingest, /upload, /:id
mediaRouter.use(requireAuth);
mediaRouter.post("/ingest", upload, handleMediaIngest);
mediaRouter.post("/upload", upload, handleAssetUpload);
mediaRouter.get("/:id", handleGetMedia);
mediaRouter.delete("/:id", handleDeleteMedia);

// Legacy assetsRouter compatibility
assetsRouter.use(requireAuth);
assetsRouter.post("/upload", upload, handleAssetUpload);
assetsRouter.delete("/:id", handleDeleteMedia);
assetsRouter.patch("/:assetId/folder", handleMoveToFolder);

// Legacy mediaIngestRouter compatibility
mediaIngestRouter.use(requireAuth);
mediaIngestRouter.post("/ingest", upload, handleMediaIngest);

export default mediaRouter;
