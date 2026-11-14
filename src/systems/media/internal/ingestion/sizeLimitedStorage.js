/**
 * createSizeLimitedMemoryStorage
 *
 * Multer storage engine that performs early magic-byte inspection on the first chunk
 * and limits in-memory buffering per detected media type:
 * - Inspects initial chunk magic bytes immediately, aborting without buffering if
 *   payload is dangerous, not an allowed image/video, or does not match declared MIME.
 * - Applies 20MB/100MB cap based on DETECTED type (not client-chosen header).
 * - Enforces per-user concurrent upload limits (default 3, configurable via central config).
 */

import { envConfig } from "#shared";
import { MediaInspector } from "./MediaInspector.js";

const DEFAULT_MAX_CONCURRENT_UPLOADS = 3;
const activeUploadsByUser = new Map();
let currentInFlightBytes = 0;

function getMaxConcurrentUploads() {
    return envConfig.maxConcurrentUploadsPerUser || DEFAULT_MAX_CONCURRENT_UPLOADS;
}

function getMaxInFlightUploadBytes() {
    return envConfig.maxInFlightUploadBytes || 250 * 1024 * 1024;
}

function createUnsupportedMediaError(message) {
    const err = new Error(message);
    err.code = "UNSUPPORTED_MEDIA_TYPE";
    err.statusCode = 415;
    return err;
}

function validateHeaderMagicAndMime(headerBuffer, declaredMime, allowedMimeTypes) {
    let detectedMime = null;
    try {
        detectedMime = MediaInspector.sniffMagicBytes(headerBuffer);
    } catch (sniffErr) {
        throw createUnsupportedMediaError(`Unsupported or dangerous file payload: ${sniffErr.message}`);
    }

    if (!detectedMime) {
        throw createUnsupportedMediaError("Unsupported file type or unrecognized magic bytes");
    }

    if (Array.isArray(allowedMimeTypes) && !allowedMimeTypes.includes(detectedMime)) {
        throw createUnsupportedMediaError(`Unsupported file type: ${detectedMime}`);
    }

    if (
        declaredMime &&
        !declaredMime.startsWith("application/octet-stream") &&
        !declaredMime.startsWith("multipart/") &&
        declaredMime !== detectedMime
    ) {
        throw createUnsupportedMediaError(
            `Declared MIME "${declaredMime}" does not match detected file type ("${detectedMime}").`
        );
    }

    return detectedMime;
}

export function resetActiveUploadsForTest() {
    if (!envConfig.isTest) {
        throw new Error("[sizeLimitedStorage] resetActiveUploadsForTest is only permitted when NODE_ENV === 'test'");
    }
    activeUploadsByUser.clear();
}

export function resetInFlightBytesForTest() {
    if (!envConfig.isTest) {
        throw new Error("[sizeLimitedStorage] resetInFlightBytesForTest is only permitted when NODE_ENV === 'test'");
    }
    currentInFlightBytes = 0;
}

export function getActiveUploadsCountForTest(userId) {
    if (!envConfig.isTest) {
        throw new Error("[sizeLimitedStorage] getActiveUploadsCountForTest is only permitted when NODE_ENV === 'test'");
    }
    return activeUploadsByUser.get(userId) || 0;
}

export function getInFlightBytesForTest() {
    if (!envConfig.isTest) {
        throw new Error("[sizeLimitedStorage] getInFlightBytesForTest is only permitted when NODE_ENV === 'test'");
    }
    return currentInFlightBytes;
}

