/**
 * CharacterMediaService
 * Dedicated Domain Service owning character media storage and database orchestration.
 * Handles turnaround body sheet uploads, detail reference images, and media cleanup.
 */

import { randomUUID } from "node:crypto";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";

export class CharacterMediaService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db                     - Repository map (db.workflows, db.media, db.characters, db.projects)
     * @param {Object} deps.storageService         - StorageService instance for Supabase uploads
     * @param {Object} [deps.mediaIngestionService] - MediaIngestionService instance
     */
    constructor({ db, storageService, mediaIngestionService = null }) {
        this.db = db;
        this.storageService = storageService;
        this.mediaIngestionService = mediaIngestionService;
    }

    /**
     * Resolves file extension based on mime type
     */
    _resolveExtension(mimetype) {
        if (!mimetype) return "jpg";
        if (mimetype.includes("png")) return "png";
        if (mimetype.includes("webp")) return "webp";
        if (mimetype.includes("gif")) return "gif";
        if (mimetype.includes("avif")) return "avif";
        return "jpg";
    }

    /**
     * Set or upload the primary 3-view turnaround sheet media for a character.
     * Uploads to Supabase storage path `character-sheets/...`, updates workflow primary_media_id,
     * and marks workflow & character status as completed.
     */
    async uploadSheetMedia({ characterId, mediaId, imageUrl, file, projectId, userId }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "uploadSheetMedia", characterId });

        try {
            if (!characterId) {
                throw new CrudServiceError("characterId is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "uploadSheetMedia",
                });
            }
            if (!mediaId && !imageUrl && !file) {
                throw new CrudServiceError("Either file, mediaId, or imageUrl is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "uploadSheetMedia",
                });
            }

            const wf = await this.db.workflows.getWorkflow(characterId).catch(() => null);
            if (!wf) {
                throw new CrudServiceError("Character workflow not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "uploadSheetMedia",
                });
            }

            const effectiveProjectId = projectId || wf.project_id;
            const safeUserId = userId || wf.user_id || "anonymous";

            let resolvedUrl = imageUrl;
            let resolvedWidth = 1344;
            let resolvedHeight = 768;

            // Ingestion via Canonical MediaIngestionService
            if (this.mediaIngestionService) {
                const source = file || mediaId || imageUrl;
                const ingested = await this.mediaIngestionService.ingest({
                    source,
                    userId: safeUserId,
                    projectId: effectiveProjectId,
                    workflowId: wf.id,
                    purpose: "character_sheet",
                    folder: "character-sheets",
                    skipMediaCreate: true,
                    imageUrl,
                });
                resolvedUrl = ingested.url;
                resolvedWidth = ingested.width || 1344;
                resolvedHeight = ingested.height || 768;
            } else {
                // Fallback Case A: Multipart file upload (buffer)
                if (file && file.buffer) {
                    const newMediaId = randomUUID();
                    const ext = this._resolveExtension(file.mimetype);
                    const storagePath = this.storageService.paths.characterSheet(safeUserId, characterId, newMediaId, ext);
                    console.log(`📡 [CharacterMediaService] Uploading sheet file to storage: ${storagePath}`);
                    resolvedUrl = await this.storageService.upload(storagePath, file.buffer);
                    console.log(`✅ [CharacterMediaService] Sheet file uploaded: ${resolvedUrl}`);
                }
                // Fallback Case B: Base64 data URL
                else if (imageUrl && imageUrl.startsWith("data:")) {
                    const newMediaId = randomUUID();
                    const ext = imageUrl.startsWith("data:image/png")
                        ? "png"
                        : imageUrl.startsWith("data:image/webp")
                        ? "webp"
                        : "jpg";
                    const storagePath = this.storageService.paths.characterSheet(safeUserId, characterId, newMediaId, ext);
                    console.log(`📡 [CharacterMediaService] Uploading sheet base64 to storage: ${storagePath}`);
                    resolvedUrl = await this.storageService.upload(storagePath, imageUrl);
                    console.log(`✅ [CharacterMediaService] Sheet base64 uploaded: ${resolvedUrl}`);
                }
                // Fallback Case C: Existing Media ID from project library
                else if (mediaId) {
                    const sourceMedia = await this._resolveSourceMedia(mediaId);
                    if (sourceMedia && sourceMedia.url) {
                        resolvedUrl = sourceMedia.url;
                        resolvedWidth = sourceMedia.width || 1344;
                        resolvedHeight = sourceMedia.height || 768;
                    } else if (imageUrl) {
                        resolvedUrl = imageUrl;
                    } else {
                        throw new CrudServiceError(`Media or Workflow with ID ${mediaId} not found`, {
                            statusCode: 404,
                            errorCode: "NOT_FOUND",
                            traceId,
                            operation: "uploadSheetMedia",
                        });
                    }
                }
                // Fallback Case D: External HTTP image URL
                else if (imageUrl && (imageUrl.startsWith("http://") || imageUrl.startsWith("https://"))) {
                    try {
                        const newMediaId = randomUUID();
                        const storagePath = this.storageService.paths.characterSheet(safeUserId, characterId, newMediaId, "jpg");
                        resolvedUrl = await this.storageService.uploadFromUrl(storagePath, imageUrl);
                    } catch (urlErr) {
                        console.warn(`⚠️ [CharacterMediaService] uploadFromUrl fallback: ${urlErr.message}`);
                        resolvedUrl = imageUrl;
                    }
                }
            }

            // 1. Check for existing sheet media on this workflow
            const existingMedia = await this.db.media.findByWorkflow(wf.id).catch(() => []);
            const sheetMedia = existingMedia.find((m) => m.step_id === "character_sheet" || m.step_id === "CAE");

            let mediaRow;
            if (sheetMedia) {
                mediaRow = await this.db.media.updateFields(sheetMedia.id, {
                    url: resolvedUrl,
                    status: "success",
                    error_message: null,
                    width: resolvedWidth,
                    height: resolvedHeight,
                    step_id: "character_sheet",
                    project_id: wf.project_id || effectiveProjectId,
                });
            } else {
                mediaRow = await this.db.media.createMedia({
                    workflow_id: wf.id,
                    project_id: wf.project_id || effectiveProjectId,
                    url: resolvedUrl,
                    step_id: "character_sheet",
                    width: resolvedWidth,
                    height: resolvedHeight,
                    status: "success",
                    error_message: null,
                });
            }

            // 2. Clean up any failed media placeholders
            for (const m of existingMedia) {
                if (m.id !== mediaRow.id && (m.status === "failed" || m.status === "error" || !m.url)) {
                    await this.db.media.deleteByIdAndWorkflow(m.id, wf.id).catch(() => null);
                }
            }

            // 3. Update workflow: set primary_media_id (workflow table has primary_media_id column)
            await this.db.workflows.updatePrimaryMedia(wf.id, mediaRow.id).catch((err) => {
                console.warn(`⚠️ [CharacterMediaService] updatePrimaryMedia notice:`, err.message);
            });

            // 4. Update characters table status
            await this.db.characters.updateCharacterFields(characterId, {
                status: "completed",
            }).catch(() => null);

            crudOperationLog({
                traceId,
                operation: "uploadSheetMedia",
                status: "ok",
                durationMs: Date.now() - start,
                characterId,
                mediaId: mediaRow.id,
            });

            return { media: { ...mediaRow, url: resolvedUrl }, ok: true, url: resolvedUrl };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "uploadSheetMedia",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    /**
     * Attach a detail reference image to a character (step_id: "character_detail").
     * Uploads to Supabase storage path `character-details/...` and creates a media row.
     */
    async uploadDetailMedia({ characterId, mediaId, imageUrl, file, projectId, userId }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "uploadDetailMedia", characterId });

        try {
            if (!characterId) {
                throw new CrudServiceError("characterId is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "uploadDetailMedia",
                });
            }
            if (!mediaId && !imageUrl && !file) {
                throw new CrudServiceError("Either file, mediaId, or imageUrl is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "uploadDetailMedia",
                });
            }

            const wf = await this.db.workflows.getWorkflow(characterId).catch(() => null);
            if (!wf) {
                throw new CrudServiceError("Character workflow not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "uploadDetailMedia",
                });
            }

            const effectiveProjectId = projectId || wf.project_id;
            const safeUserId = userId || wf.user_id || "anonymous";

            let resolvedUrl = imageUrl;
            let resolvedWidth = 1024;
            let resolvedHeight = 1024;

            // Ingestion via Canonical MediaIngestionService
            if (this.mediaIngestionService) {
                const source = file || mediaId || imageUrl;
                const ingested = await this.mediaIngestionService.ingest({
                    source,
                    userId: safeUserId,
                    projectId: effectiveProjectId,
                    workflowId: wf.id,
                    purpose: "character_detail",
                    folder: "character-details",
                    skipMediaCreate: true,
                    imageUrl,
                });
                resolvedUrl = ingested.url;
                resolvedWidth = ingested.width || 1024;
                resolvedHeight = ingested.height || 1024;
            } else {
                // Fallback Case A: Multipart file upload (buffer)
                if (file && file.buffer) {
                    const newMediaId = randomUUID();
                    const ext = this._resolveExtension(file.mimetype);
                    const storagePath = this.storageService.paths.characterDetail(safeUserId, characterId, newMediaId, ext);
                    console.log(`📡 [CharacterMediaService] Uploading detail file to storage: ${storagePath}`);
                    resolvedUrl = await this.storageService.upload(storagePath, file.buffer);
                    console.log(`✅ [CharacterMediaService] Detail file uploaded: ${resolvedUrl}`);
                }
                // Fallback Case B: Base64 data URL
                else if (imageUrl && imageUrl.startsWith("data:")) {
                    const newMediaId = randomUUID();
                    const ext = imageUrl.startsWith("data:image/png")
                        ? "png"
                        : imageUrl.startsWith("data:image/webp")
                        ? "webp"
                        : "jpg";
                    const storagePath = this.storageService.paths.characterDetail(safeUserId, characterId, newMediaId, ext);
                    console.log(`📡 [CharacterMediaService] Uploading detail base64 to storage: ${storagePath}`);
                    resolvedUrl = await this.storageService.upload(storagePath, imageUrl);
                    console.log(`✅ [CharacterMediaService] Detail base64 uploaded: ${resolvedUrl}`);
                }
                // Fallback Case C: Existing Media ID from library
                else if (mediaId) {
                    const sourceMedia = await this._resolveSourceMedia(mediaId);
                    if (sourceMedia && sourceMedia.url) {
                        resolvedUrl = sourceMedia.url;
                        resolvedWidth = sourceMedia.width || 1024;
                        resolvedHeight = sourceMedia.height || 1024;
                    } else if (imageUrl) {
                        resolvedUrl = imageUrl;
                    } else {
                        throw new CrudServiceError(`Media or Workflow with ID ${mediaId} not found`, {
                            statusCode: 404,
                            errorCode: "NOT_FOUND",
                            traceId,
                            operation: "uploadDetailMedia",
                        });
                    }
                }
                // Fallback Case D: External HTTP URL
                else if (imageUrl && (imageUrl.startsWith("http://") || imageUrl.startsWith("https://"))) {
                    try {
                        const newMediaId = randomUUID();
                        const storagePath = this.storageService.paths.characterDetail(safeUserId, characterId, newMediaId, "jpg");
                        resolvedUrl = await this.storageService.uploadFromUrl(storagePath, imageUrl);
                    } catch (urlErr) {
                        console.warn(`⚠️ [CharacterMediaService] uploadFromUrl fallback: ${urlErr.message}`);
                        resolvedUrl = imageUrl;
                    }
                }
            }

            const mediaRow = await this.db.media.createMedia({
                workflow_id: wf.id,
                project_id: effectiveProjectId,
                url: resolvedUrl,
                step_id: "character_detail",
                width: resolvedWidth,
                height: resolvedHeight,
                status: "success",
                error_message: null,
            });

            crudOperationLog({
                traceId,
                operation: "uploadDetailMedia",
                status: "ok",
                durationMs: Date.now() - start,
                characterId,
                newMediaId: mediaRow.id,
            });

            return { media: { ...mediaRow, url: resolvedUrl }, ok: true, url: resolvedUrl };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "uploadDetailMedia",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    /**
     * Remove a detail reference image from character
     */
    async removeDetailMedia({ characterId, mediaId, userId }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "removeDetailMedia", characterId, mediaId });

        try {
            const mediaRec = await this.db.media.findById(mediaId, "id, url, step_id, workflow_id").catch(() => null);
            if (mediaRec && mediaRec.step_id !== "character_detail") {
                throw new CrudServiceError("Cannot delete non-detail media with removeDetailMedia", {
                    statusCode: 400,
                    errorCode: "INVALID_OPERATION",
                    traceId,
                    operation: "removeDetailMedia",
                });
            }

            await this.db.media.deleteByIdAndWorkflow(mediaId, characterId);

            if (mediaRec?.url) {
                await this.storageService.deleteByUrl(mediaRec.url).catch((err) => {
                    console.warn(`⚠️ [CharacterMediaService] removeDetailMedia storage delete notice:`, err.message);
                });
            }

            crudOperationLog({
                traceId,
                operation: "removeDetailMedia",
                status: "ok",
                durationMs: Date.now() - start,
                characterId,
                mediaId,
            });

            return { ok: true };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "removeDetailMedia",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    /**
     * Internal helper to find source media across media and workflow tables
     */
    async _resolveSourceMedia(mediaId) {
        let sourceMedia = await this.db.media.findById(mediaId).catch(() => null);
        if (!sourceMedia) {
            sourceMedia = await this.db.media.findMediaByIdOrWorkflow(mediaId).catch(() => null);
        }
        if (!sourceMedia) {
            const wfMedia = await this.db.media.findByWorkflow(mediaId).catch(() => []);
            sourceMedia = wfMedia.find((m) => m.url && m.status !== "failed") || wfMedia[0] || null;
        }
        if (!sourceMedia) {
            const sourceWf = await this.db.workflows.getWorkflow(mediaId).catch(() => null);
            if (sourceWf?.primary_media_id) {
                sourceMedia = await this.db.media.findById(sourceWf.primary_media_id).catch(() => null);
            }
        }
        return sourceMedia;
    }
}

export default CharacterMediaService;
