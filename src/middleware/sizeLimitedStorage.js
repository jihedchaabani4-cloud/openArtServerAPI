/**
 * createSizeLimitedMemoryStorage
 *
 * Multer storage engine that performs early magic-byte inspection on the first chunk
 * and limits in-memory buffering per detected media type:
 * - Inspects initial chunk magic bytes immediately, aborting without buffering if
 *   payload is dangerous, not an allowed image/video, or does not match declared MIME.
 * - Applies 20MB/100MB cap based on DETECTED type (not client-chosen header).
 * - Enforces per-user concurrent upload limits (default 2, configurable via central config).
 */

import { RATE_LIMIT_POLICIES } from "../config/rateLimitPolicies.js";
import { MediaInspector } from "../platform/media-ingestion/MediaInspector.js";

const activeUploadsByUser = new Map();

function getMaxConcurrentUploads() {
    return (
        RATE_LIMIT_POLICIES?.concurrentUploads?.limit ||
        Number(process.env.MAX_CONCURRENT_UPLOADS_PER_USER) ||
        2
    );
}

export function resetActiveUploadsForTest() {
    if (process.env.NODE_ENV !== "test") {
        throw new Error("[sizeLimitedStorage] resetActiveUploadsForTest is only permitted when NODE_ENV === 'test'");
    }
    activeUploadsByUser.clear();
}

export function getActiveUploadsCountForTest(userId) {
    if (process.env.NODE_ENV !== "test") {
        throw new Error("[sizeLimitedStorage] getActiveUploadsCountForTest is only permitted when NODE_ENV === 'test'");
    }
    return activeUploadsByUser.get(userId) || 0;
}

export function createSizeLimitedMemoryStorage({
    imageLimit = 20 * 1024 * 1024,
    videoLimit = 100 * 1024 * 1024,
    defaultLimit = 20 * 1024 * 1024,
} = {}) {
    return {
        _handleFile(req, file, cb) {
            // ── 1. Per-User Concurrent Upload Limiter ─────────────────────────────
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

            let released = false;
            const releaseSlot = () => {
                if (!released) {
                    released = true;
                    const count = activeUploadsByUser.get(userId) || 1;
                    if (count <= 1) {
                        activeUploadsByUser.delete(userId);
                    } else {
                        activeUploadsByUser.set(userId, count - 1);
                    }
                }
            };

            // Release slot on client abort, stream error, or connection termination
            file.stream.on("close", releaseSlot);
            file.stream.on("aborted", releaseSlot);
            if (req && typeof req.on === "function") {
                req.on("close", () => {
                    if (!file.stream.readableEnded) {
                        releaseSlot();
                    }
                });
                req.on("aborted", releaseSlot);
            }

            // ── 2. Streaming Chunk Handler & Early Magic-Bytes Sniff ──────────────
            let detectedMime = null;
            let maxBytes = defaultLimit;
            let headerBuffer = Buffer.alloc(0);
            let headerSniffed = false;

            const chunks = [];
            let totalBytes = 0;
            let aborted = false;

            file.stream.on("data", (chunk) => {
                if (aborted) return;

                // Early sniff on first bytes received (buffer up to 32 bytes for longest signature)
                if (!headerSniffed) {
                    headerBuffer = Buffer.concat([headerBuffer, chunk]);
                    if (headerBuffer.length >= 32) {
                        headerSniffed = true;
                        try {
                            detectedMime = MediaInspector.sniffMagicBytes(headerBuffer);
                        } catch (sniffErr) {
                            aborted = true;
                            releaseSlot();
                            file.stream.pause();
                            file.stream.destroy();
                            const err = new Error(`Unsupported or dangerous file payload: ${sniffErr.message}`);
                            err.code = "UNSUPPORTED_MEDIA_TYPE";
                            err.statusCode = 415;
                            return cb(err);
                        }

                        if (!detectedMime) {
                            aborted = true;
                            releaseSlot();
                            file.stream.pause();
                            file.stream.destroy();
                            const err = new Error(`Unsupported file type or unrecognized magic bytes`);
                            err.code = "UNSUPPORTED_MEDIA_TYPE";
                            err.statusCode = 415;
                            return cb(err);
                        }

                        // Check match with declared MIME type
                        const declaredMime = file.mimetype;
                        if (
                            declaredMime &&
                            !declaredMime.startsWith("application/octet-stream") &&
                            !declaredMime.startsWith("multipart/")
                        ) {
                            if (declaredMime !== detectedMime) {
                                aborted = true;
                                releaseSlot();
                                file.stream.pause();
                                file.stream.destroy();
                                const err = new Error(
                                    `Declared MIME "${declaredMime}" does not match detected file type ("${detectedMime}").`
                                );
                                err.code = "UNSUPPORTED_MEDIA_TYPE";
                                err.statusCode = 415;
                                return cb(err);
                            }
                        }

                        file.detectedMimetype = detectedMime;

                        // Apply 20MB/100MB cap based on DETECTED type
                        const isVideo = detectedMime.startsWith("video/");
                        const isImage = detectedMime.startsWith("image/");
                        maxBytes = isVideo ? videoLimit : (isImage ? imageLimit : defaultLimit);
                    }
                }

                totalBytes += chunk.length;
                if (totalBytes > maxBytes) {
                    aborted = true;
                    releaseSlot();
                    file.stream.pause();
                    file.stream.destroy();
                    const isImage = (detectedMime || file.mimetype || "").startsWith("image/");
                    const err = new Error(
                        isImage
                            ? "Image file exceeds maximum allowed size of 20MB"
                            : "Uploaded file exceeds maximum allowed size"
                    );
                    err.code = "LIMIT_FILE_SIZE";
                    err.statusCode = 413;
                    return cb(err);
                }

                chunks.push(chunk);
            });

            file.stream.on("end", () => {
                releaseSlot();
                if (aborted) return;

                if (!headerSniffed && headerBuffer.length > 0) {
                    try {
                        detectedMime = MediaInspector.sniffMagicBytes(headerBuffer);
                    } catch (err) {
                        const e = new Error(`Unsupported or dangerous file payload: ${err.message}`);
                        e.code = "UNSUPPORTED_MEDIA_TYPE";
                        e.statusCode = 415;
                        return cb(e);
                    }
                    if (!detectedMime) {
                        const e = new Error("Unsupported file type or unrecognized magic bytes");
                        e.code = "UNSUPPORTED_MEDIA_TYPE";
                        e.statusCode = 415;
                        return cb(e);
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

        _removeFile(req, file, cb) {
            delete file.buffer;
            cb(null);
        },
    };
}
