/**
 * CharacterMediaService
 * Dedicated Domain Service owning character media storage and database orchestration.
 * Handles turnaround body sheet uploads, detail reference images, and media cleanup.
 *
 * Architecture Boundary (ADR-0012):
 *   - Uploads binary files exclusively via MediaUploadService (CHARACTER_SHEET_UPLOAD_POLICY / CHARACTER_DETAIL_UPLOAD_POLICY).
 *   - Attaches and unlinks media exclusively via WorkflowMediaService (atomic RPC attach_workflow_reference_media).
 *   - Enforces CHARACTER_MAX_DETAIL_MEDIA = 5 atomically on new detail attachments.
 *   - Dual-writes legacy workflows.primary_media_id for sheet media only (scheduled for removal in ADR-0007 Ticket 12).
 */

import { randomUUID } from "node:crypto";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import {
    CHARACTER_SHEET_UPLOAD_POLICY,
    CHARACTER_DETAIL_UPLOAD_POLICY,
} from "../../platform/media-ingestion/UploadPolicy.js";
import { CHARACTER_MAX_DETAIL_MEDIA } from "../../config/characterConfig.js";

export { CHARACTER_MAX_DETAIL_MEDIA };

export class CharacterMediaService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db                   - Repository map (db.workflows, db.media, db.characters, db.workflowMedia)
     * @param {Object} deps.storageService       - StorageService instance for cleanup
     * @param {Object} deps.mediaUploadService   - MediaUploadService instance
     * @param {Object} deps.workflowMediaService - WorkflowMediaService instance
     * @param {Object} deps.authService          - AuthService / WorkflowSecurity instance
     */
    constructor({ db, storageService, mediaUploadService, workflowMediaService, authService }) {
        if (!db) {
            throw new Error("CharacterMediaService requires db");
        }
        if (!storageService) {
            throw new Error("CharacterMediaService requires storageService");
        }
        if (!mediaUploadService || typeof mediaUploadService.upload !== "function") {
            throw new Error("CharacterMediaService requires mediaUploadService with upload method");
        }
        if (!workflowMediaService || typeof workflowMediaService.attachMediaItems !== "function") {
            throw new Error("CharacterMediaService requires workflowMediaService with attachMediaItems method");
        }
        if (!authService || typeof authService.verifyWorkflowOwnership !== "function") {
            throw new Error("CharacterMediaService requires authService with verifyWorkflowOwnership method");
        }

        this.db = db;
        this.storageService = storageService;
        this.mediaUploadService = mediaUploadService;
        this.workflowMediaService = workflowMediaService;
        this.authService = authService;
    }

    /**
     * Set or upload the primary 3-view turnaround sheet media for a character.
     * Uploads via MediaUploadService (CHARACTER_SHEET_UPLOAD_POLICY) and attaches via WorkflowMediaService (role: "sheet").
     * Preserves legacy workflows.primary_media_id dual-write until Ticket 12 (ADR-0007).
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
            if (!userId || userId === "anonymous") {
                throw new CrudServiceError("Authentication required", {
                    statusCode: 401,
                    errorCode: "UNAUTHORIZED",
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

            const isAuthorized = await this.authService.verifyWorkflowOwnership(wf.id, userId);
            if (!isAuthorized) {
                throw new CrudServiceError("Character workflow not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "uploadSheetMedia",
                });
            }

            if (projectId && wf.project_id && wf.project_id !== projectId) {
                throw new CrudServiceError("Character workflow not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "uploadSheetMedia",
                });
            }

            const effectiveProjectId = projectId || wf.project_id;
            let items;

            if (file || imageUrl) {
                const uploadSource = file || imageUrl;
                const uploadRes = await this.mediaUploadService.upload({
                    files: [uploadSource],
                    policy: CHARACTER_SHEET_UPLOAD_POLICY,
                    maxFiles: 1,
                    userId,
                });
                items = [{
                    kind: "uploaded",
                    uploadedFile: uploadRes.uploaded[0],
                    originalName: file?.originalname || file?.name,
                }];
            } else {
                items = [{ kind: "existing", mediaId }];
            }

            const attachRes = await this.workflowMediaService.attachMediaItems({
                workflowId: wf.id,
                projectId: effectiveProjectId,
                userId,
                role: "sheet",
                maxAllowed: null,
                setPrimary: true,
                autoPrimary: true,
                items,
            });

            const attachedMedia = attachRes.attached[0].media;
            const oldPrimary = wf.primary_media_id || null;

            try {
                if (this.db.workflows?.updatePrimaryMedia) {
                    await this.db.workflows.updatePrimaryMedia(wf.id, attachedMedia.id);
                }
                if (this.db.characters?.updateCharacterFields) {
                    await this.db.characters.updateCharacterFields(characterId, {
                        status: "completed",
                    });
                }
            } catch (postAttachErr) {
                if (this.db.workflows?.updatePrimaryMedia) {
                    await this.db.workflows.updatePrimaryMedia(wf.id, oldPrimary).catch(() => null);
                }
                if (attachRes?.rollbackHandle) {
                    await this.workflowMediaService.rollbackAttachedMedia(attachRes.rollbackHandle);
                }
                throw postAttachErr;
            }

            crudOperationLog({
                traceId,
                operation: "uploadSheetMedia",
                status: "ok",
                durationMs: Date.now() - start,
                characterId,
                mediaId: attachedMedia.id,
            });

            return {
                media: {
                    ...attachedMedia,
                    workflow_id: wf.id,
                    workflowId: wf.id,
                    role: "sheet",
                    mediaRole: "sheet",
                    step_id: attachedMedia.step_id || "upload",
                },
                ok: true,
                url: attachedMedia.url,
            };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "uploadSheetMedia",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || err.statusCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    /**
     * Attach a detail reference image to a character (role: "detail", step_id: "upload").
     * Enforces CHARACTER_MAX_DETAIL_MEDIA = 5 fail-fast before upload and atomically inside attachMediaItems.
     * Never writes to workflows.primary_media_id.
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
            if (!userId || userId === "anonymous") {
                throw new CrudServiceError("Authentication required", {
                    statusCode: 401,
                    errorCode: "UNAUTHORIZED",
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

            const isAuthorized = await this.authService.verifyWorkflowOwnership(wf.id, userId);
            if (!isAuthorized) {
                throw new CrudServiceError("Character workflow not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "uploadDetailMedia",
                });
            }

            if (projectId && wf.project_id && wf.project_id !== projectId) {
                throw new CrudServiceError("Character workflow not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "uploadDetailMedia",
                });
            }

            const effectiveProjectId = projectId || wf.project_id;

            // Fail-fast quota remaining check
            const links = await (this.db.workflowMedia?.findByWorkflow?.(wf.id) || []);
            const currentDetailCount = Array.isArray(links)
                ? links.filter((l) => (l.role || l.mediaRole) === "detail").length
                : 0;
            const remaining = CHARACTER_MAX_DETAIL_MEDIA - currentDetailCount;
            if (remaining <= 0) {
                throw new CrudServiceError("Maximum 5 detail images allowed per character", {
                    statusCode: 400,
                    errorCode: "LIMIT_EXCEEDED",
                    traceId,
                    operation: "uploadDetailMedia",
                });
            }

            let items;
            if (file || imageUrl) {
                const uploadSource = file || imageUrl;
                const uploadRes = await this.mediaUploadService.upload({
                    files: [uploadSource],
                    policy: CHARACTER_DETAIL_UPLOAD_POLICY,
                    maxFiles: remaining,
                    userId,
                });
                items = [{
                    kind: "uploaded",
                    uploadedFile: uploadRes.uploaded[0],
                    originalName: file?.originalname || file?.name,
                }];
            } else {
                items = [{ kind: "existing", mediaId }];
            }

            const attachRes = await this.workflowMediaService.attachMediaItems({
                workflowId: wf.id,
                projectId: effectiveProjectId,
                userId,
                role: "detail",
                maxAllowed: CHARACTER_MAX_DETAIL_MEDIA,
                autoPrimary: false,
                items,
            });

            const attachedMedia = attachRes.attached[0].media;

            crudOperationLog({
                traceId,
                operation: "uploadDetailMedia",
                status: "ok",
                durationMs: Date.now() - start,
                characterId,
                newMediaId: attachedMedia.id,
            });

            return {
                media: {
                    ...attachedMedia,
                    workflow_id: wf.id,
                    workflowId: wf.id,
                    role: "detail",
                    mediaRole: "detail",
                    step_id: attachedMedia.step_id || "upload",
                },
                ok: true,
                url: attachedMedia.url,
            };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "uploadDetailMedia",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || err.statusCode || 500,
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
            if (!characterId || !mediaId) {
                throw new CrudServiceError("characterId and mediaId are required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "removeDetailMedia",
                });
            }
            if (!userId || userId === "anonymous") {
                throw new CrudServiceError("Authentication required", {
                    statusCode: 401,
                    errorCode: "UNAUTHORIZED",
                    traceId,
                    operation: "removeDetailMedia",
                });
            }

            const wf = await this.db.workflows?.getWorkflow?.(characterId).catch(() => null);
            const resolvedWfId = wf?.id || characterId;

            const isAuthorized = await this.authService.verifyWorkflowOwnership(resolvedWfId, userId);
            if (!isAuthorized) {
                throw new CrudServiceError(`Character not found: ${characterId}`, {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "removeDetailMedia",
                });
            }

            const mediaRec = await this.db.media.findById(mediaId, "id, url, step_id").catch(() => null);
            const wfLinks = this.db?.workflowMedia?.findByMedia
                ? await this.db.workflowMedia.findByMedia(mediaId).catch(() => [])
                : [];
            const wfLink = wfLinks.find((r) => r.workflow_id === resolvedWfId);
            const mediaRole = wfLink?.role || mediaRec?.mediaRole || mediaRec?.role;
            if (mediaRec && mediaRole && mediaRole !== "detail") {
                throw new CrudServiceError("Cannot delete non-detail media with removeDetailMedia", {
                    statusCode: 400,
                    errorCode: "INVALID_OPERATION",
                    traceId,
                    operation: "removeDetailMedia",
                });
            }

            // Check if this media was primary before unlinking
            let wasPrimary = false;
            if (resolvedWfId && this.db?.workflowMedia?.getPrimaryMedia) {
                const currentPrimary = await this.db.workflowMedia.getPrimaryMedia(resolvedWfId).catch(() => null);
                const currentPrimaryId = currentPrimary?.media_id || currentPrimary?.id;
                wasPrimary = Boolean(currentPrimaryId && currentPrimaryId === mediaId);
            }

            // Atomic unlink and orphan reaping protocol
            if (typeof this.db?.workflowMedia?.unlinkAndReapOrphan === "function") {
                const reapResult = await this.db.workflowMedia.unlinkAndReapOrphan({
                    workflowId: resolvedWfId,
                    mediaId,
                    role: "detail",
                });
                if (reapResult?.unlinked === true && reapResult.is_orphan === true) {
                    if (this.db.media?.deleteById) {
                        await this.db.media.deleteById(mediaId).catch(() => null);
                    }
                    const storageUrl = reapResult.storage_url || mediaRec?.url;
                    if (storageUrl && this.storageService?.deleteByUrl) {
                        await this.storageService.deleteByUrl(storageUrl).catch((err) => {
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
            } else if (this.db?.workflowMedia?.unlink) {
                await this.db.workflowMedia.unlink({
                    workflowId: resolvedWfId,
                    mediaId,
                    role: "detail",
                });
                if (wasPrimary) {
                    await this.db.workflowMedia.clearPrimaryMedia?.({ workflowId: resolvedWfId });
                    await this.db.workflows?.updateFields?.(resolvedWfId, { primary_media_id: null });
                }
                const remaining = await this.db.workflowMedia.countLinksForMedia?.(mediaId);
                if (remaining === 0) {
                    if (this.db.media?.deleteById) {
                        await this.db.media.deleteById(mediaId);
                    }
                    if (mediaRec?.url && this.storageService?.deleteByUrl) {
                        await this.storageService.deleteByUrl(mediaRec.url).catch(() => {});
                    }
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
                errorCode: err.errorCode || err.statusCode || 500,
                message: err.message,
            });
            throw err;
        }
    }
}

export default CharacterMediaService;
