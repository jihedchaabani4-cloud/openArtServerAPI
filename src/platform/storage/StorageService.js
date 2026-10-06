import { SupabaseStorageProvider } from "./storage/providers/SupabaseStorageProvider.js";
import { StoragePathResolver, storagePathResolver } from "./StoragePathResolver.js";
import { SourceReader } from "../media-ingestion/SourceReader.js";
import { SourcePolicy } from "../media-ingestion/SourcePolicy.js";
import { MediaInspector } from "../media-ingestion/MediaInspector.js";

/**
 * StorageService
 * Unified Platform Storage Service.
 * Serves as the central facade for all storage operations, file uploads,
 * path resolutions, and batch deletions.
 */
function isStream(val) {
    return (
        val !== null &&
        typeof val === "object" &&
        (typeof val.pipe === "function" || typeof val[Symbol.asyncIterator] === "function" || typeof val.getReader === "function")
    );
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
        this.paths = storagePathResolver;
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
            detectedMime = MediaInspector.sniffMagicBytes(body);
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
                throw new Error(`[StorageService] Dangerous MIME type "${declaredMime}" rejected for provider output.`);
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
                console.warn(
                    `⚠️ [StorageService] Unrecognized format for provider asset. Falling back to safe type "${contentType}". runId=${runId}, model=${model}, provider=${provider}`
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
                    throw new Error(
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
            console.error("❌ [StorageService] Upload Error:", error);
            throw error;
        }
    }

    /**
     * Upload a buffer directly to storage path with MIME integrity verification.
     */
    async uploadBuffer(path, buffer, options = {}) {
        return this.upload(path, buffer, options);
    }

    /**
     * Upload a readable stream directly to storage path with zero full-file RAM buffering.
     */
    async uploadStream(path, stream, options = {}) {
        return this.upload(path, stream, options);
    }

    /**
     * Download from external URL and upload to internal storage bucket.
     * Enforces SSRF defense, redirect re-validation, size limits, and MIME policy via SourceReader & SourcePolicy.
     *
     * @param {string} path - Destination storage path
     * @param {string} url - Source remote URL
     * @param {Object} [options]
     * @returns {Promise<string>} Public URL
     */
    async uploadFromUrl(path, url, options = {}) {
        if (!url) throw new Error("URL is required for uploadFromUrl");
        try {
            const profile = options.profile || SourcePolicy.getProfile(options.purpose || "default");
            const { buffer, mimeHint } = await SourceReader.read(
                { kind: "url", value: url },
                profile
            );

            // Sniff magic bytes to detect disguised scripts / executable payloads
            let sniffedMime = null;
            try {
                sniffedMime = MediaInspector.sniffMagicBytes(buffer);
            } catch (err) {
                // If dangerous payload (HTML/script/executable) detected, reject immediately
                throw new Error(`[SourcePolicy] File format validation failed: ${err.message}`);
            }

            const isProviderOrInternal = Boolean(
                options.isProviderOutput ||
                options.isInternal ||
                options.origin === "provider" ||
                options.origin === "internal" ||
                (options.isProviderOutput !== false && !options.isEndUserUpload)
            );

            // Enforce MIME restrictions using detected MIME (or mimeHint fallback)
            const effectiveMime = sniffedMime || mimeHint;
            if (!isProviderOrInternal && profile.allowedMimeTypes && effectiveMime && !profile.allowedMimeTypes.includes(effectiveMime)) {
                throw new Error(
                    `[SourcePolicy] File format "${effectiveMime}" is not allowed for this operation. Allowed: ${profile.allowedMimeTypes.join(", ")}`
                );
            }

            return await this.upload(path, buffer, {
                isProviderOutput: isProviderOrInternal,
                ...options,
                contentType: sniffedMime || options.contentType || mimeHint || undefined,
            });
        } catch (e) {
            console.error("❌ [StorageService] uploadFromUrl Error:", e.message || e);
            throw e;
        }
    }

    /**
     * Delete a single storage path
     */
    async delete(path) {
        try {
            await this.provider.delete(path);
        } catch (error) {
            console.error("❌ [StorageService] Delete Error:", error);
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
            console.error("❌ [StorageService] Batch Delete Error:", error);
            return {
                deletedCount: 0,
                failures: uniquePaths.map((p) => ({ path: p, error })),
            };
        }
    }

    /**
     * Extract storage path from a full public CDN URL
     */
    extractStoragePath(url) {
        return this.paths.extractStoragePath(url, this.bucketName);
    }

    /**
     * Delete a file directly by its public URL
     */
    async deleteByUrl(url) {
        const path = this.extractStoragePath(url);
        if (!path) return;
        return await this.delete(path);
    }

    /**
     * Batch delete files by their public URLs
     */
    async deleteByUrls(urls = []) {
        const paths = (urls || [])
            .map((u) => this.extractStoragePath(u))
            .filter(Boolean);
        return await this.deleteFiles(paths);
    }

    remove(path) {
        return this.delete(path);
    }
}

export const storageService = new StorageService();
export default storageService;
