/**
 * BinaryIngestionService
 * Pure Platform Media Ingestion Core.
 *
 * Owns:
 * - Ingestion of raw binary and external media sources (Buffer, Base64, URL)
 * - Safe streaming reads with size limits & SSRF protection (SourceReader)
 * - Media deep inspection (magic bytes, true MIME, dimensions, duration)
 * - SourcePolicy metadata validation
 * - Oversized image optimization (Sharp WebP resize for 4K+)
 * - Cloud storage upload (StorageService)
 *
 * Independent of workflows, media database records, and application orchestration.
 *
 * Public methods:
 * - ingestBinary(options)
 */

import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { SourceResolver } from "./SourceResolver.js";
import { SourcePolicy } from "./SourcePolicy.js";
import { SourceReader } from "./SourceReader.js";
import { MediaInspector } from "./MediaInspector.js";
import { StoragePathResolver } from "../storage/StoragePathResolver.js";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { calculateAspectRatio } from "../../utils/ratioUtils.js";

export class BinaryIngestionService {
    /**
     * @param {Object} deps
     * @param {Object} deps.storageService - Canonical StorageService instance
     */
    constructor({ storageService }) {
        this.storageService = storageService;
    }

    _extFromMime(mime = "") {
        const map = {
            "image/jpeg": "jpg",
            "image/png": "png",
            "image/webp": "webp",
            "image/gif": "gif",
            "image/avif": "avif",
            "video/mp4": "mp4",
            "video/webm": "webm",
            "video/quicktime": "mov",
        };
        return map[mime] || "bin";
    }

    /**
     * Ingests a raw binary/external source into storage:
     * Reads, inspects, validates against SourcePolicy, transforms (Sharp WebP if > 2048),
     * and uploads to storage.
     *
     * Pure binary ingestion: Does NOT create workflows, media rows, or entity relations.
     * Does NOT return large binary buffers in the result payload.
     *
     * @param {Object} options
     * @param {any} options.source - Multipart file, Buffer, Base64 data URI, or URL
     * @param {string} options.userId - Authenticated user ID
     * @param {string} [options.purpose="default"] - SourcePolicy profile name
     * @param {string} [options.folder] - Storage target folder override
     * @param {string} [options.displayName] - Optional display name hint
     * @returns {Promise<{
     *   url: string,
     *   type: "image" | "video",
     *   width: number,
     *   height: number,
     *   ratio: string,
     *   format: string,
     *   sizeBytes: number,
     *   originalName?: string,
     *   inspection: Object
     * }>}
     */
    async ingestBinary(options) {
        const {
            source,
            userId,
            purpose = "default",
            folder = null,
            displayName = null,
        } = options;
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "binaryIngest:start", userId, purpose });

        if (!userId) {
            throw new CrudServiceError("User ID is required for binary media ingestion.", {
                statusCode: 401,
                errorCode: "UNAUTHORIZED",
                traceId,
                operation: "binaryIngest",
            });
        }

        // Reject unsafe storage folders before any read/inspection, so traversal
        // input cannot reach the object-key construction (projectAsset's invariant).
        if (folder) {
            StoragePathResolver.validateFolderSegment(folder);
        }

        const descriptor = SourceResolver.resolve(source);
        if (descriptor.kind === "media_id") {
            throw new CrudServiceError(`Cannot ingest media_id "${descriptor.value}" as binary. Use canonical media reference directly.`, {
                statusCode: 400,
                errorCode: "VALIDATION_ERROR",
                traceId,
                operation: "binaryIngest",
            });
        }

        const profile = SourcePolicy.getProfile(purpose);

        // 1. Read content safely (enforcing streaming byte limits & SSRF checks)
        const { buffer, originalName, mimeHint } = await SourceReader.read(descriptor, profile);

        // 2. Inspect content deeply (magic bytes, true MIME, dimensions, duration)
        const inspection = await MediaInspector.inspect(buffer, mimeHint);

        // 3. Validate inspected metadata against policy constraints
        SourcePolicy.validateMetadata(inspection, profile);

        // 4. Optimize oversized (4K+) images for ultra-fast, smooth web rendering
        let uploadBuffer = buffer;
        let uploadMime = inspection.detectedMime;
        let finalWidth = inspection.width;
        let finalHeight = inspection.height;
        let finalSizeBytes = inspection.sizeBytes;
        let finalRatio = inspection.ratio;

        if (inspection.type === "image" && (inspection.width > 2048 || inspection.height > 2048)) {
            try {
                const optimized = await sharp(buffer)
                    .rotate()
                    .resize({
                        width: 2048,
                        height: 2048,
                        fit: "inside",
                        withoutEnlargement: true,
                    })
                    .webp({ quality: 85 })
                    .toBuffer({ resolveWithObject: true });

                uploadBuffer = optimized.data;
                uploadMime = "image/webp";
                finalWidth = optimized.info.width;
                finalHeight = optimized.info.height;
                finalSizeBytes = optimized.data.length;
                finalRatio = calculateAspectRatio(finalWidth, finalHeight);
            } catch (optErr) {
                crudOperationLog({
                    traceId,
                    operation: "binaryIngest:optimize4k",
                    status: "warning",
                    message: optErr?.message,
                });
            }
        }

        // 5. Generate storage path and upload
        const ext = this._extFromMime(uploadMime);
        const targetFolder = folder || (inspection.type === "video" ? "video_uploads" : "uploads");
        const filename = `${Date.now()}_${randomUUID().substring(0, 8)}.${ext}`;
        const storagePath = this.storageService.paths.projectAsset(userId, targetFolder, filename);

        const publicUrl = await this.storageService.upload(storagePath, uploadBuffer, {
            contentType: uploadMime,
        });

        crudOperationLog({
            traceId,
            operation: "binaryIngest:success",
            status: "ok",
            durationMs: Date.now() - start,
            url: publicUrl,
        });

        return {
            url: publicUrl,
            type: inspection.type,
            width: finalWidth,
            height: finalHeight,
            ratio: finalRatio,
            format: uploadMime.split("/")[1]?.toUpperCase() || inspection.format,
            sizeBytes: finalSizeBytes,
            originalName: displayName || originalName,
            inspection,
        };
    }
}

export default BinaryIngestionService;
