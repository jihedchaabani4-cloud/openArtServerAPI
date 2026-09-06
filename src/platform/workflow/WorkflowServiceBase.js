/**
 * WorkflowService
 * Canonical domain owner of all workflow operations:
 *   - updateWorkflowMetadata
 *   - moveWorkflow
 *   - setPrimaryMedia
 *   - detachMedia
 *   - deleteMedia
 *   - deleteWorkflow
 *   - bulkDeleteWorkflows
 *
 * Feature: 024-unify-domain-crud
 * Contract: specs/024-unify-domain-crud/contracts/domain-crud-contract.md
 */

import { randomUUID } from "node:crypto";
import { supabase } from "../../../lib/supabase.js";
import { assertMediaUsable } from "../../../lib/mediaGuards.js";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { extractStoragePath } from "../../utils/storagePath.js";

// ── Internal helpers ─────────────────────────────────────────────────────────

function normalizeWorkflowIds(input) {
    const values = Array.isArray(input) ? input : [input];
    return [...new Set(values.map((v) => String(v || "").trim()).filter(Boolean))];
}

export class WorkflowService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db           - Repository map from container (db.workflows, db.media, etc.)
     * @param {Object} deps.storageService - StorageService instance
     */
    constructor({ db, storageService }) {
        this.db = db;
        this.storageService = storageService;
    }

    // ── Ownership helpers ────────────────────────────────────────────────────

    async _verifyWorkflowOwnership(workflowId, userId, req = null) {
        const result = await this._verifyWorkflowOwnershipBulk([workflowId], userId, req);
        return Boolean(result && result.length === 1);
    }

    async _verifyWorkflowOwnershipBulk(workflowIds, userId, req = null) {
        if (!workflowIds.length) return [];

        const secret = req?.headers?.["x-internal-secret"];
        const isInternal = secret && secret === (process.env.INTERNAL_SECRET || "openart_internal_s2s_secret_2026");
        const isDev = process.env.DEV_AUTH_BYPASS === "true" || process.env.DEV_AUTH_BYPASS === true;

        if (isInternal || isDev) return workflowIds;

        const { data, error } = await supabase
            .from("workflow")
            .select("id, project:project!project_id(user_id)")
            .in("id", workflowIds);

        if (error) throw error;

        const ownedIds = (data || [])
            .filter((wf) => !wf.project?.user_id || wf.project?.user_id === userId)
            .map((wf) => wf.id);

        if (ownedIds.length !== workflowIds.length) return null;
        return ownedIds;
    }

    async _verifyMediaOwnership(mediaId, userId, req = null) {
        const secret = req?.headers?.["x-internal-secret"];
        const isInternal = secret && secret === (process.env.INTERNAL_SECRET || "openart_internal_s2s_secret_2026");
        const isDev = process.env.DEV_AUTH_BYPASS === "true" || process.env.DEV_AUTH_BYPASS === true;

        if (isInternal || isDev) return true;

        const { data: media, error } = await supabase
            .from("media")
            .select("id, project:project!project_id(user_id)")
            .eq("id", mediaId)
            .single();

        if (error || !media || (media.project?.user_id && media.project?.user_id !== userId)) return false;
        return true;
    }

    // ── Storage cleanup ──────────────────────────────────────────────────────

    async _deleteStoragePaths(filePaths = []) {
        const normalizedPaths = [...new Set((filePaths || []).filter(Boolean))];
        if (!normalizedPaths.length) return { deletedCount: 0, failures: [] };

        if (typeof this.storageService.deleteFiles === "function") {
            return this.storageService.deleteFiles(normalizedPaths);
        }

        const results = await Promise.allSettled(
            normalizedPaths.map((path) => this.storageService.delete(path))
        );

        const failures = results
            .map((result, index) =>
                result.status === "rejected"
                    ? { path: normalizedPaths[index], error: result.reason }
                    : null
            )
            .filter(Boolean);

        return { deletedCount: normalizedPaths.length - failures.length, failures };
    }

    // ── Shared delete resources ──────────────────────────────────────────────

    async _deleteWorkflowResources(workflowId) {
        const { data: mediaItems, error: mediaError } = await supabase
            .from("media")
            .select("id, url")
            .eq("workflow_id", workflowId);

        if (mediaError) throw mediaError;

        const mediaIds   = (mediaItems || []).map((m) => m.id).filter(Boolean);
        const filePaths  = (mediaItems || []).map((m) => extractStoragePath(m.url)).filter(Boolean);

        if (mediaIds.length) {
            const { error: refsError } = await supabase
                .from("generation_config_reference")
                .delete()
                .in("ref_media_id", mediaIds);
            if (refsError) throw refsError;
        }

        const { error: mediaDeleteError } = await supabase
            .from("media")
            .delete()
            .eq("workflow_id", workflowId);
        if (mediaDeleteError) throw mediaDeleteError;

        const { error: workflowDeleteError } = await supabase
            .from("workflow")
            .delete()
            .eq("id", workflowId);
        if (workflowDeleteError) throw workflowDeleteError;

        const storageResult = await this._deleteStoragePaths(filePaths);

        return {
            workflowId,
            deletedMediaCount: mediaIds.length,
            storageFailures: storageResult.failures || [],
        };
    }

    // ── updateWorkflowMetadata ───────────────────────────────────────────────

    async updateWorkflowMetadata({ workflowId, updates, userId, req = null }) {
        const traceId = randomUUID();
        const start   = Date.now();

        crudOperationLog({ traceId, operation: "updateWorkflowMetadata", workflowId });

        try {
            const isAuthorized = await this._verifyWorkflowOwnership(workflowId, userId, req);
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
                allowedFields.favorited = !!updates.favorited;
            }

            if (Object.keys(allowedFields).length === 0) {
                throw new CrudServiceError("No supported workflow fields provided", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "updateWorkflowMetadata",
                });
            }

            const { data: workflow, error } = await supabase
                .from("workflow")
                .update(allowedFields)
                .eq("id", workflowId)
                .select()
                .single();

            if (error) throw error;

            crudOperationLog({
                traceId,
                operation: "updateWorkflowMetadata",
                status: "ok",
                durationMs: Date.now() - start,
                workflowId,
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

    // ── moveWorkflow ─────────────────────────────────────────────────────────

    async moveWorkflow({ workflowId, sessionId, projectId, newsession, sessionName, userId, req = null }) {
        const traceId = randomUUID();
        const start   = Date.now();

        crudOperationLog({ traceId, operation: "moveWorkflow", workflowId });

        try {
            const isAuthorized = await this._verifyWorkflowOwnership(workflowId, userId, req);
            if (!isAuthorized) {
                throw new CrudServiceError("Unauthorized access to this workflow", {
                    statusCode: 403, errorCode: "FORBIDDEN", traceId, operation: "moveWorkflow",
                });
            }

            if (!sessionId && !newsession) {
                throw new CrudServiceError("session_id or newsession is required", {
                    statusCode: 400, errorCode: "VALIDATION_ERROR", traceId, operation: "moveWorkflow",
                });
            }

            if (sessionId) {
                const { data: session } = await supabase
                    .from("session")
                    .select("id, project:project!project_id(user_id)")
                    .eq("id", sessionId)
                    .single();
                if (!session || (session.project?.user_id && session.project.user_id !== userId)) {
                    throw new CrudServiceError("Unauthorized access to target session", {
                        statusCode: 403, errorCode: "FORBIDDEN", traceId, operation: "moveWorkflow",
                    });
                }
            }

            if (projectId) {
                const { data: project } = await supabase
                    .from("project")
                    .select("user_id")
                    .eq("id", projectId)
                    .single();
                if (!project || (project.user_id && project.user_id !== userId)) {
                    throw new CrudServiceError("Unauthorized access to target project", {
                        statusCode: 403, errorCode: "FORBIDDEN", traceId, operation: "moveWorkflow",
                    });
                }
            }

            let targetSessionId = sessionId;
            let targetProjectId = projectId;
            let createdSession  = null;

            if (newsession) {
                if (!targetProjectId) {
                    const { data: wf } = await supabase
                        .from("workflow")
                        .select("project_id")
                        .eq("id", workflowId)
                        .single();
                    if (wf) targetProjectId = wf.project_id;
                }
                if (!targetProjectId) {
                    throw new CrudServiceError("Cannot determine project_id for new session", {
                        statusCode: 400, errorCode: "VALIDATION_ERROR", traceId, operation: "moveWorkflow",
                    });
                }
                const { data: newSession, error: sessionError } = await supabase
                    .from("session")
                    .insert([{ name: sessionName || "New Session", project_id: targetProjectId, position: 0 }])
                    .select()
                    .single();
                if (sessionError) throw new Error(`Failed to create session: ${sessionError.message}`);
                targetSessionId = newSession.id;
                createdSession  = newSession;
            }

            const wfUpdates = { session_id: targetSessionId };
            if (targetProjectId) wfUpdates.project_id = targetProjectId;

            const { data: workflow, error } = await supabase
                .from("workflow")
                .update(wfUpdates)
                .eq("id", workflowId)
                .select()
                .single();
            if (error) throw error;

            if (targetProjectId) {
                await supabase
                    .from("media")
                    .update({ project_id: targetProjectId })
                    .eq("workflow_id", workflowId);
            }

            crudOperationLog({
                traceId, operation: "moveWorkflow", status: "ok",
                durationMs: Date.now() - start, workflowId,
            });

            return { workflow, new_session: createdSession };
        } catch (err) {
            crudOperationLog({
                traceId, operation: "moveWorkflow", status: "error",
                durationMs: Date.now() - start, errorCode: err.errorCode || 500, message: err.message,
            });
            throw err;
        }
    }

    // ── setPrimaryMedia ──────────────────────────────────────────────────────

    async setPrimaryMedia({ workflowId, mediaId, userId, req = null }) {
        const traceId = randomUUID();
        const start   = Date.now();

        crudOperationLog({ traceId, operation: "setPrimaryMedia", workflowId, mediaId });

        try {
            if (!mediaId) {
                throw new CrudServiceError("media_id is required", {
                    statusCode: 400, errorCode: "VALIDATION_ERROR", traceId, operation: "setPrimaryMedia",
                });
            }

            const [wfOk, mediaOk] = await Promise.all([
                this._verifyWorkflowOwnership(workflowId, userId, req),
                this._verifyMediaOwnership(mediaId, userId, req),
            ]);

            if (!wfOk) {
                throw new CrudServiceError("Unauthorized access to this workflow", {
                    statusCode: 403, errorCode: "FORBIDDEN", traceId, operation: "setPrimaryMedia",
                });
            }
            if (!mediaOk) {
                throw new CrudServiceError("Unauthorized access to this media", {
                    statusCode: 403, errorCode: "FORBIDDEN", traceId, operation: "setPrimaryMedia",
                });
            }

            await assertMediaUsable({ media_id: mediaId, workflow_id: workflowId }, { allowProcessing: true });

            const { data, error } = await supabase
                .from("workflow")
                .update({ primary_media_id: mediaId })
                .eq("id", workflowId)
                .select()
                .single();
            if (error) throw error;

            crudOperationLog({
                traceId, operation: "setPrimaryMedia", status: "ok",
                durationMs: Date.now() - start, workflowId, mediaId,
            });

            return { primary_media_id: data.primary_media_id };
        } catch (err) {
            crudOperationLog({
                traceId, operation: "setPrimaryMedia", status: "error",
                durationMs: Date.now() - start, errorCode: err.errorCode || 500, message: err.message,
            });
            throw err;
        }
    }

    // ── detachMedia ──────────────────────────────────────────────────────────

    async detachMedia({ mediaId, projectId, sessionId, displayName, userId, req = null }) {
        const traceId = randomUUID();
        const start   = Date.now();

        crudOperationLog({ traceId, operation: "detachMedia", mediaId });

        try {
            if (!mediaId) {
                throw new CrudServiceError("media_id is required", {
                    statusCode: 400, errorCode: "VALIDATION_ERROR", traceId, operation: "detachMedia",
                });
            }

            const isAuthorized = await this._verifyMediaOwnership(mediaId, userId, req);
            if (!isAuthorized) {
                throw new CrudServiceError("Unauthorized access to this media", {
                    statusCode: 403, errorCode: "FORBIDDEN", traceId, operation: "detachMedia",
                });
            }

            const { data: media, error: mediaErr } = await supabase
                .from("media")
                .select("*, workflow:workflow!workflow_id(id, project_id, session_id, display_name)")
                .eq("id", mediaId)
                .single();
            if (mediaErr) throw mediaErr;

            const status = (media.status || "").toString().toLowerCase();
            if (["processing", "pending", "uploading"].includes(status)) {
                throw new CrudServiceError("Cannot detach media while generation is in progress", {
                    statusCode: 403, errorCode: "MEDIA_BUSY", traceId, operation: "detachMedia",
                });
            }

            const currentWorkflowId  = media.workflow_id;
            const inferredProjectId  = media.project_id || media.workflow?.project_id;
            const inferredSessionId  = media.workflow?.session_id;
            const newName            = displayName || media.workflow?.display_name || "Detached media";

            const { data: newWorkflow, error: wfErr } = await supabase
                .from("workflow")
                .insert({
                    project_id:      inferredProjectId,
                    session_id:      inferredSessionId,
                    display_name:    newName,
                    variation_index: 0,
                    primary_media_id: null,
                })
                .select("*")
                .single();
            if (wfErr) throw wfErr;

            await supabase
                .from("media")
                .update({ workflow_id: newWorkflow.id, project_id: inferredProjectId })
                .eq("id", mediaId);

            const { data: updatedWorkflow } = await supabase
                .from("workflow")
                .update({ primary_media_id: mediaId })
                .eq("id", newWorkflow.id)
                .select("*")
                .single();

            if (currentWorkflowId) {
                const { data: oldWf } = await supabase
                    .from("workflow")
                    .select("primary_media_id")
                    .eq("id", currentWorkflowId)
                    .single();

                if (oldWf?.primary_media_id === mediaId) {
                    const { data: remaining } = await supabase
                        .from("media")
                        .select("id")
                        .eq("workflow_id", currentWorkflowId)
                        .order("create_time", { ascending: true })
                        .limit(1);
                    const nextPrimary = remaining?.[0]?.id ?? null;
                    await supabase
                        .from("workflow")
                        .update({ primary_media_id: nextPrimary })
                        .eq("id", currentWorkflowId);
                }
            }

            crudOperationLog({
                traceId, operation: "detachMedia", status: "ok",
                durationMs: Date.now() - start, mediaId, newWorkflowId: newWorkflow.id,
            });

            return { workflow: updatedWorkflow };
        } catch (err) {
            crudOperationLog({
                traceId, operation: "detachMedia", status: "error",
                durationMs: Date.now() - start, errorCode: err.errorCode || 500, message: err.message,
            });
            throw err;
        }
    }

    // ── deleteMedia ──────────────────────────────────────────────────────────

    async deleteMedia({ mediaId, userId, req = null }) {
        const traceId = randomUUID();
        const start   = Date.now();

        crudOperationLog({ traceId, operation: "deleteMedia", mediaId });

        try {
            if (!mediaId) {
                throw new CrudServiceError("media_id is required", {
                    statusCode: 400, errorCode: "VALIDATION_ERROR", traceId, operation: "deleteMedia",
                });
            }

            const isAuthorized = await this._verifyMediaOwnership(mediaId, userId, req);
            if (!isAuthorized) {
                throw new CrudServiceError("Unauthorized access to this media", {
                    statusCode: 403, errorCode: "FORBIDDEN", traceId, operation: "deleteMedia",
                });
            }

            const { data: mediaRec, error: mediaFetchError } = await supabase
                .from("media")
                .select("id, workflow_id, url")
                .eq("id", mediaId)
                .maybeSingle();
            if (mediaFetchError) throw mediaFetchError;

            const { error: refsError } = await supabase
                .from("generation_config_reference")
                .delete()
                .eq("ref_media_id", mediaId);
            if (refsError) throw refsError;

            const { data: deleted, error } = await supabase
                .from("media")
                .delete()
                .eq("id", mediaId)
                .select()
                .single();
            if (error) throw error;

            await this._deleteStoragePaths([extractStoragePath(mediaRec?.url)]);

            let workflowDeleted    = false;
            let nextPrimaryMediaId = null;

            if (mediaRec?.workflow_id) {
                const { data: remainingMedia, error: remainingError } = await supabase
                    .from("media")
                    .select("id")
                    .eq("workflow_id", mediaRec.workflow_id)
                    .order("create_time", { ascending: true });

                if (remainingError) throw remainingError;

                if (!remainingMedia?.length) {
                    const { error: workflowDeleteError } = await supabase
                        .from("workflow")
                        .delete()
                        .eq("id", mediaRec.workflow_id);
                    if (workflowDeleteError) throw workflowDeleteError;
                    workflowDeleted = true;
                    console.log(`🧹 [WorkflowService] Empty workflow ${mediaRec.workflow_id} cleaned up.`);
                } else {
                    const { data: workflowRecord } = await supabase
                        .from("workflow")
                        .select("primary_media_id")
                        .eq("id", mediaRec.workflow_id)
                        .maybeSingle();

                    if (workflowRecord?.primary_media_id === mediaId) {
                        nextPrimaryMediaId = remainingMedia[0]?.id || null;
                        const { error: primaryUpdateError } = await supabase
                            .from("workflow")
                            .update({ primary_media_id: nextPrimaryMediaId })
                            .eq("id", mediaRec.workflow_id);
                        if (primaryUpdateError) throw primaryUpdateError;
                    }
                }
            }

            crudOperationLog({
                traceId, operation: "deleteMedia", status: "ok",
                durationMs: Date.now() - start, mediaId, workflowDeleted,
            });

            return { deleted, workflow_deleted: workflowDeleted, next_primary_media_id: nextPrimaryMediaId };
        } catch (err) {
            crudOperationLog({
                traceId, operation: "deleteMedia", status: "error",
                durationMs: Date.now() - start, errorCode: err.errorCode || 500, message: err.message,
            });
            throw err;
        }
    }

    // ── deleteWorkflow ───────────────────────────────────────────────────────

    async deleteWorkflow({ workflowId, userId, req = null }) {
        const traceId = randomUUID();
        const start   = Date.now();

        crudOperationLog({ traceId, operation: "deleteWorkflow", workflowId });

        try {
            const isAuthorized = await this._verifyWorkflowOwnership(workflowId, userId, req);
            if (!isAuthorized) {
                throw new CrudServiceError("Unauthorized access to this workflow", {
                    statusCode: 403, errorCode: "FORBIDDEN", traceId, operation: "deleteWorkflow",
                });
            }

            const result = await this._deleteWorkflowResources(workflowId);

            crudOperationLog({
                traceId, operation: "deleteWorkflow", status: "ok",
                durationMs: Date.now() - start, workflowId, deletedMediaCount: result.deletedMediaCount,
            });

            return result;
        } catch (err) {
            crudOperationLog({
                traceId, operation: "deleteWorkflow", status: "error",
                durationMs: Date.now() - start, errorCode: err.errorCode || 500, message: err.message,
            });
            throw err;
        }
    }

    // ── bulkDeleteWorkflows ──────────────────────────────────────────────────

    async bulkDeleteWorkflows({ workflowIds, userId, req = null }) {
        const traceId = randomUUID();
        const start   = Date.now();

        const ids = normalizeWorkflowIds(workflowIds);
        crudOperationLog({ traceId, operation: "bulkDeleteWorkflows", count: ids.length });

        try {
            if (!ids.length) {
                throw new CrudServiceError("workflow_ids is required", {
                    statusCode: 400, errorCode: "VALIDATION_ERROR", traceId, operation: "bulkDeleteWorkflows",
                });
            }

            const ownedIds = await this._verifyWorkflowOwnershipBulk(ids, userId, req);
            if (!ownedIds) {
                throw new CrudServiceError("Unauthorized access to one or more workflows", {
                    statusCode: 403, errorCode: "FORBIDDEN", traceId, operation: "bulkDeleteWorkflows",
                });
            }

            const results = [];
            for (const wfId of ownedIds) {
                results.push(await this._deleteWorkflowResources(wfId));
            }

            crudOperationLog({
                traceId, operation: "bulkDeleteWorkflows", status: "ok",
                durationMs: Date.now() - start, count: ownedIds.length,
            });

            return { workflow_ids: ownedIds, count: ownedIds.length, results };
        } catch (err) {
            crudOperationLog({
                traceId, operation: "bulkDeleteWorkflows", status: "error",
                durationMs: Date.now() - start, errorCode: err.errorCode || 500, message: err.message,
            });
            throw err;
        }
    }
}

export default WorkflowService;
