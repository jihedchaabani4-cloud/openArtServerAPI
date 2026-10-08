/**
 * WorkflowMediaService
 * Dedicated Platform Service owning workflow media associations:
 * - Setting and switching primary media for a workflow
 * - Detaching media variations into independent workflow containers
 * - Deleting single media records and cascading cleanup to storage and workflows
 */

import { randomUUID } from "node:crypto";
import { assertMediaUsable } from "../../../lib/mediaGuards.js";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { createLogger } from "../../infrastructure/logging/index.js";

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
                .select("*, workflow:workflow!workflow_id(id, project_id, session_id, display_name)")
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

            const currentWorkflowId = media.workflow_id;
            const inferredProjectId = projectId || media.project_id || media.workflow?.project_id;
            const inferredUserId = userId || media.user_id || media.workflow?.user_id || null;
            const newName = displayName || media.workflow?.display_name || "Detached media";

            // 1. Create new standalone workflow container
            const newWorkflow = await this.db.workflows.createWorkflow({
                project_id: inferredProjectId,
                session_id: null,
                user_id: inferredUserId,
                display_name: newName,
                variation_index: 0,
                primary_media_id: null,
            });

            // 2. Re-point media to the new workflow
            await this.db.media.updateFields(mediaId, {
                workflow_id: newWorkflow.id,
                project_id: inferredProjectId,
            });

            // 3. Set primary media on the new workflow
            const updatedWorkflow = await this.db.workflows.updateFields(newWorkflow.id, {
                primary_media_id: mediaId,
            });

            // 4. If this was the primary media of the old workflow, promote the next oldest media
            if (currentWorkflowId) {
                const oldWf = await this.db.workflows.findById(currentWorkflowId, "primary_media_id");
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

            const mediaRec = await this.db.media.findById(mediaId, "id, workflow_id, url");

            // 1. Unlink workflow_media relation rows FIRST (before any delete).
            //    This keeps the relation table consistent and lets countLinksForMedia
            //    return the accurate remaining-links count in step 3.
            if (this.db.workflowMedia?.unlink) {
                await this.db.workflowMedia.unlink({ mediaId }).catch((unlinkErr) => {
                    logger.warn({ mediaId, message: unlinkErr.message }, "deleteMedia: workflowMedia.unlink notice");
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

            // 6. Check remaining media on the legacy workflow container
            if (mediaRec?.workflow_id) {
                const remainingMedia = await this.db.media.findByWorkflow(mediaRec.workflow_id).catch(() => []);

                if (!remainingMedia || remainingMedia.length === 0) {
                    // Empty workflow: delete workflow container
                    await this.db.workflows.deleteById(mediaRec.workflow_id).catch((wfErr) => {
                        logger.warn({ workflowId: mediaRec.workflow_id, message: wfErr.message }, "deleteMedia: delete workflow notice");
                    });
                    workflowDeleted = true;
                } else {
                    const workflowRecord = await this.db.workflows.findById(mediaRec.workflow_id, "primary_media_id").catch(() => null);
                    if (workflowRecord?.primary_media_id === mediaId) {
                        nextPrimaryMediaId = remainingMedia[0]?.id || null;
                        await this.db.workflows.updatePrimaryMedia(mediaRec.workflow_id, nextPrimaryMediaId).catch(() => null);
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
}

export default WorkflowMediaService;
