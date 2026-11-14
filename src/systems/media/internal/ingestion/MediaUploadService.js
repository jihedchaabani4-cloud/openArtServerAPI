/**
 * MediaUploadService
 * Stateless platform Media Upload service (ADR-0012).
 *
 * @owns Stateless binary media validation, 4K WebP optimization, storage upload, and compensating discard.
 *
 * Owns:
 * - Request-level file count validation (policy.maxFilesPerRequest and optional maxFiles hint)
 * - Safe source reading, magic-byte inspection, and policy metadata validation (Phase 1)
 * - 4K+ image optimization (Sharp WebP resize to policy.maxDimensionPx)
 * - Cloud storage upload and all-or-nothing batch compensation (Phase 2)
 * - Compensating storage deletion via discard(storageKeys)
 *
 * Strictly independent of Workflow, Element, Character, and database repositories.
 *
 * Public methods:
 * - upload({ files, policy, maxFiles, userId, folder })
 * - discard(storageKeys)
 */

import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { SourceResolver } from "./SourceResolver.js";
import { SourceReader } from "./SourceReader.js";
import { SourcePolicy } from "./SourcePolicy.js";
import { MediaInspector } from "./MediaInspector.js";
import { DEFAULT_UPLOAD_POLICY } from "./UploadPolicy.js";
import { ValidationError, UploadError } from "./MediaUploadErrors.js";
import { crudOperationLog, CrudServiceError, calculateAspectRatio } from "#shared";

const MIME_TO_EXT = Object.freeze({
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
});

function resolveTargetFolder(policy, mediaType, folderOverride) {
    if (folderOverride) return folderOverride;
    if (typeof policy.storageFolder === "string") return policy.storageFolder;
    if (policy.storageFolder && typeof policy.storageFolder === "object") {
        return policy.storageFolder[mediaType] || "uploads";
    }
    return mediaType === "video" ? "video_uploads" : "uploads";
}

export class MediaUploadService {
    constructor({ storageService } = {}) {
        if (
            !storageService ||
            typeof storageService.upload !== "function" ||
            typeof storageService.deleteFiles !== "function" ||
            typeof storageService.buildKey !== "function" ||
            typeof storageService.validateFolder !== "function"
        ) {
            throw new Error(
                "MediaUploadService requires storageService implementing upload, deleteFiles, buildKey, and validateFolder."
            );
        }
        this.storageService = storageService;
    }

    /**
     * Stateless two-phase batch upload.
     *
     * @param {Object} params
     * @param {Array} params.files - Non-empty array of UploadFileInput items
     * @param {Object} [params.policy=DEFAULT_UPLOAD_POLICY] - Frozen UploadPolicy preset
     * @param {number} [params.maxFiles] - Optional dynamic remaining-slot cap passed by domain caller
     * @param {string} params.userId - Authenticated user ID for storage path scoping
     * @param {string} [params.folder] - @deprecated Removed in contract cleanup ticket; defaults to policy.storageFolder
     */
    async upload({
        files,
        policy = DEFAULT_UPLOAD_POLICY,
        maxFiles = undefined,
        userId,
        /** @deprecated Removed in contract cleanup ticket; defaults to policy.storageFolder */
        folder = null,
    } = {}) {
        const traceId = randomUUID();
        const start = Date.now();

        this._assertRequestPreconditions({ files, policy, maxFiles, userId, folder, traceId });

        const validatedItems = [];
        for (const source of files) {
            const validated = await this._readAndValidateSingle(source, policy);
            validatedItems.push(validated);
        }

        const uploadContext = { policy, userId, folder, traceId };
        const uploaded = await this._optimizeAndStoreBatch(validatedItems, uploadContext);

        crudOperationLog({
            traceId,
            operation: "mediaUpload:success",
            status: "ok",
            durationMs: Date.now() - start,
            count: uploaded.length,
        });

        return { uploaded };
    }

