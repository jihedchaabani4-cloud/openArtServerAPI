/**
 * StorageService
 * @owns Physical object storage operations, storage key construction and validation, and storage provider delegation.
 *
 * Unified Platform Storage Service.
 * Serves as the central facade for all storage operations, file uploads,
 * path resolutions, and batch deletions.
 */
import { SupabaseStorageProvider } from "./providers/SupabaseStorageProvider.js";
import { StoragePathResolver, storagePathResolver } from "./StoragePathResolver.js";
import { StorageValidationError } from "./StorageErrors.js";
import { createLogger } from "../../infrastructure/logging/index.js";

const storageLogger = createLogger("storage");

function isStream(val) {
    return (
        val !== null &&
        typeof val === "object" &&
        (typeof val.pipe === "function" || typeof val[Symbol.asyncIterator] === "function" || typeof val.getReader === "function")
    );
}

/**
 * Storage-layer defense-in-depth magic-bytes inspection.
 * Rejects dangerous executable/script/archive signatures and detects common raster/video formats.
 *
 * @param {Buffer} buffer
 * @returns {string | null}
 */
function sniffStorageMagicBytes(buffer) {
    if (!buffer || buffer.length < 4) return null;

    if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
        throw new StorageValidationError("[StorageService] Executable binary payload (MZ) detected. Ingestion rejected.");
    }
    if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
        throw new StorageValidationError("[StorageService] Executable ELF binary detected. Ingestion rejected.");
    }
    const headerText = buffer.slice(0, 256).toString("utf8").toLowerCase();
    if (
        headerText.includes("<!doctype") ||
        headerText.includes("<html") ||
        headerText.includes("<script") ||
        headerText.includes("<?php")
    ) {
        throw new StorageValidationError("[StorageService] HTML / Script markup payload detected. Ingestion rejected.");
    }
    if (
        headerText.includes("<svg") ||
        headerText.includes("<?xml") ||
        headerText.includes("<xml") ||
        headerText.includes('xmlns="http://www.w3.org/2000/svg"')
    ) {
        throw new StorageValidationError(
            "[StorageService] SVG / XML markup payload detected. Vector graphics and scriptable XML are not permitted in raster image ingestion."
        );
    }
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
        throw new StorageValidationError("[StorageService] ZIP archive payload (PK) detected. Ingestion rejected.");
    }

    if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
    ) {
        return "image/png";
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return "image/jpeg";
    }
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
        return "image/gif";
    }
    if (
        buffer.length >= 12 &&
        buffer.slice(0, 4).toString("ascii") === "RIFF" &&
        buffer.slice(8, 12).toString("ascii") === "WEBP"
    ) {
        return "image/webp";
    }
    if (buffer.length >= 8) {
        const box = buffer.slice(4, 8).toString("ascii").toLowerCase();
        if (box === "moov" || box === "wide") {
            return "video/quicktime";
        }
    }
    if (buffer.length >= 12 && buffer.slice(4, 8).toString("ascii") === "ftyp") {
        const brand = buffer.slice(8, 12).toString("ascii").toLowerCase();
        if (brand.includes("avif") || brand.includes("avis")) {
            return "image/avif";
        }
        if (
            brand.includes("heic") ||
            brand.includes("heix") ||
            brand.includes("heim") ||
            brand.includes("heis") ||
            brand.includes("mif1") ||
            brand.includes("msf1")
        ) {
            return "image/heic";
        }
        if (brand.includes("qt")) {
            return "video/quicktime";
        }
        return "video/mp4";
    }
    if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
        return "video/webm";
    }

    return null;
}

const SAFE_MEDIA_MIME_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
    "image/heic",
    "image/heif",
    "image/bmp",
    "image/tiff",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/x-matroska",
    "video/avi",
    "video/mpeg",
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/x-wav",
    "audio/aac",
    "audio/ogg",
    "audio/webm",
    "audio/flac",
    "application/octet-stream",
]);

const DANGEROUS_MIME_TYPES = new Set([
    "text/html",
    "image/svg+xml",
    "application/xml",
    "text/xml",
    "application/x-sh",
    "application/javascript",
    "text/javascript",
    "application/zip",
    "application/x-zip-compressed",
    "application/x-msdownload",
    "application/x-executable",
]);

export class StorageService {
    constructor(bucketName = "generated_images", provider = null) {
        this.bucketName = bucketName;
        this.provider = provider || new SupabaseStorageProvider({ bucketName });
        // Transitional backward-compatible exposure for legacy callers (`storageService.paths.projectAsset(...)`).
        // Consumers should progressively migrate to `storageService.buildKey(...)` and `storageService.validateFolder(...)`.
        this.paths = storagePathResolver;
    }

    /**
     * Builds a validated user-scoped storage key: `<cleanUserId>/<validatedFolder>/<filename>`.
     */
    buildKey({ userId, folder = "uploads", filename } = {}) {
        return this.paths.projectAsset(userId, folder, filename);
    }

    /**
     * Validates a storage folder segment against the canonical folder allowlist.
     */
    validateFolder(folder) {
        return StoragePathResolver.validateFolderSegment(folder);
    }

    /**
     * Extracts relative bucket storage key from a full public CDN URL or relative path.
     */
    extractKey(url) {
        return this.paths.extractStoragePath(url, this.bucketName);
    }

    /**
     * Extract storage path from a full public CDN URL (compatibility alias for extractKey).
     */
    extractStoragePath(url) {
        return this.extractKey(url);
    }

