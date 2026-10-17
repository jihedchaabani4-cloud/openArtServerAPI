/**
 * CharacterMediaService
 * Dedicated Domain Service owning character media storage and database orchestration.
 * Handles turnaround body sheet uploads, detail reference images, and media cleanup.
 */

import { randomUUID } from "node:crypto";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { resolveMediaMetadata } from "../../platform/media/mediaMetadataResolver.js";
import { createMediaInWorkflow } from "../../db/workflowMediaLinker.js";
import { inferWorkflowMediaRole } from "../../db/workflowMediaRole.js";

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

            // Direct Asset/Workflow ID resolution to media relation
            if (mediaId) {
                const sourceMedia = await this._resolveSourceMedia(mediaId, {
                    userId: safeUserId,
                    projectId: effectiveProjectId,
                });
                if (sourceMedia) {
                    await createMediaInWorkflow(this.db, {
                        workflowId: wf.id,
                        mediaId: sourceMedia.id,
                        role: "sheet",
                        stepId: "character_sheet",
                        workflowType: wf.workflow_type || "CHARACTER",
                        operation: "uploadSheetMedia:linkWorkflowMedia",
                    });
                    await this.db.workflows.updatePrimaryMedia(wf.id, sourceMedia.id).catch((err) => {
                        crudOperationLog({
                            traceId,
                            operation: "uploadSheetMedia:updatePrimaryMedia",
                            status: "warning",
                            characterId,
                            mediaId: sourceMedia.id,
                            message: err.message,
                        });
                    });
                    await this.db.characters.updateCharacterFields(characterId, {
                        status: "completed",
                    }).catch((err) => {
                        crudOperationLog({
                            traceId,
                            operation: "uploadSheetMedia:updateCharacterFields",
                            status: "warning",
                            characterId,
                            message: err?.message,
                        });
                    });

                    crudOperationLog({
                        traceId,
                        operation: "uploadSheetMedia",
                        status: "ok",
                        durationMs: Date.now() - start,
                        characterId,
                        mediaId: sourceMedia.id,
                    });

                    return {
                        media: {
                            ...sourceMedia,
                            workflow_id: wf.id,
                            workflowId: wf.id,
                            role: "sheet",
                            mediaRole: "sheet",
                            step_id: "character_sheet",
                        },
                        ok: true,
                        url: sourceMedia.url,
                    };
                }
            }

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
                    crudOperationLog({ traceId, operation: "uploadSheetMedia:storageUpload", status: "ok", characterId });
                    resolvedUrl = await this.storageService.upload(storagePath, file.buffer);
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
                    crudOperationLog({ traceId, operation: "uploadSheetMedia:storageUpload", status: "ok", characterId });
                    resolvedUrl = await this.storageService.upload(storagePath, imageUrl);
                }
                // Fallback Case C: Existing Media ID from project library
                else if (mediaId) {
                    const sourceMedia = await this._resolveSourceMedia(mediaId, { userId: safeUserId, projectId: effectiveProjectId });
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
                        crudOperationLog({
                            traceId,
                            operation: "uploadSheetMedia:uploadFromUrl",
                            status: "warning",
                            characterId,
                            message: urlErr.message,
                        });
                        resolvedUrl = imageUrl;
                    }
                }
            }

            // 1. Check for existing sheet media on this workflow
            const existingMedia = await this.db.media.findByWorkflow(wf.id).catch(() => []);
            const sheetMedia = existingMedia.find((m) => (
                inferWorkflowMediaRole({
                    role: m.mediaRole || m.role,
                    stepId: m.step_id,
                    workflowType: wf.workflow_type || "CHARACTER",
                }) === "sheet"
            ));

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
                    project_id: wf.project_id || effectiveProjectId,
                    url: resolvedUrl,
                    step_id: "character_sheet",
                    width: resolvedWidth,
                    height: resolvedHeight,
                    status: "success",
                    error_message: null,
                });
                await createMediaInWorkflow(this.db, {
                    workflowId: wf.id,
                    mediaId: mediaRow?.id,
                    stepId: "character_sheet",
                    workflowType: wf.workflow_type || "CHARACTER",
                    operation: "uploadSheetMedia:linkWorkflowMedia",
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
                crudOperationLog({
                    traceId,
                    operation: "uploadSheetMedia:updatePrimaryMedia",
                    status: "warning",
                    characterId,
                    mediaId: mediaRow.id,
                    message: err.message,
                });
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
            let resolvedWidth = null;
            let resolvedHeight = null;

            // Direct Asset/Workflow ID resolution to media relation
            if (mediaId) {
                const sourceMedia = await this._resolveSourceMedia(mediaId, {
                    userId: safeUserId,
                    projectId: effectiveProjectId,
                });
                if (sourceMedia) {
                    await createMediaInWorkflow(this.db, {
                        workflowId: wf.id,
                        mediaId: sourceMedia.id,
                        role: "detail",
                        stepId: "character_detail",
                        workflowType: wf.workflow_type || "CHARACTER",
                        operation: "uploadDetailMedia:linkWorkflowMedia",
                    });
                    crudOperationLog({
                        traceId,
                        operation: "uploadDetailMedia",
                        status: "ok",
                        durationMs: Date.now() - start,
                        characterId,
                        newMediaId: sourceMedia.id,
                    });
                    return {
                        ok: true,
                        media: {
                            ...sourceMedia,
                            workflow_id: wf.id,
                            workflowId: wf.id,
                            role: "detail",
                            mediaRole: "detail",
                            step_id: "character_detail",
                        },
                        url: sourceMedia.url,
                    };
                }
            }

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
                resolvedWidth = ingested.width;
                resolvedHeight = ingested.height;
            } else {
                // Fallback Case A: Multipart file upload (buffer)
                if (file && file.buffer) {
                    const newMediaId = randomUUID();
                    const ext = this._resolveExtension(file.mimetype);
                    const storagePath = this.storageService.paths.characterDetail(safeUserId, characterId, newMediaId, ext);
                    crudOperationLog({ traceId, operation: "uploadDetailMedia:storageUpload", status: "ok", characterId });
                    resolvedUrl = await this.storageService.upload(storagePath, file.buffer);
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
                    crudOperationLog({ traceId, operation: "uploadDetailMedia:storageUpload", status: "ok", characterId });
                    resolvedUrl = await this.storageService.upload(storagePath, imageUrl);
                }
                // Fallback Case C: Existing Media ID from library
                else if (mediaId) {
                    const sourceMedia = await this._resolveSourceMedia(mediaId, { userId: safeUserId, projectId: effectiveProjectId });
                    if (sourceMedia && sourceMedia.url) {
                        resolvedUrl = sourceMedia.url;
                        resolvedWidth = sourceMedia.width;
                        resolvedHeight = sourceMedia.height;
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
                        crudOperationLog({
                            traceId,
                            operation: "uploadDetailMedia:uploadFromUrl",
                            status: "warning",
                            characterId,
                            message: urlErr.message,
                        });
                        resolvedUrl = imageUrl;
                    }
                }
            }

            const meta = resolveMediaMetadata({
                width: resolvedWidth,
                height: resolvedHeight,
            });
            resolvedWidth = meta.width;
            resolvedHeight = meta.height;

            const mediaRow = await this.db.media.createMedia({
                project_id: effectiveProjectId,
                url: resolvedUrl,
                step_id: "character_detail",
                width: resolvedWidth,
                height: resolvedHeight,
                status: "success",
                error_message: null,
            });
            await createMediaInWorkflow(this.db, {
                workflowId: wf.id,
                mediaId: mediaRow?.id,
                stepId: "character_detail",
                workflowType: wf.workflow_type || "CHARACTER",
                operation: "uploadDetailMedia:linkWorkflowMedia",
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
            const wf = await this.db.workflows?.getWorkflow?.(characterId).catch(() => null);
            const resolvedWfId = wf?.id || characterId;
            const mediaRec = await this.db.media.findById(mediaId, "id, url, step_id").catch(() => null);
            const wfLinks = this.db?.workflowMedia?.findByMedia
                ? await this.db.workflowMedia.findByMedia(mediaId).catch(() => [])
                : [];
            const wfLink = wfLinks.find((r) => r.workflow_id === resolvedWfId);
            const mediaRole = mediaRec || wfLink
                ? inferWorkflowMediaRole({
                    role: wfLink?.role || mediaRec?.mediaRole || mediaRec?.role,
                    stepId: mediaRec?.step_id,
                    workflowType: "CHARACTER",
                })
                : null;
            if (mediaRec && mediaRole && mediaRole !== "detail") {
                throw new CrudServiceError("Cannot delete non-detail media with removeDetailMedia", {
                    statusCode: 400,
                    errorCode: "INVALID_OPERATION",
                    traceId,
                    operation: "removeDetailMedia",
                });
            }

            if (this.db?.workflowMedia?.unlink) {
                await this.db.workflowMedia.unlink({
                    workflowId: resolvedWfId,
                    mediaId,
                    role: "detail",
                }).catch(() => null);
            }

            let remainingLinks = 0;
            if (this.db?.workflowMedia?.countLinksForMedia) {
                remainingLinks = await this.db.workflowMedia.countLinksForMedia(mediaId).catch(() => 0);
            }

            if (remainingLinks === 0) {
                await this.db.media.deleteByIdAndWorkflow(mediaId, resolvedWfId);

                if (mediaRec?.url) {
                    await this.storageService.deleteByUrl(mediaRec.url).catch((err) => {
                        crudOperationLog({
                            traceId,
                            operation: "removeDetailMedia:storageDelete",
                            status: "warning",
                            characterId,
                            mediaId,
                            message: err.message,
                        });
                    });
                }
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
     * Internal helper to find source media across media and workflow tables,
     * enforcing tenant (user) and project boundary isolation.
     */
    async _resolveSourceMedia(mediaId, { userId = null, projectId = null } = {}) {
        if (!mediaId) return null;
        let sourceMedia = await this.db.media.findById(mediaId).catch(() => null);
        let sourceWf = null;
        if (!sourceMedia && this.db.media.findMediaByIdOrWorkflow) {
            sourceMedia = await this.db.media.findMediaByIdOrWorkflow(mediaId).catch(() => null);
        }
        if (!sourceMedia && this.db.media.findByWorkflow) {
            const wfMedia = await this.db.media.findByWorkflow(mediaId).catch(() => []);
            sourceMedia = wfMedia.find((m) => m.url && m.status !== "failed") || wfMedia[0] || null;
        }
        if (this.db.workflows?.getWorkflow) {
            sourceWf = await this.db.workflows.getWorkflow(mediaId).catch(() => null);
            if (!sourceMedia && sourceWf?.primary_media_id) {
                sourceMedia = await this.db.media.findById(sourceWf.primary_media_id).catch(() => null);
            }
        }
        if (!sourceMedia) return null;

        // Verify workflow_media link presence and load parent workflow context if needed
        if (typeof this.db.workflowMedia?.findByMedia === "function") {
            const links = await this.db.workflowMedia.findByMedia(sourceMedia.id).catch(() => []);
            if (!Array.isArray(links) || links.length === 0) {
                throw new CrudServiceError("Media not found", {
                    statusCode: 404,
                    errorCode: "MEDIA_NOT_FOUND",
                    mediaId,
                });
            }
            const linkedWfId = links[0]?.workflow_id;
            if (!sourceWf && linkedWfId && this.db.workflows?.getWorkflow) {
                sourceWf = await this.db.workflows.getWorkflow(linkedWfId).catch(() => null);
            }
        }

        // Ownership verification (cross-tenant)
        const ownerUserId = sourceMedia.user_id || sourceWf?.user_id;
        if (userId && userId !== "anonymous" && ownerUserId && ownerUserId !== userId) {
            throw new CrudServiceError("Media not found", {
                statusCode: 404,
                errorCode: "MEDIA_NOT_FOUND",
                mediaId,
            });
        }

        // Project boundary verification (cross-project)
        const ownerProjectId = sourceMedia.project_id || sourceWf?.project_id;
        if (projectId && ownerProjectId && ownerProjectId !== projectId) {
            throw new CrudServiceError("Media not found", {
                statusCode: 404,
                errorCode: "MEDIA_NOT_FOUND",
                mediaId,
            });
        }

        return sourceMedia;
    }
}

export default CharacterMediaService;