    async discard(storageKeys = []) {
        const uniqueKeys = [...new Set((storageKeys || []).filter(Boolean))];
        if (uniqueKeys.length === 0) return;

        try {
            const result = await this.storageService.deleteFiles(uniqueKeys);
            const genuineFailures = (result?.failures || []).filter((f) => {
                const code = f?.error?.code || f?.code || f?.error?.name || f?.name || "";
                // Match ONLY structured error code from object storage (e.g. S3 NoSuchKey); never match message substrings
                const isObjectNotFoundCode = code === "NoSuchKey";
                return !isObjectNotFoundCode;
            });
            if (genuineFailures.length > 0) {
                throw new UploadError(`Failed to discard ${genuineFailures.length} storage file(s).`);
            }
        } catch (err) {
            crudOperationLog({
                operation: "mediaUpload:discard",
                status: "error",
                message: err?.message,
            });
            if (err instanceof UploadError) throw err;
            throw new UploadError(`Failed to discard storage files: ${err.message}`);
        }
    }

    _assertRequestPreconditions({ files, policy, maxFiles, userId, folder, traceId }) {
        if (!userId) {
            throw new CrudServiceError("User ID is required for media upload.", {
                statusCode: 401,
                errorCode: "UNAUTHORIZED",
                traceId,
                operation: "mediaUpload",
            });
        }

        if (folder) {
            this._validateFolderOverride(folder);
        }

        if (!Array.isArray(files) || files.length === 0) {
            throw new ValidationError("At least 1 file is required for upload.", {
                statusCode: 400,
                code: "VALIDATION_ERROR",
            });
        }

        if (policy.maxFilesPerRequest && files.length > policy.maxFilesPerRequest) {
            throw new ValidationError(
                `Too many files in request (${files.length}). Maximum allowed per request is ${policy.maxFilesPerRequest}.`,
                { statusCode: 400, code: "VALIDATION_ERROR" }
            );
        }

        if (maxFiles !== undefined && maxFiles !== null && files.length > maxFiles) {
            throw new ValidationError(
                `Upload count (${files.length}) exceeds remaining capacity (${maxFiles}).`,
                { statusCode: 400, code: "LIMIT_EXCEEDED" }
            );
        }
    }

    _validateFolderOverride(folder) {
        try {
            this.storageService.validateFolder(folder);
        } catch (folderErr) {
            throw new ValidationError(folderErr.message, {
                statusCode: 400,
                code: "VALIDATION_ERROR",
            });
        }
    }

    async _readAndValidateSingle(source, policy) {
        const descriptor = this._resolveSourceDescriptor(source);
        const { buffer, originalName, mimeHint } = await this._readDescriptorBuffer(descriptor, policy);
        const inspection = await this._inspectBuffer(buffer, mimeHint);
        SourcePolicy.validateMetadata(inspection, policy);
        return { buffer, originalName, inspection };
    }

    _resolveSourceDescriptor(source) {
        let descriptor;
        try {
            descriptor = SourceResolver.resolve(source);
        } catch (resolveErr) {
            throw new ValidationError(resolveErr.message, {
                statusCode: 400,
                code: "VALIDATION_ERROR",
            });
        }

        if (descriptor.kind === "media_id") {
            throw new ValidationError(
                `Cannot upload existing media_id "${descriptor.value}" as a binary file.`,
                { statusCode: 400, code: "VALIDATION_ERROR" }
            );
        }
        return descriptor;
    }

    async _readDescriptorBuffer(descriptor, policy) {
        try {
            return await SourceReader.read(descriptor, policy);
        } catch (readErr) {
            if (readErr instanceof ValidationError) throw readErr;
            throw new ValidationError(readErr.message, {
                statusCode: readErr.statusCode || 400,
                code: readErr.code || "VALIDATION_ERROR",
                cause: readErr,
            });
        }
    }

