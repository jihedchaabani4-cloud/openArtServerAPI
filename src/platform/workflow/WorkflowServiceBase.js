/**
 * WorkflowServiceBase
 * Canonical Platform Service orchestrating Workflow entity lifecycles,
 * metadata updates, moving workflows across sessions/projects, and cascading deletion.
 *
 * Clean Architecture Boundary:
 *   - WorkflowAuthorizationService handles all ownership and permission checks.
 *   - WorkflowMediaService handles media associations, detachment, and media deletions.
 *   - StorageService handles all storage file cleanups.
 *   - Repositories (db.workflows, db.media, db.projects, db.sessions) handle all data persistence.
 *   - ZERO raw supabase.from(...) queries in this service.
 */

import { randomUUID } from "node:crypto";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { WorkflowAuthorizationService } from "./WorkflowAuthorizationService.js";
import { WorkflowMediaService } from "./WorkflowMediaService.js";

function normalizeWorkflowIds(input) {
    const values = Array.isArray(input) ? input : [input];
    return [...new Set(values.map((v) => String(v || "").trim()).filter(Boolean))];
}

export class WorkflowService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db            - Repository map (db.workflows, db.media, db.projects, db.sessions)
     * @param {Object} deps.storageService - StorageService instance
     * @param {Object} [deps.authService] - Optional pre-configured WorkflowAuthorizationService
     * @param {Object} [deps.mediaService] - Optional pre-configured WorkflowMediaService
     */
    constructor({ db, storageService, authService, mediaService }) {
        this.db = db;
        this.storageService = storageService;

        this.authService = authService || new WorkflowAuthorizationService({ db });
        this.mediaService = mediaService || new WorkflowMediaService({
            db,
            storageService,
            authService: this.authService,
        });
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
                throw new CrudServiceError("Unauthorized access to this workflow", {
                    statusCode: 403,
                    errorCode: "FORBIDDEN",
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
            throw new CrudServiceError("Unauthorized access to this workflow", {
                statusCode: 403,
                errorCode: "FORBIDDEN",
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
            throw new CrudServiceError("Unauthorized access to one or more workflows", {
                statusCode: 403,
                errorCode: "FORBIDDEN",
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

    // ── moveWorkflow ─────────────────────────────────────────────────────────

    async moveWorkflow({ workflowId, sessionId, projectId, newsession, sessionName, userId, req = null }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "moveWorkflow", workflowId });

        try {
            const isAuthorized = await this.authService.verifyWorkflowOwnership(workflowId, userId, req);
            if (!isAuthorized) {
                throw new CrudServiceError("Unauthorized access to this workflow", {
                    statusCode: 403,
                    errorCode: "FORBIDDEN",
                    traceId,
                    operation: "moveWorkflow",
                });
            }

            if (!sessionId && !newsession) {
                throw new CrudServiceError("session_id or newsession is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "moveWorkflow",
                });
            }

            if (sessionId) {
                const session = await this.db.sessions.findById(sessionId, "id, project_id");
                if (!session) {
                    throw new CrudServiceError("Target session not found", {
                        statusCode: 404,
                        errorCode: "NOT_FOUND",
                        traceId,
                        operation: "moveWorkflow",
                    });
                }
            }

            if (projectId) {
                const project = await this.db.projects.findById(projectId, "user_id");
                if (!project || (project.user_id && project.user_id !== userId)) {
                    throw new CrudServiceError("Unauthorized access to target project", {
                        statusCode: 403,
                        errorCode: "FORBIDDEN",
                        traceId,
                        operation: "moveWorkflow",
                    });
                }
            }

            let targetSessionId = sessionId;
            let targetProjectId = projectId;
            let createdSession = null;

            if (newsession) {
                if (!targetProjectId) {
                    const wf = await this.db.workflows.findById(workflowId, "project_id");
                    if (wf?.project_id) targetProjectId = wf.project_id;
                }
                if (!targetProjectId) {
                    throw new CrudServiceError("Cannot determine project_id for new session", {
                        statusCode: 400,
                        errorCode: "VALIDATION_ERROR",
                        traceId,
                        operation: "moveWorkflow",
                    });
                }

                createdSession = await this.db.sessions.createSession({
                    name: sessionName || "New Session",
                    project_id: targetProjectId,
                    position: 0,
                });
                targetSessionId = createdSession.id;
            }

            const wfUpdates = { session_id: targetSessionId };
            if (targetProjectId) wfUpdates.project_id = targetProjectId;

            const workflow = await this.db.workflows.updateFields(workflowId, wfUpdates);

            if (targetProjectId) {
                await this.db.media.client()
                    .from("media")
                    .update({ project_id: targetProjectId })
                    .eq("workflow_id", workflowId);
            }

            crudOperationLog({
                traceId,
                operation: "moveWorkflow",
                status: "ok",
                durationMs: Date.now() - start,
                workflowId,
            });

            return { workflow, new_session: createdSession };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "moveWorkflow",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
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
                throw new CrudServiceError("Unauthorized access to this workflow", {
                    statusCode: 403,
                    errorCode: "FORBIDDEN",
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
                throw new CrudServiceError("Unauthorized access to one or more workflows", {
                    statusCode: 403,
                    errorCode: "FORBIDDEN",
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
}

export default WorkflowService;