    /**
     * Upload buffer, stream, or base64 string to storage path.
     * Automatically infers MIME content-type from extension or options.
     *
     * @param {string} path - Destination storage path
     * @param {string|Buffer|import("node:stream").Readable} payload - Data payload
     * @param {Object} [options] - Additional upload options
     * @returns {Promise<string>} Public URL
     */
    async upload(path, payload, options = {}) {
        let body;
        if (isStream(payload)) {
            body = payload;
        } else if (typeof payload === "string") {
            const pureBase64 = payload.includes(",")
                ? payload.split(",")[1]
                : payload;
            body = Buffer.from(pureBase64, "base64");
        } else {
            body = payload;
        }

        // Validate magic bytes to prevent writing dangerous files into storage
        let detectedMime = null;
        if (Buffer.isBuffer(body) && body.length >= 4) {
            detectedMime = sniffStorageMagicBytes(body);
        }

        const isProviderOrInternal = Boolean(
            options.isProviderOutput ||
            options.isInternal ||
            options.origin === "provider" ||
            options.origin === "internal"
        );

        let declaredMime = options.contentType || options.declaredMime || options.mimetype;

        // Determine content type based on path extension if not explicitly specified
        let contentType = declaredMime || null;
        if (!declaredMime) {
            const lowerPath = path.toLowerCase();
            if (lowerPath.endsWith(".png")) contentType = "image/png";
            else if (lowerPath.endsWith(".webp")) contentType = "image/webp";
            else if (lowerPath.endsWith(".gif")) contentType = "image/gif";
            else if (lowerPath.endsWith(".avif")) contentType = "image/avif";
            else if (lowerPath.endsWith(".svg")) contentType = "image/svg+xml";
            else if (lowerPath.endsWith(".mp4")) contentType = "video/mp4";
            else if (lowerPath.endsWith(".webm")) contentType = "video/webm";
            else if (lowerPath.endsWith(".mov")) contentType = "video/quicktime";
            else if (lowerPath.endsWith(".mkv")) contentType = "video/x-matroska";
            else if (lowerPath.endsWith(".heic")) contentType = "image/heic";
            else if (lowerPath.endsWith(".mp3")) contentType = "audio/mpeg";
            else if (lowerPath.endsWith(".wav")) contentType = "audio/wav";
            else if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) contentType = "image/jpeg";
            else contentType = isProviderOrInternal ? "application/octet-stream" : "image/jpeg";
            declaredMime = contentType;
        }

        if (isProviderOrInternal) {
            // Reject dangerous declared MIME types even if bytes were unrecognized
            if (declaredMime && DANGEROUS_MIME_TYPES.has(declaredMime.toLowerCase())) {
                throw new StorageValidationError(`[StorageService] Dangerous MIME type "${declaredMime}" rejected for provider output.`);
            }

            if (detectedMime) {
                // Provider outputs / internal copies: use DETECTED type and ignore wrong/generic declared MIME
                contentType = detectedMime;
            } else {
                // Unrecognized but non-dangerous format: safe allow-list or fallback to application/octet-stream
                if (declaredMime && SAFE_MEDIA_MIME_TYPES.has(declaredMime.toLowerCase())) {
                    contentType = declaredMime.toLowerCase();
                } else {
                    contentType = "application/octet-stream";
                }
                const runId = options.runId || "none";
                const model = options.model || "none";
                const provider = options.provider || options.providerId || "none";
                storageLogger.warn(
                    { event: "storage.fallback_type", runId, model, provider, contentType },
                    "Unrecognized format for provider asset; falling back to safe type"
                );
            }
        } else {
            // End-user uploads: enforce strict declared == real format
            if (
                declaredMime &&
                detectedMime &&
                !declaredMime.startsWith("application/octet-stream") &&
                !declaredMime.startsWith("multipart/")
            ) {
                if (declaredMime !== detectedMime) {
                    throw new StorageValidationError(
                        `[StorageService] Content inspection failed: declared MIME "${declaredMime}" does not match file bytes ("${detectedMime}").`
                    );
                }
            }
            if (detectedMime) {
                contentType = detectedMime;
            }
        }

        try {
            return await this.provider.upload(path, body, {
                ...options,
                contentType,
                upsert: true,
            });
        } catch (error) {
            storageLogger.error({ event: "storage.upload_error", err: error.message }, "Storage upload error");
            throw error;
        }
    }

    /**
     * Resolve the public URL for a storage path.
     */
    async getPublicUrl(path) {
        return await this.provider.getPublicUrl(path);
    }

    /**
     * Delete a single storage path
     */
    async delete(path) {
        try {
            await this.provider.delete(path);
        } catch (error) {
            storageLogger.error({ event: "storage.delete_error", err: error.message }, "Storage delete error");
            throw error;
        }
    }

    /**
     * Batch delete multiple storage paths
     */
    async deleteFiles(paths = []) {
        const uniquePaths = [...new Set((paths || []).filter(Boolean))];

        if (!uniquePaths.length) {
            return { deletedCount: 0, failures: [] };
        }

        try {
            return await this.provider.deleteFiles(uniquePaths);
        } catch (error) {
            storageLogger.error({ event: "storage.batch_delete_error", err: error.message }, "Storage batch delete error");
            return {
                deletedCount: 0,
                failures: uniquePaths.map((p) => ({ path: p, error })),
            };
        }
    }

    /**
     * Delete a file directly by its public URL.
     *
     * @deprecated Transitional method preserved for backward compatibility (OD-STOR-3).
     * Prefer calling `storageService.delete(key)` or `storageService.deleteFiles([key])`
     * with validated storage keys.
     *
     * @param {string} url - Public CDN URL
     * @returns {Promise<void>}
     */
    async deleteByUrl(url) {
        const path = this.extractKey(url);
        if (!path) return;
        return await this.delete(path);
    }
}