    async _inspectBuffer(buffer, mimeHint) {
        try {
            return await MediaInspector.inspect(buffer, mimeHint);
        } catch (inspectErr) {
            throw new ValidationError(inspectErr.message, {
                statusCode: 415,
                code: "UNSUPPORTED_MEDIA_TYPE",
            });
        }
    }

    async _optimizeAndStoreBatch(validatedItems, uploadContext) {
        const uploaded = [];
        const uploadedKeysSoFar = [];

        try {
            for (const item of validatedItems) {
                const storedItem = await this._uploadSingleOptimizedItem(item, uploadContext);
                uploadedKeysSoFar.push(storedItem.storageKey);
                uploaded.push(storedItem);
            }
            return uploaded;
        } catch (batchErr) {
            await this._compensateBatchUpload(uploadedKeysSoFar, uploadContext.traceId);
            throw batchErr;
        }
    }

    async _uploadSingleOptimizedItem(item, uploadContext) {
        const { policy, userId, folder } = uploadContext;
        const optimized = await this._prepareUploadPayload(item, policy);
        const ext = MIME_TO_EXT[optimized.mimeType] || "bin";
        const targetFolder = resolveTargetFolder(policy, optimized.type, folder);
        const filename = `${Date.now()}_${randomUUID().substring(0, 8)}.${ext}`;
        const storageKey = this.storageService.buildKey({ userId, folder: targetFolder, filename });

        let url;
        try {
            url = await this.storageService.upload(storageKey, optimized.buffer, {
                contentType: optimized.mimeType,
            });
        } catch (storageErr) {
            throw new UploadError(`Storage upload failed: ${storageErr.message}`);
        }

        return {
            url,
            storageKey,
            mimeType: optimized.mimeType,
            size: optimized.size,
            type: optimized.type,
            width: optimized.width,
            height: optimized.height,
            ratio: optimized.ratio,
            format: optimized.format,
            durationSec: optimized.durationSec,
            originalName: optimized.originalName,
        };
    }

    async _compensateBatchUpload(uploadedKeysSoFar, traceId) {
        if (uploadedKeysSoFar.length === 0) return;
        try {
            await this.discard(uploadedKeysSoFar);
        } catch (discardErr) {
            crudOperationLog({
                traceId,
                operation: "mediaUpload:compensationDiscard",
                status: "error",
                message: discardErr?.message,
            });
        }
    }

    async _prepareUploadPayload({ buffer, originalName, inspection }, policy) {
        const maxDim = policy.maxDimensionPx || 2048;
        const needsResize =
            inspection.type === "image" &&
            (inspection.width > maxDim || inspection.height > maxDim);

        if (needsResize) {
            return this._resizeOversizedImage(buffer, originalName, maxDim);
        }

        return {
            buffer,
            mimeType: inspection.detectedMime,
            size: inspection.sizeBytes,
            type: inspection.type,
            width: inspection.width,
            height: inspection.height,
            ratio: inspection.ratio,
            format: inspection.detectedMime.split("/")[1]?.toUpperCase() || inspection.format,
            durationSec: inspection.durationSec ?? null,
            originalName,
        };
    }

    async _resizeOversizedImage(buffer, originalName, maxDim) {
        try {
            const optimized = await sharp(buffer)
                .rotate()
                .resize({
                    width: maxDim,
                    height: maxDim,
                    fit: "inside",
                    withoutEnlargement: true,
                })
                .webp({ quality: 85 })
                .toBuffer({ resolveWithObject: true });

            return {
                buffer: optimized.data,
                mimeType: "image/webp",
                size: optimized.data.length,
                type: "image",
                width: optimized.info.width,
                height: optimized.info.height,
                ratio: calculateAspectRatio(optimized.info.width, optimized.info.height),
                format: "WEBP",
                durationSec: null,
                originalName,
            };
        } catch (optErr) {
            throw new ValidationError(
                `Failed to optimize oversized image: ${optErr.message}`,
                { statusCode: 400, code: "VALIDATION_ERROR", cause: optErr }
            );
        }
    }
}

export default MediaUploadService;
