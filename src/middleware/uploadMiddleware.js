/**
 * uploadMiddleware.js
 * Canonical Multipart Upload Middleware factory for apiOpenArt.
 *
 * Derives early streaming size limits and MIME filters directly from SourcePolicy.
 * Ensures consistent HTTP 413 (PAYLOAD_TOO_LARGE) and 415 (UNSUPPORTED_MEDIA_TYPE) responses.
 */

import multer from "multer";
import { SourcePolicy } from "../platform/media-ingestion/SourcePolicy.js";
import { createSizeLimitedMemoryStorage } from "./sizeLimitedStorage.js";

export function createUploadMiddleware(purpose = "default", fieldName = "file") {
    const profile = SourcePolicy.getProfile(purpose);

    const storage = createSizeLimitedMemoryStorage({
        imageLimit: profile.imageLimit ?? profile.maxSizeBytes,
        videoLimit: profile.videoLimit ?? profile.maxSizeBytes,
        defaultLimit: profile.maxSizeBytes,
    });

    const upload = multer({
        storage,
        limits: { fileSize: profile.maxSizeBytes },
        fileFilter: (req, file, cb) => {
            if (profile.allowedMimeTypes && !profile.allowedMimeTypes.includes(file.mimetype)) {
                const err = new Error(`Unsupported file type: ${file.mimetype}`);
                err.statusCode = 415;
                err.code = "UNSUPPORTED_MEDIA_TYPE";
                return cb(err);
            }
            cb(null, true);
        },
    });

    const singleHandler = upload.single(fieldName);

    return (req, res, next) => {
        singleHandler(req, res, (err) => {
            if (err) {
                if (err.code === "LIMIT_FILE_SIZE" || err.statusCode === 413) {
                    const isImage = (err.message && err.message.toLowerCase().includes("image")) ||
                        (req.file?.mimetype && req.file.mimetype.startsWith("image/"));
                    const limitMB = isImage && profile.imageLimit
                        ? (profile.imageLimit / (1024 * 1024)).toFixed(0)
                        : (profile.maxSizeBytes / (1024 * 1024)).toFixed(0);

                    return res.status(413).json({
                        ok: false,
                        code: "PAYLOAD_TOO_LARGE",
                        message: isImage
                            ? `Image file exceeds maximum allowed size of ${limitMB}MB`
                            : (err.message || "File exceeds maximum allowed size"),
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

            // Defense in depth: Check image limit on buffered file
            if (req.file) {
                const effectiveMime = req.file.detectedMimetype || req.file.mimetype || "";
                if (effectiveMime.startsWith("image/") && profile.imageLimit && req.file.size > profile.imageLimit) {
                    const limitMB = (profile.imageLimit / (1024 * 1024)).toFixed(0);
                    return res.status(413).json({
                        ok: false,
                        code: "PAYLOAD_TOO_LARGE",
                        message: `Image file exceeds maximum allowed size of ${limitMB}MB`,
                    });
                }
            }

            next();
        });
    };
}

export default createUploadMiddleware;
