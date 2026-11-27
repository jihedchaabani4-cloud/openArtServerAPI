/**
 * System 4: Media & Storage — Public HTTP Gateway (Rule 1, Rule 3, Rule 4, Rule 13)
 *
 * Sealed gateway exposing ONLY mediaIngestRouter, assetsRouter, and createUploadMiddleware.
 */

import { Router } from "express";
import multer from "multer";
import { createLogger } from "#shared";
import { requireAuth } from "#identity/tools";
import { DEFAULT_UPLOAD_POLICY, resolveMiddlewarePolicy } from "../internal/ingestion/UploadPolicy.js";
import { createSizeLimitedMemoryStorage } from "../internal/ingestion/sizeLimitedStorage.js";
import { ValidationError } from "../internal/errors.js";
import {
    handleMediaIngest,
    handleAssetUpload,
    handleDeleteMedia,
    handleMoveToFolder,
} from "../internal/controllers/mediaController.js";

const uploadMiddlewareLogger = createLogger("upload-middleware");

function createMimeFileFilter(allowedMimeTypes) {
    return (_req, file, cb) => {
        if (allowedMimeTypes && !allowedMimeTypes.includes(file.mimetype)) {
            return cb(
                new ValidationError(`Unsupported file type: ${file.mimetype}`, {
                    statusCode: 415,
                    code: "UNSUPPORTED_MEDIA_TYPE",
                })
            );
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
                    const sizeErr = new ValidationError("Image file exceeds maximum allowed size", {
                        statusCode: 413,
                        code: "LIMIT_FILE_SIZE",
                    });
                    return sendMiddlewareError(sizeErr, req, res, next, resolvedPolicy);
                }
            }

            return next();
        });
    };
}

export const assetsRouter = Router();
export const mediaIngestRouter = Router();

const upload = createUploadMiddleware(DEFAULT_UPLOAD_POLICY);

// /api/assets
assetsRouter.use(requireAuth);
assetsRouter.post("/upload", upload, handleAssetUpload);
assetsRouter.delete("/:id", handleDeleteMedia);
assetsRouter.patch("/:assetId/folder", handleMoveToFolder);

// /api/media
mediaIngestRouter.use(requireAuth);
mediaIngestRouter.post("/ingest", upload, handleMediaIngest);
