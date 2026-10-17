/**
 * WorkflowMediaService
 * Dedicated Platform Service owning workflow media associations:
 * - Setting and switching primary media for a workflow
 * - Detaching media variations into independent workflow containers
 * - Deleting single media records and cascading cleanup to storage and workflows
 * - Releasing workflow relations without deleting still-linked media
 * - Deleting orphan media that no longer belongs to any workflow
 */

import { randomUUID } from "node:crypto";
import { assertMediaUsable } from "../../../lib/mediaGuards.js";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { createLogger } from "../../infrastructure/logging/index.js";
import { createMediaInWorkflow } from "../../db/workflowMediaLinker.js";

const logger = createLogger("database");

export class WorkflowMediaService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db            - Repository map (db.workflows, db.media)
     * @param {Object} deps.storageService - StorageService instance
     * @param {Object} deps.authService   - WorkflowAuthorizationService instance
     */
    constructor({ db, storageService, authService }) {
        this.db = db;
        this.storageService = storageService;
        this.authService = authService;
    }

    /**
     * Link a media record to a workflow strictly in `public.workflow_media`.
     */
    async createMediaInWorkflow({ workflowId, workflow_id, mediaId, media_id, role, stepId, step_id, workflowType, workflow_type } = {}) {
        return createMediaInWorkflow(this.db, {
            workflowId,
            workflow_id,
            mediaId,
            media_id,
            role,
            stepId,
            step_id,
            workflowType,
            workflow_type,
            operation: "WorkflowMediaService:createMediaInWorkflow",
        });
    }

    /**
     * Assign media to a workflow strictly via `public.workflow_media` (never updates `media.workflow_id`).
     */
    async assignMediaToWorkflow(params = {}) {
        return this.createMediaInWorkflow(params);
    }

    /**
     * Set the primary media for a workflow container.
     */
    async setPrimaryMedia({ workflowId, mediaId, userId, req = null }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "setPrimaryMedia", workflowId, mediaId });

        try {
            if (!mediaId) {
                throw new CrudServiceError("media_id is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "setPrimaryMedia",
                });
            }

            const [wfOk, mediaOk] = await Promise.all([
                this.authService.verifyWorkflowOwnership(workflowId, userId, req),
                this.authService.verifyMediaOwnership(mediaId, userId, req),
            ]);

            if (!wfOk) {
                crudOperationLog({
                    traceId,
                    operation: "setPrimaryMedia",
                    status: "error",
                    userId,
                    resourceId: workflowId,
                    resourceType: "workflow",
                    errorCode: "NOT_FOUND",
                    message: "Workflow not found",
                });
                throw new CrudServiceError("Workflow not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "setPrimaryMedia",
                });
            }
            if (!mediaOk) {
                crudOperationLog({
                    traceId,
                    operation: "setPrimaryMedia",
                    status: "error",
                    userId,
                    resourceId: mediaId,
                    resourceType: "media",
                    errorCode: "NOT_FOUND",
                    message: "Media not found",
                });
                throw new CrudServiceError("Media not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "setPrimaryMedia",
                });
            }

            await assertMediaUsable({ media_id: mediaId, workflow_id: workflowId }, { allowProcessing: true, db: this.db });

            const updated = await this.db.workflows.updateFields(workflowId, { primary_media_id: mediaId });

            crudOperationLog({
                traceId,
                operation: "setPrimaryMedia",
                status: "ok",
                durationMs: Date.now() - start,
                workflowId,
                mediaId,
            });

            return { primary_media_id: updated?.primary_media_id || mediaId };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "setPrimaryMedia",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    /**
     * Detach a media item into its own independent workflow container.
     */
    async detachMedia({ mediaId, projectId, displayName, userId, req = null }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "detachMedia", mediaId });

        try {
            if (!mediaId) {
                throw new CrudServiceError("media_id is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "detachMedia",
                });
            }

            const isAuthorized = await this.authService.verifyMediaOwnership(mediaId, userId, req);
            if (!isAuthorized) {
                crudOperationLog({
                    traceId,
                    operation: "detachMedia",
                    status: "error",
                    userId,
                    resourceId: mediaId,
                    resourceType: "media",
                    errorCode: "NOT_FOUND",
                    message: "Media not found",
                });
                throw new CrudServiceError("Media not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "detachMedia",
                });
            }

            const { data: media, error: mediaErr } = await this.db.media.client()
                .from("media")
                .select("*")
                .eq("id", mediaId)
                .single();
            if (mediaErr) throw mediaErr;

            const status = (media.status || "").toString().toLowerCase();
            if (["processing", "pending", "uploading"].includes(status)) {
                throw new CrudServiceError("Cannot detach media while generation is in progress", {
                    statusCode: 403,
                    errorCode: "MEDIA_BUSY",
                    traceId,
                    operation: "detachMedia",
                });
            }

            let currentWorkflowId = null;
            if (this.db.workflowMedia?.findByMedia) {
                const links = await this.db.workflowMedia.findByMedia(mediaId).catch(() => []);
                currentWorkflowId = links[0]?.workflow_id || null;
            }
            const currentWorkflow = currentWorkflowId && this.db.workflows?.findById
                ? await this.db.workflows.findById(currentWorkflowId).catch(() => null)
                : null;

            const inferredProjectId = projectId || media.project_id || currentWorkflow?.project_id;
            const inferredUserId = userId || media.user_id || currentWorkflow?.user_id || null;
            const newName = displayName || currentWorkflow?.display_name || "Detached media";

            // 1. Create new standalone workflow container
            const newWorkflow = await this.db.workflows.createWorkflow({
                project_id: inferredProjectId,
                session_id: null,
                user_id: inferredUserId,
                display_name: newName,
                variation_index: 0,
                primary_media_id: null,
            });

            // 2. Move workflow_media relation to the new workflow and sync project_id on media
            if (currentWorkflowId && this.db.workflowMedia?.unlink) {
                await this.db.workflowMedia.unlink({
                    workflowId: currentWorkflowId,
                    mediaId,
                }).catch(() => null);
            }
            await createMediaInWorkflow(this.db, {
                workflowId: newWorkflow.id,
                mediaId,
                stepId: media.step_id,
                operation: "detachMedia:linkWorkflowMedia",
            });
            await this.db.media.updateFields(mediaId, {
                project_id: inferredProjectId,
            });

            // 3. Set primary media on the new workflow
            const updatedWorkflow = await this.db.workflows.updateFields(newWorkflow.id, {
                primary_media_id: mediaId,
            });

            // 4. If this was the primary media of the old workflow, promote the next oldest media
            if (currentWorkflowId) {
                const oldWf = currentWorkflow || await this.db.workflows.findById(currentWorkflowId, "primary_media_id");
                if (oldWf?.primary_media_id === mediaId) {
                    const remaining = await this.db.media.findByWorkflow(currentWorkflowId);
                    const nextPrimary = remaining?.[0]?.id ?? null;
                    await this.db.workflows.updateFields(currentWorkflowId, {
                        primary_media_id: nextPrimary,
                    });
                }
            }

            crudOperationLog({
                traceId,
                operation: "detachMedia",
                status: "ok",
                durationMs: Date.now() - start,
                mediaId,
                newWorkflowId: newWorkflow.id,
            });

            return { workflow: updatedWorkflow };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "detachMedia",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    /**
     * Deletes a media row, its generation_config_reference rows, and its storage object.
     */
    async _deleteOrphanMedia(media) {
        if (!media?.id) return false;

        try {
            await this.db.media.client()
                .from("generation_config_reference")
                .delete()
                .eq("ref_media_id", media.id);
        } catch (refErr) {
            logger.warn({ mediaId: media.id, message: refErr.message }, "orphan media: delete ref links notice");
        }

        await this.db.media.deleteById(media.id);

        if (media.url) {
            await this.storageService.deleteByUrl(media.url).catch((storageErr) => {
                logger.warn(
                    { mediaId: media.id, url: media.url, message: storageErr.message },
                    "orphan media: storage delete notice"
                );
            });
        }

        return true;
    }

    /**
     * Removes every workflow_media link for a workflow. Does not delete the workflow.
     * Media that still belongs to another workflow is kept.
     * Media with no remaining workflow is deleted (row + storage).
     */
    async releaseWorkflowMedia({ workflowId }) {
        if (!workflowId) {
            return { unlinkedMediaIds: [], deletedOrphanIds: [] };
        }

        const mediaItems = await this.db.media.findByWorkflow(workflowId).catch(() => []);
        const unlinkedMediaIds = [...new Set(mediaItems.map((m) => m.id).filter(Boolean))];

        if (this.db.workflowMedia?.unlinkByWorkflow) {
            await this.db.workflowMedia.unlinkByWorkflow(workflowId);
        }

        const deletedOrphanIds = [];

        for (const media of mediaItems) {
            if (!media?.id) continue;

            const remainingLinks = this.db.workflowMedia?.countLinksForMedia
                ? await this.db.workflowMedia.countLinksForMedia(media.id).catch(() => 0)
                : 0;

            if (remainingLinks > 0) {
                continue;
            }

            await this._deleteOrphanMedia(media);
            deletedOrphanIds.push(media.id);
        }

        return { unlinkedMediaIds, deletedOrphanIds };
    }

    /**
     * Delete a single media record, clean up its storage file, and update workflow status.
     */
    async deleteMedia({ mediaId, userId, req = null }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "deleteMedia", mediaId });

        try {
            if (!mediaId) {
                throw new CrudServiceError("media_id is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "deleteMedia",
                });
            }

            const isAuthorized = await this.authService.verifyMediaOwnership(mediaId, userId, req);
            if (!isAuthorized) {
                crudOperationLog({
                    traceId,
                    operation: "deleteMedia",
                    status: "error",
                    userId,
                    resourceId: mediaId,
                    resourceType: "media",
                    errorCode: "NOT_FOUND",
                    message: "Media not found",
                });
                throw new CrudServiceError("Media not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "deleteMedia",
                });
            }

            const mediaRec = await this.db.media.findById(mediaId, "id, url");
            const existingLinks = this.db.workflowMedia?.findByMedia
                ? await this.db.workflowMedia.findByMedia(mediaId).catch(() => [])
                : [];
            const affectedWorkflowIds = [...new Set(existingLinks.map((row) => row?.workflow_id).filter(Boolean))];

            // 1. Unlink workflow_media relation rows FIRST (before any delete).
            if (this.db.workflowMedia?.unlink) {
                await this.db.workflowMedia.unlink({ mediaId }).catch((unlinkErr) => {
                    logger.warn({ mediaId, message: unlinkErr.message }, "deleteMedia: workflowMedia.unlink notice");
                });
            } else if (this.db.workflowMedia?.unlinkByMedia) {
                await this.db.workflowMedia.unlinkByMedia(mediaId).catch((unlinkErr) => {
                    logger.warn({ mediaId, message: unlinkErr.message }, "deleteMedia: workflowMedia.unlinkByMedia notice");
                });
            }

            // 2. Delete generation_config_reference links
            try {
                await this.db.media.client()
                    .from("generation_config_reference")
                    .delete()
                    .eq("ref_media_id", mediaId);
            } catch (refErr) {
                logger.warn({ mediaId, message: refErr.message }, "deleteMedia: delete ref links notice");
            }

            // 3. Orphan check: count remaining workflow_media links AFTER unlinking.
            //    If still linked to other workflows the file is shared → do NOT delete storage.
            const remainingLinks = this.db.workflowMedia?.countLinksForMedia
                ? await this.db.workflowMedia.countLinksForMedia(mediaId).catch(() => 0)
                : 0;
            const isOrphan = remainingLinks === 0;

            // 4. Delete media record
            const deleted = await this.db.media.deleteById(mediaId);

            // 5. Delete storage file only if this media is now a true orphan
            if (isOrphan && mediaRec?.url) {
                await this.storageService.deleteByUrl(mediaRec.url).catch((storageErr) => {
                    logger.warn({ mediaId, url: mediaRec.url, message: storageErr.message }, "deleteMedia: storage delete notice");
                });
            }

            let workflowDeleted = false;
            let nextPrimaryMediaId = null;

            // 6. Check remaining media on affected workflow containers
            for (const wfId of affectedWorkflowIds) {
                const remainingMedia = await this.db.media.findByWorkflow(wfId).catch(() => []);

                if (!remainingMedia || remainingMedia.length === 0) {
                    const workflowRecord = await this.db.workflows?.findById
                        ? await this.db.workflows.findById(wfId, "id, primary_media_id, workflow_type").catch(() => null)
                        : null;
                    const hasSidecar = await this._hasSidecarEntity(wfId, workflowRecord);

                    if (hasSidecar) {
                        // Preserve workflow container when a character or element sidecar is attached
                        if (workflowRecord?.primary_media_id === mediaId && this.db.workflows?.updatePrimaryMedia) {
                            await this.db.workflows.updatePrimaryMedia(wfId, null).catch(() => null);
                        }
                    } else {
                        // Empty plain workflow: delete workflow container
                        await this.db.workflows.deleteById(wfId).catch((wfErr) => {
                            logger.warn({ workflowId: wfId, message: wfErr.message }, "deleteMedia: delete workflow notice");
                        });
                        workflowDeleted = true;
                    }
                } else {
                    const workflowRecord = await this.db.workflows.findById(wfId, "primary_media_id").catch(() => null);
                    if (workflowRecord?.primary_media_id === mediaId) {
                        nextPrimaryMediaId = remainingMedia[0]?.id || null;
                        if (this.db.workflows?.updatePrimaryMedia) {
                            await this.db.workflows.updatePrimaryMedia(wfId, nextPrimaryMediaId).catch(() => null);
                        }
                    }
                }
            }

            crudOperationLog({
                traceId,
                operation: "deleteMedia",
                status: "ok",
                durationMs: Date.now() - start,
                mediaId,
                workflowDeleted,
            });

            return {
                deleted: true,
                media: deleted,
                workflow_deleted: workflowDeleted,
                next_primary_media_id: nextPrimaryMediaId,
            };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "deleteMedia",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    /**
     * Checks whether a workflow container is referenced by a Character or Element sidecar entity,
     * or is typed as a character/element workflow.
     */
    async _hasSidecarEntity(workflowId, workflowRecord = null) {
        if (!workflowId) return false;

        const wfType = String(workflowRecord?.workflow_type || "").toUpperCase();
        if (
            wfType === "CHARACTER" ||
            wfType === "CHARACTER_SHEET" ||
            wfType === "ELEMENT" ||
            wfType === "ELEMENT_SHEET"
        ) {
            return true;
        }

        if (this.db.characters?.findByCharacterId) {
            const char = await this.db.characters.findByCharacterId(workflowId).catch(() => null);
            if (char) return true;
        } else if (this.db.characters?.findByWorkflowId) {
            const char = await this.db.characters.findByWorkflowId(workflowId).catch(() => null);
            if (char) return true;
        }

        if (this.db.elements?.findByWorkflowId) {
            const elem = await this.db.elements.findByWorkflowId(workflowId).catch(() => null);
            if (elem) return true;
        } else if (this.db.elements?.resolveRecord) {
            const elem = await this.db.elements.resolveRecord(workflowId).catch(() => null);
            if (elem) return true;
        }

        return false;
    }
}

export default WorkflowMediaService;