export function createSizeLimitedMemoryStorage({
    imageLimit = 20 * 1024 * 1024,
    videoLimit = 100 * 1024 * 1024,
    defaultLimit = 20 * 1024 * 1024,
    allowedMimeTypes = null,
    maxInFlightBytes = null,
} = {}) {
    return {
        _handleFile(req, file, cb) {
            const instanceMaxInFlight = maxInFlightBytes || getMaxInFlightUploadBytes();
            if (currentInFlightBytes >= instanceMaxInFlight) {
                const err = new Error("Server upload capacity temporarily exceeded. Please retry shortly.");
                err.code = "SERVICE_UNAVAILABLE";
                err.statusCode = 503;
                err.retryAfter = 5;
                if (req?.res?.setHeader) req.res.setHeader("Retry-After", "5");
                return cb(err);
            }

            const userId = req.user?.id || req.ip || "anonymous";
            const maxConcurrent = getMaxConcurrentUploads();
            const currentActive = activeUploadsByUser.get(userId) || 0;

            if (currentActive >= maxConcurrent) {
                const err = new Error(`Too many concurrent uploads. Maximum allowed is ${maxConcurrent}.`);
                err.code = "TOO_MANY_CONCURRENT_UPLOADS";
                err.statusCode = 429;
                return cb(err);
            }

            activeUploadsByUser.set(userId, currentActive + 1);

            let uploadInFlightBytes = 0;
            let released = false;
            const releaseSlot = () => {
                if (!released) {
                    released = true;
                    currentInFlightBytes = Math.max(0, currentInFlightBytes - uploadInFlightBytes);
                    uploadInFlightBytes = 0;
                    const count = activeUploadsByUser.get(userId) || 1;
                    if (count <= 1) {
                        activeUploadsByUser.delete(userId);
                    } else {
                        activeUploadsByUser.set(userId, count - 1);
                    }
                }
            };

            file.stream.on("close", releaseSlot);
            file.stream.on("aborted", releaseSlot);
            if (req && typeof req.on === "function") {
                req.on("close", () => {
                    if (!file.stream.readableEnded) {
                        releaseSlot();
                    }
                });
                req.on("aborted", releaseSlot);
                req.on("timeout", releaseSlot);
            }

            let detectedMime = null;
            let maxBytes = defaultLimit;
            let headerBuffer = Buffer.alloc(0);
            let headerSniffed = false;

            const chunks = [];
            let totalBytes = 0;
            let aborted = false;

            const abortStreamWithError = (err) => {
                aborted = true;
                releaseSlot();
                file.stream.pause();
                file.stream.destroy();
                return cb(err);
            };

            file.stream.on("data", (chunk) => {
                if (aborted) return;

                uploadInFlightBytes += chunk.length;
                currentInFlightBytes += chunk.length;

                if (currentInFlightBytes > instanceMaxInFlight) {
                    const err = new Error("Server upload capacity temporarily exceeded. Please retry shortly.");
                    err.code = "SERVICE_UNAVAILABLE";
                    err.statusCode = 503;
                    err.retryAfter = 5;
                    if (req?.res?.setHeader) req.res.setHeader("Retry-After", "5");
                    return abortStreamWithError(err);
                }

                if (!headerSniffed) {
                    headerBuffer = Buffer.concat([headerBuffer, chunk]);
                    if (headerBuffer.length >= 32) {
                        headerSniffed = true;
                        try {
                            detectedMime = validateHeaderMagicAndMime(headerBuffer, file.mimetype, allowedMimeTypes);
                        } catch (headerErr) {
                            return abortStreamWithError(headerErr);
                        }

                        file.detectedMimetype = detectedMime;
                        const isVideo = detectedMime.startsWith("video/");
                        const isImage = detectedMime.startsWith("image/");
                        maxBytes = isVideo ? videoLimit : (isImage ? imageLimit : defaultLimit);
                    }
                }

                totalBytes += chunk.length;
                if (totalBytes > maxBytes) {
                    const isImage = (detectedMime || file.mimetype || "").startsWith("image/");
                    const err = new Error(
                        isImage
                            ? "Image file exceeds maximum allowed size of 20MB"
                            : "Uploaded file exceeds maximum allowed size"
                    );
                    err.code = "LIMIT_FILE_SIZE";
                    err.statusCode = 413;
                    return abortStreamWithError(err);
                }

                chunks.push(chunk);
            });

            file.stream.on("end", () => {
                releaseSlot();
                if (aborted) return;

                if (!headerSniffed && headerBuffer.length > 0) {
                    try {
                        detectedMime = validateHeaderMagicAndMime(headerBuffer, file.mimetype, allowedMimeTypes);
                    } catch (headerErr) {
                        return cb(headerErr);
                    }
                    file.detectedMimetype = detectedMime;
                }

                const buffer = Buffer.concat(chunks, totalBytes);
                cb(null, {
                    buffer,
                    size: totalBytes,
                });
            });

            file.stream.on("error", (err) => {
                releaseSlot();
                if (!aborted) {
                    cb(err);
                }
            });
        },

        _removeFile(_req, file, cb) {
            delete file.buffer;
            cb(null);
        },
    };
}
