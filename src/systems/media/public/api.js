/**
 * System 4: Media & Storage — Public HTTP Gateway (Rule 1, Rule 3, Rule 4, Rule 13)
 *
 * Exposes Express routes for media ingestion, uploads, retrieval, and deletion,
 * plus the canonical multipart upload middleware factory.
 */

import { Router } from "express";
import multer from "multer";
import { createLogger, safePublicRouteError, AppError } from "#shared";
import { requireAuth } from "#identity/tools";
import { DEFAULT_UPLOAD_POLICY } from "../internal/ingestion/UploadPolicy.js";
import { SourcePolicy } from "../internal/ingestion/SourcePolicy.js";
import { createSizeLimitedMemoryStorage } from "../internal/ingestion/sizeLimitedStorage.js";
import {
    getAssetUploadService,
    getWorkflowService,
} from "../internal/services/serviceAccessor.js";
import {
    getMediaById,
    deleteMedia,
    getMediaRepository,
} from "./tools.js";

const routeLogger = createLogger("route:media");
const uploadMiddlewareLogger = createLogger("upload-middleware");

// ── Multipart Upload Middleware Factory ──────────────────────────────────────

export function resolveMiddlewarePolicy(policyOrPurpose) {
    if (policyOrPurpose && typeof policyOrPurpose === "object" && Array.isArray(policyOrPurpose.allowedTypes)) {
        const imageLimit = policyOrPurpose.maxImageSize ?? 0;
        const videoLimit = policyOrPurpose.maxVideoSize ?? 0;
        const maxSizeBytes = Math.max(imageLimit, videoLimit);
        return {
            isPolicyObject: true,
            imageLimit,
            videoLimit,
            maxSizeBytes,
            allowedMimeTypes: policyOrPurpose.allowedMimeTypes,
            streamAllowedMimeTypes: policyOrPurpose.allowedMimeTypes,
            allowedTypes: policyOrPurpose.allowedTypes,
        };
    }

    const profile = SourcePolicy.getProfile(policyOrPurpose);
    return {
        isPolicyObject: false,
        imageLimit: profile.imageLimit ?? profile.maxSizeBytes,
        videoLimit: profile.videoLimit ?? profile.maxSizeBytes,
        maxSizeBytes: profile.maxSizeBytes,
        allowedMimeTypes: profile.allowedMimeTypes,
        streamAllowedMimeTypes: null,
        allowedTypes: profile.allowedTypes,
    };
}

function createMimeFileFilter(allowedMimeTypes) {
    return (_req, file, cb) => {
        if (allowedMimeTypes && !allowedMimeTypes.includes(file.mimetype)) {
            const err = new Error(`Unsupported file type: ${file.mimetype}`);
            err.statusCode = 415;
            err.code = "UNSUPPORTED_MEDIA_TYPE";
            return cb(err);
        }
        cb(null, true);
    };
}

function sendMiddlewareError(err, req, res, next, resolvedPolicy) {
    if (err.code === "LIMIT_FILE_SIZE" || err.statusCode === 413) {
        const isImage =
            err.message?.toLowerCase().includes("image") ||
            req.file?.mimetype?.startsWith("image/");
        const limitMB =
            isImage && resolvedPolicy.imageLimit
                ? (resolvedPolicy.imageLimit / (1024 * 1024)).toFixed(0)
                : (resolvedPolicy.maxSizeBytes / (1024 * 1024)).toFixed(0);

        return res.status(413).json({
            ok: false,
            code: "PAYLOAD_TOO_LARGE",
            message: isImage
                ? `Image file exceeds maximum allowed size of ${limitMB}MB`
                : err.message || "File exceeds maximum allowed size",
        });
    }

    if (err.name === "MulterError" || err instanceof multer.MulterError) {
        uploadMiddlewareLogger.warn(
            {
                event: "upload.multer_validation_error",
                multerCode: err.code,
                userId: req.user?.id,
                projectId: req.body?.project_id || req.body?.projectId,
            },
            `[UPLOAD] Multer validation rejected: ${err.code}`
        );

        return res.status(400).json({
            ok: false,
            code: "VALIDATION_ERROR",
            message: err.message || "Invalid upload request",
        });
    }

    if (err.code === "UNSUPPORTED_MEDIA_TYPE" || err.statusCode === 415) {
        return res.status(415).json({
            ok: false,
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: err.message || "Unsupported file type",
        });
    }

    if (err.statusCode === 429) {
        return res.status(429).json({
            ok: false,
            code: "TOO_MANY_CONCURRENT_UPLOADS",
            message: err.message,
        });
    }

    if (err.statusCode === 503) {
        return res.status(503).json({
            ok: false,
            code: "SERVICE_UNAVAILABLE",
            message: err.message,
        });
    }

    return next(err);
}

export function createUploadMiddleware(policyOrPurpose = "default", fieldName = "file", options = {}) {
    const resolvedPolicy = resolveMiddlewarePolicy(policyOrPurpose);

    const storage = createSizeLimitedMemoryStorage({
        imageLimit: resolvedPolicy.imageLimit,
        videoLimit: resolvedPolicy.videoLimit,
        defaultLimit: resolvedPolicy.maxSizeBytes,
        allowedMimeTypes: resolvedPolicy.streamAllowedMimeTypes,
        maxInFlightBytes: options.maxInFlightBytes || null,
    });

    const upload = multer({
        storage,
        limits: { fileSize: resolvedPolicy.maxSizeBytes },
        fileFilter: createMimeFileFilter(resolvedPolicy.allowedMimeTypes),
    });

    const singleHandler = upload.single(fieldName);

    return (req, res, next) => {
        singleHandler(req, res, (err) => {
            if (err) {
                return sendMiddlewareError(err, req, res, next, resolvedPolicy);
            }

            if (req.file) {
                const effectiveMime = req.file.detectedMimetype || req.file.mimetype || "";
                if (
                    effectiveMime.startsWith("image/") &&
                    resolvedPolicy.imageLimit &&
                    req.file.size > resolvedPolicy.imageLimit
                ) {
                    const sizeErr = new Error("Image file exceeds maximum allowed size");
                    sizeErr.code = "LIMIT_FILE_SIZE";
                    sizeErr.statusCode = 413;
                    return sendMiddlewareError(sizeErr, req, res, next, resolvedPolicy);
                }
            }

            return next();
        });
    };
}

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

        const rawFolder = req.body?.folder_id ?? req.body?.folderId ?? req.body?.collection_id ?? req.query?.folder_id ?? req.query?.folderId ?? req.query?.collection_id ?? req.query?.collectionId ?? null;
        const normalizedFolder = (rawFolder && !["null", "undefined", "none", ""].includes(String(rawFolder).trim().toLowerCase()))
            ? String(rawFolder).trim()
            : null;

        const assetUploadService = getAssetUploadService();
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

        const assetUploadService = getAssetUploadService();
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

        const workflowService = getWorkflowService();
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

        const workflowService = getWorkflowService();
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
