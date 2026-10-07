/**
 * WorkflowServiceBase
 * Platform Service — owns workflow entity lifecycle, metadata mutation,
 * moving workflows across folders/projects, cascading deletion,
 * and entity synchronization.
 *
 * Public methods:
 *   - updateWorkflowMetadata({ workflowId, updates, userId, req })
 *   - patchWorkflow({ id, userId, body, req })
 *   - moveToFolder({ assetId, folderId, userId })
 *   - deleteWorkflow({ workflowId, userId, req })
 *   - bulkDeleteWorkflows({ workflowIds, userId, req })
 *   - toggleLike({ workflowId, userId, req })
 *   - bulkToggleLike({ workflowIds, favorited, userId, req })
 *   - setPrimaryMedia({ workflowId, mediaId, userId, req })
 *   - detachMedia({ mediaId, projectId, sessionId, displayName, userId, req })
 *   - deleteMedia({ mediaId, userId, req })
 */

import { randomUUID } from "node:crypto";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { WorkflowAuthorizationService } from "./WorkflowAuthorizationService.js";
import { WorkflowMediaService } from "./WorkflowMediaService.js";
import { assertOwns } from "../security/ownership.js";
import { toAssetDto } from "../../domain/assetDto.js";
import { AppError } from "../../utils/AppError.js";

function normalizeWorkflowIds(input) {
    const values = Array.isArray(input) ? input : [input];
    return [...new Set(values.map((v) => String(v || "").trim()).filter(Boolean))];
}

export class WorkflowService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db            - Repository map (db.workflows, db.media, db.projects, db.folders)
     * @param {Object} deps.storageService - StorageService instance
     * @param {Object} [deps.authService] - Optional pre-configured WorkflowAuthorizationService
     * @param {Object} [deps.mediaService] - Optional pre-configured WorkflowMediaService
     * @param {Object} [deps.folderService] - Optional FolderService instance
     */
    constructor({ db, storageService, authService, mediaService, folderService = null }) {
        this.db = db;
        this.storageService = storageService;
        this.folderService = folderService;

        this.authService = authService || new WorkflowAuthorizationService({ db });
        this.mediaService = mediaService || new WorkflowMediaService({
            db,
            storageService,
            authService: this.authService,
        });
        this._entitySyncHandlers = null;
    }

    setEntitySyncHandlers(handlers) {
        this._entitySyncHandlers = handlers;
    }

    // ── Backwards-compatible Auth Delegates ───────────────────────────────────

    async _verifyWorkflowOwnership(workflowId, userId, req = null) {
        return this.authService.verifyWorkflowOwnership(workflowId, userId, req);
    }

    async _verifyWorkflowOwnershipBulk(workflowIds, userId, req = null) {
        return this.authService.verifyWorkflowOwnershipBulk(workflowIds, userId, req);
    }

    async _verifyMediaOwnership(mediaId, userId, req = null) {
        return this.authService.verifyMediaOwnership(mediaId, userId, req);
    }

    // ── updateWorkflowMetadata ───────────────────────────────────────────────

    async updateWorkflowMetadata({ workflowId, updates, userId, req = null }) {
        const traceId = randomUUID();
        const start = Date.now();
        const cleanWorkflowId = String(workflowId || "").replace(/^workflows\//, "").trim();

        crudOperationLog({ traceId, operation: "updateWorkflowMetadata", workflowId: cleanWorkflowId });

        try {
            const isAuthorized = await this.authService.verifyWorkflowOwnership(cleanWorkflowId, userId, req);
            if (!isAuthorized) {
                crudOperationLog({
                    traceId,
                    operation: "updateWorkflowMetadata",
                    status: "error",
                    userId,
                    resourceId: cleanWorkflowId,
                    resourceType: "workflow",
                    errorCode: "NOT_FOUND",
                    message: "Workflow not found",
                });
                throw new CrudServiceError("Workflow not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "updateWorkflowMetadata",
                });
            }

            const allowedFields = {};
            if (updates.display_name !== undefined) {
                const cleaned = String(updates.display_name || "").replace(/^@+/, "").trim();
                if (cleaned.length > 0) allowedFields.display_name = cleaned;
            }
            if (updates.primary_media_id !== undefined) {
                allowedFields.primary_media_id = updates.primary_media_id || null;
            }
            if (updates.favorited !== undefined) {
                allowedFields.favorited = Boolean(updates.favorited);
            }

            if (Object.keys(allowedFields).length === 0) {
                throw new CrudServiceError("No supported workflow fields provided", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "updateWorkflowMetadata",
                });
            }

            const workflow = await this.db.workflows.updateFields(cleanWorkflowId, allowedFields);

            crudOperationLog({
                traceId,
                operation: "updateWorkflowMetadata",
                status: "ok",
                durationMs: Date.now() - start,
                workflowId: cleanWorkflowId,
            });

            return { workflow };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "updateWorkflowMetadata",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || err.statusCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    // ── toggleLike & bulkToggleLike ──────────────────────────────────────────

    async toggleLike({ workflowId, userId, req = null }) {
        const isAuthorized = await this.authService.verifyWorkflowOwnership(workflowId, userId, req);
        if (!isAuthorized) {
            crudOperationLog({
                operation: "toggleLike",
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
                operation: "toggleLike",
            });
        }

        const wf = await this.db.workflows.findById(workflowId, "favorited");
        const nextFavorited = !wf?.favorited;
        const updated = await this.db.workflows.updateFields(workflowId, { favorited: nextFavorited });

        return { favorited: updated?.favorited };
    }

    async bulkToggleLike({ workflowIds = [], favorited, userId, req = null }) {
        const cleanIds = normalizeWorkflowIds(workflowIds);
        if (!cleanIds.length) {
            throw new CrudServiceError("workflow_ids is required", {
                statusCode: 400,
                errorCode: "VALIDATION_ERROR",
                operation: "bulkToggleLike",
            });
        }

        const ownedIds = await this.authService.verifyWorkflowOwnershipBulk(cleanIds, userId, req);
        if (!ownedIds) {
            crudOperationLog({
                operation: "bulkToggleLike",
                status: "error",
                userId,
                resourceIds: cleanIds,
                resourceType: "workflow",
                errorCode: "NOT_FOUND",
                message: "Workflow not found",
            });
            throw new CrudServiceError("Workflow not found", {
                statusCode: 404,
                errorCode: "NOT_FOUND",
                operation: "bulkToggleLike",
            });
        }

        const { data: currentRows, error: getErr } = await this.db.workflows.client()
            .from("workflow")
            .select("id, favorited")
            .in("id", ownedIds);
        if (getErr) throw getErr;

        const allCurrentlyFavorited = (currentRows || []).every((row) => Boolean(row.favorited));
        const nextFavorited = favorited === undefined ? !allCurrentlyFavorited : Boolean(favorited);

        const { data, error } = await this.db.workflows.client()
            .from("workflow")
            .update({ favorited: nextFavorited })
            .in("id", ownedIds)
            .select("id, favorited");
        if (error) throw error;

        return {
            workflow_ids: ownedIds,
            count: ownedIds.length,
            favorited: nextFavorited,
            workflows: data || [],
        };
    }

    // ── deleteWorkflow ───────────────────────────────────────────────────────

    async deleteWorkflow({ workflowId, userId, req = null }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "deleteWorkflow", workflowId });

        try {
            if (!workflowId) {
                throw new CrudServiceError("workflowId is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "deleteWorkflow",
                });
            }

            const isAuthorized = await this.authService.verifyWorkflowOwnership(workflowId, userId, req);
            if (!isAuthorized) {
                crudOperationLog({
                    traceId,
                    operation: "deleteWorkflow",
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
                    operation: "deleteWorkflow",
                });
            }

            // 1. Fetch media items to collect storage URLs
            const mediaItems = await this.db.media.findByWorkflow(workflowId).catch(() => []);
            const mediaIds = mediaItems.map((m) => m.id).filter(Boolean);
            const mediaUrls = mediaItems.map((m) => m.url).filter(Boolean);

            // 2. Delete generation config references
            if (mediaIds.length) {
                try {
                    await this.db.media.client()
                        .from("generation_config_reference")
                        .delete()
                        .in("ref_media_id", mediaIds);
                } catch (refErr) {
                    console.warn(`⚠️ [WorkflowServiceBase] Delete generation_config_reference notice:`, refErr.message);
                }
            }

            // 3. Delete media records
            try {
                await this.db.media.client()
                    .from("media")
                    .delete()
                    .eq("workflow_id", workflowId);
            } catch (mediaErr) {
                console.warn(`⚠️ [WorkflowServiceBase] Delete media notice:`, mediaErr.message);
            }

            // 4. Delete workflow row
            try {
                await this.db.workflows.deleteById(workflowId);
            } catch (wfErr) {
                console.warn(`⚠️ [WorkflowServiceBase] Delete workflow row notice:`, wfErr.message);
            }

            // 5. Clean up all associated files in storage
            const storageResult = await this.storageService.deleteByUrls(mediaUrls);

            crudOperationLog({
                traceId,
                operation: "deleteWorkflow",
                status: "ok",
                durationMs: Date.now() - start,
                workflowId,
            });

            return {
                workflowId,
                deletedMediaCount: mediaIds.length,
                storageFailures: storageResult?.failures || [],
            };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "deleteWorkflow",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    // ── bulkDeleteWorkflows ──────────────────────────────────────────────────

    async bulkDeleteWorkflows({ workflowIds = [], userId, req = null }) {
        const traceId = randomUUID();
        const start = Date.now();

        const cleanIds = normalizeWorkflowIds(workflowIds);
        crudOperationLog({ traceId, operation: "bulkDeleteWorkflows", count: cleanIds.length });

        try {
            if (!cleanIds.length) {
                throw new CrudServiceError("workflow_ids is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "bulkDeleteWorkflows",
                });
            }

            const ownedIds = await this.authService.verifyWorkflowOwnershipBulk(cleanIds, userId, req);
            if (!ownedIds) {
                crudOperationLog({
                    traceId,
                    operation: "bulkDeleteWorkflows",
                    status: "error",
                    userId,
                    resourceIds: cleanIds,
                    resourceType: "workflow",
                    errorCode: "NOT_FOUND",
                    message: "Workflow not found",
                });
                throw new CrudServiceError("Workflow not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "bulkDeleteWorkflows",
                });
            }

            const results = await Promise.allSettled(
                ownedIds.map((id) => this.deleteWorkflow({ workflowId: id, userId, req }))
            );

            const successful = results
                .filter((r) => r.status === "fulfilled")
                .map((r) => r.value.workflowId);

            crudOperationLog({
                traceId,
                operation: "bulkDeleteWorkflows",
                status: "ok",
                durationMs: Date.now() - start,
                count: successful.length,
            });

            return {
                workflow_ids: successful,
                count: successful.length,
                results: results.map((r, i) => ({
                    id: ownedIds[i],
                    status: r.status,
                    ...(r.status === "fulfilled" ? r.value : { error: r.reason?.message }),
                })),
            };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "bulkDeleteWorkflows",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    // ── Media Delegations to WorkflowMediaService ─────────────────────────────

    async setPrimaryMedia(params) {
        return this.mediaService.setPrimaryMedia(params);
    }

    async detachMedia(params) {
        return this.mediaService.detachMedia(params);
    }

    async deleteMedia(params) {
        return this.mediaService.deleteMedia(params);
    }

    // ── Folder & Patch Operations ─────────────────────────────────────────────

    /**
     * Moves a workflow asset into a target folder within the same project, or to project root if folderId is null/"none".
     * Validates folderId format (UUID), enforces workflow ownership, asserts folder usability in the project,
     * updates workflow folder_id in repository, and returns public Asset DTO.
     *
     * @param {Object} params
     * @param {string} params.assetId
     * @param {string|null} params.folderId
     * @param {string} params.userId
     * @returns {Promise<Object>} Formatted Asset DTO
     */
    async moveToFolder({ assetId, folderId, userId }) {
        if (!assetId) {
            const err = new AppError("Asset ID is required", 400);
            err.errorCode = "VALIDATION_ERROR";
            throw err;
        }
        if (!userId) {
            const err = new AppError("Authentication required", 401);
            err.errorCode = "UNAUTHORIZED";
            throw err;
        }

        let targetFolderId = null;
        if (folderId !== null && folderId !== undefined && String(folderId).toLowerCase() !== "none") {
            const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (typeof folderId !== "string" || !folderId.trim() || !UUID_REGEX.test(folderId.trim())) {
                const err = new AppError("folderId must be a valid UUID or null", 400);
                err.errorCode = "VALIDATION_ERROR";
                throw err;
            }
            targetFolderId = folderId.trim();
        }

        // 1. Assert asset ownership (returns 404 on missing or foreign asset)
        const asset = await assertOwns("workflow", assetId, userId);

        // 2. If targetFolderId is provided, validate folder is usable in this project
        if (targetFolderId !== null) {
            if (this.folderService) {
                await this.folderService.assertFolderUsable(targetFolderId, userId, asset.project_id);
            } else {
                const folder = await this.db.folders.findOwnedInProject(targetFolderId, asset.project_id, userId);
                if (!folder) {
                    const err = new AppError("Target folder not found in project", 404);
                    err.errorCode = "NOT_FOUND";
                    throw err;
                }
            }
        }

        // 3. Update folder_id in DB scoped by user and project
        try {
            const updated = await this.db.workflows.updateFolderId(assetId, targetFolderId, userId, asset.project_id);
            return toAssetDto(updated || { ...asset, folder_id: targetFolderId });
        } catch (dbErr) {
            if (dbErr.code === "23503" || dbErr.code === "PGRST116" || dbErr.statusCode === 404) {
                const err = new AppError("Asset or target folder not found in project", 404);
                err.errorCode = "NOT_FOUND";
                throw err;
            }
            throw dbErr;
        }
    }

    /**
     * Handles generic workflow update with mass-assignment defense, workflow/media resolution,
     * metadata update, and optional character/element synchronization.
     *
     * @param {Object} params
     * @param {string} params.id
     * @param {string} params.userId
     * @param {Object} params.body
     * @param {Object} [params.req]
     * @returns {Promise<{ workflow: Object, displayName: string }>}
     */
    async patchWorkflow({ id, userId, body = {}, req = null }) {
        const forbiddenKeys = ["folderId", "folder_id", "projectId", "project_id", "userId", "user_id"];
        for (const key of forbiddenKeys) {
            if (body[key] !== undefined) {
                const err = new AppError(`Updating '${key}' via generic workflow update is forbidden`, 400);
                err.code = "MASS_ASSIGNMENT_FORBIDDEN";
                err.errorCode = "MASS_ASSIGNMENT_FORBIDDEN";
                throw err;
            }
        }

        const cleanId = String(id || "").replace(/^workflows\//, "").trim();
        let targetWorkflowId = cleanId;

        // Resolve media_id to its parent workflow_id if cleanId is not directly a workflow
        const wfExists = await this.db.workflows.findById(cleanId).catch(() => null);
        if (!wfExists) {
            const mediaRecord = await this.db.media.findById(cleanId).catch(() => null);
            if (mediaRecord?.workflow_id) {
                targetWorkflowId = mediaRecord.workflow_id;
            }
        }

        const { display_name, name, primary_media_id, favorited, description, character_info } = body;
        const updates = {};
        const targetName = display_name !== undefined ? display_name : name;
        if (targetName !== undefined) updates.display_name = targetName;
        if (primary_media_id !== undefined) updates.primary_media_id = primary_media_id;
        if (favorited !== undefined) updates.favorited = favorited;

        const result = await this.updateWorkflowMetadata({
            workflowId: targetWorkflowId,
            updates,
            userId,
            req,
        });

        // Sync with character and element entities if handlers are registered
        if (this._entitySyncHandlers) {
            const descVal = description !== undefined ? description : character_info;
            if (this._entitySyncHandlers.syncCharacter && (descVal !== undefined || targetName !== undefined)) {
                await this._entitySyncHandlers.syncCharacter(targetWorkflowId, {
                    ...(descVal !== undefined ? { description: descVal, character_info: descVal } : {}),
                    ...(targetName !== undefined ? { name: targetName } : {}),
                }, userId).catch(() => {});
            }
            if (this._entitySyncHandlers.syncElement && targetName !== undefined) {
                await this._entitySyncHandlers.syncElement(targetWorkflowId, targetName).catch(() => {});
            }
        }

        return { workflow: result.workflow, displayName: targetName };
    }
}

export default WorkflowService;
