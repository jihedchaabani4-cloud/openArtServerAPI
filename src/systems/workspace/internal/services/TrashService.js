/**
 * TrashService
 * @owns System 8: Workspace — Workflow trash lifecycle (move to trash, permanent delete dispatch, bulk delete, and restore)
 *
 * Public methods:
 *   - requestDelete({ kind, id, userId, req })
 *   - requestDeleteMany({ ids, userId, req })
 *   - bulkDeleteWorkspace({ userId, folder_ids, workflow_ids, character_ids, element_ids, ... })
 *   - deleteTrashed({ userId, workflow_ids, all, project_id, ... })
 *   - restore({ workflowId, userId })
 *   - restoreAll({ userId, projectId, workflowIds })
 */

import { randomUUID } from "node:crypto";
import {
    crudOperationLog,
    CrudServiceError,
    envConfig,
    clampBulkDeleteConcurrency,
    runWithConcurrency,
} from "#shared";
import { assertOwns } from "#identity/tools";
import {
    hasInFlightMedia,
    areAllWorkflowMediaFailed,
    MediaConflictError,
} from "#media/tools";
import { getMediaStatusesByWorkflowIds } from "./workflowMediaStatus.js";
import {
    indexById,
    indexChildren,
    collectDescendantIds,
    getDepth,
} from "./folderTree.js";

const BULK_DELETE_MAX_ITEMS = 100;

function cleanWorkflowId(rawId) {
    return String(rawId || "").replace(/^workflows\//, "").trim();
}

function normalizeWorkflowIds(ids = []) {
    return [...new Set((ids || []).map(cleanWorkflowId).filter(Boolean))];
}

function parseStrictIdArray(rawSnake, rawCamel, fieldName, { stripWorkflowPrefix = false, traceId, operation } = {}) {
    const rawValues = [];

    for (const [label, value] of [[fieldName, rawSnake], [`${fieldName} (camelCase)`, rawCamel]]) {
        if (value === undefined) continue;
        if (!Array.isArray(value)) {
            throw new CrudServiceError(`${label} must be an array of non-empty strings`, {
                statusCode: 400,
                errorCode: "VALIDATION_ERROR",
                traceId,
                operation,
            });
        }
        for (const item of value) {
            if (typeof item !== "string") {
                throw new CrudServiceError(`${label} entries must be non-empty strings`, {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation,
                });
            }
            const trimmed = stripWorkflowPrefix ? cleanWorkflowId(item) : item.trim();
            if (!trimmed) {
                throw new CrudServiceError(`${label} entries must be non-empty strings`, {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation,
                });
            }
            rawValues.push(trimmed);
        }
    }

    return {
        rawCount: rawValues.length,
        uniqueIds: [...new Set(rawValues)],
    };
}

function buildEmptyDeleteResult(workflowId, extra = {}) {
    return {
        workflowId,
        unlinkedMediaCount: 0,
        deletedOrphanCount: 0,
        deletedMediaCount: 0,
        storageFailures: [],
        ...extra,
    };
}

export class TrashService {
    constructor({ db, workflowService, elementService, characterService, authService = null } = {}) {
        if (!db?.trash) {
            throw new Error("TrashService requires db.trash (TrashRepository)");
        }
        if (!workflowService) {
            throw new Error("TrashService requires workflowService");
        }
        if (!elementService) {
            throw new Error("TrashService requires elementService");
        }
        if (!characterService) {
            throw new Error("TrashService requires characterService");
        }

        this.db = db;
        this.workflowService = workflowService;
        this.elementService = elementService;
        this.characterService = characterService;
        this.authService = authService || workflowService.authService;
    }

    async _resolveOwnedWorkflowTarget({ kind, id, userId, req, traceId }) {
        if (kind === "workflow") {
            const cleanId = cleanWorkflowId(id);
            if (!cleanId) {
                throw new CrudServiceError("workflowId is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "requestDelete",
                });
            }
            const isOwned = await this.authService.verifyWorkflowOwnership(cleanId, userId, req);
            if (!isOwned) {
                throw new CrudServiceError("Workflow not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "requestDelete",
                });
            }
            return { workflowId: cleanId, orphanKind: null, orphanId: null };
        }

        if (kind === "element") {
            if (!id) {
                throw new CrudServiceError("elementId is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "requestDelete",
                });
            }
            await assertOwns("element", id, userId);
            const elementRecord = await this.db.elements.resolveRecord(id);
            if (elementRecord && !elementRecord.workflow_id) {
                return { workflowId: null, orphanKind: "element", orphanId: elementRecord.id };
            }
            return {
                workflowId: elementRecord ? elementRecord.workflow_id : id,
                orphanKind: null,
                orphanId: null,
            };
        }

        if (kind === "character") {
            if (!id) {
                throw new CrudServiceError("characterId is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "requestDelete",
                });
            }
            await assertOwns("character", id, userId);
            const charRecord = await this.db.characters.findByCharacterId(id);
            if (charRecord && !charRecord.workflow_id) {
                return { workflowId: null, orphanKind: "character", orphanId: charRecord.id };
            }
            return {
                workflowId: charRecord?.workflow_id || id,
                orphanKind: null,
                orphanId: null,
            };
        }

        throw new CrudServiceError(`Unsupported delete kind: ${kind}`, {
            statusCode: 400,
            errorCode: "VALIDATION_ERROR",
            traceId,
            operation: "requestDelete",
        });
    }

    async permanentlyDeleteByWorkflowOwner({ workflowId, userId, req = null }) {
        return this._permanentlyDeleteByWorkflowOwner({ workflowId, userId, req });
    }

    async _permanentlyDeleteByWorkflowOwner({ workflowId, userId, req }) {
        const elementRecord = this.db.elements?.findByWorkflowId
            ? await this.db.elements.findByWorkflowId(workflowId)
            : null;
        if (elementRecord) {
            return this.elementService.deleteElement(elementRecord.id, userId);
        }

        const characterRecord = this.db.characters?.findByCharacterId
            ? await this.db.characters.findByCharacterId(workflowId)
            : null;
        if (characterRecord) {
            return this.characterService.deleteCharacter({ characterId: workflowId, userId, req });
        }

        return this.workflowService.deleteWorkflow({ workflowId, userId, req });
    }

    async _findUserTrashedWorkflowIds({ userId, workflowIds = null } = {}) {
        if (typeof this.db.trash.findTrashedWorkflowIds === "function") {
            return this.db.trash.findTrashedWorkflowIds({ userId, workflowIds });
        }
        if (typeof this.db.trash.listWorkflowIds === "function") {
            return this.db.trash.listWorkflowIds({ userId, workflowIds });
        }
        return [];
    }

    async _getMediaStatusesByWorkflowIds(workflowIds = []) {
        return getMediaStatusesByWorkflowIds({
            workflowIds,
            mediaRepo: this.db?.media || null,
            workflowMediaRepo: this.db?.workflowMedia || null,
        });
    }

    /**
     * Explicit-intent unified Workspace Bulk Delete (Move-to-Trash).
     * Never permanently deletes active or already-trashed workflows.
     * Permanently deletes selected folder subtrees deepest-first (after moving contained workflows to Trash
     * and clearing folder_id = NULL) and directly deletes orphan Characters/Elements (workflow_id == null).
     */
    async bulkDeleteWorkspace({
        userId,
        folder_ids,
        folderIds,
        workflow_ids,
        workflowIds,
        character_ids,
        characterIds,
        element_ids,
        elementIds,
        concurrency,
        req = null,
    } = {}) {
        const traceId = randomUUID();
        const start = Date.now();
        const operation = "workspace.bulkDelete";

        try {
            if (!userId) {
                throw new CrudServiceError("Authentication required", {
                    statusCode: 401,
                    errorCode: "UNAUTHORIZED",
                    traceId,
                    operation,
                });
            }

            const foldersParsed = parseStrictIdArray(folder_ids, folderIds, "folder_ids", { traceId, operation });
            const workflowsParsed = parseStrictIdArray(workflow_ids, workflowIds, "workflow_ids", {
                stripWorkflowPrefix: true,
                traceId,
                operation,
            });
            const charactersParsed = parseStrictIdArray(character_ids, characterIds, "character_ids", { traceId, operation });
            const elementsParsed = parseStrictIdArray(element_ids, elementIds, "element_ids", { traceId, operation });

            const totalInputCount =
                foldersParsed.rawCount +
                workflowsParsed.rawCount +
                charactersParsed.rawCount +
                elementsParsed.rawCount;

            if (totalInputCount === 0) {
                throw new CrudServiceError(
                    "At least one ID in folder_ids, workflow_ids, character_ids, or element_ids is required",
                    {
                        statusCode: 400,
                        errorCode: "VALIDATION_ERROR",
                        traceId,
                        operation,
                    }
                );
            }

            if (totalInputCount > BULK_DELETE_MAX_ITEMS) {
                throw new CrudServiceError(
                    `Bulk delete cannot exceed ${BULK_DELETE_MAX_ITEMS} total input IDs per request`,
                    {
                        statusCode: 400,
                        errorCode: "VALIDATION_ERROR",
                        traceId,
                        operation,
                    }
                );
            }

            // ── Phase 1: All-or-nothing upfront ownership & existence validation (ZERO mutations) ──

            const allWorkflowIdsSet = new Set();
            const orphanCharacterIdsSet = new Set();
            const orphanElementIdsSet = new Set();
            const projectFolderPlans = [];

            // 1a. Folders: verify ownership, group by project_id, load project folders once, expand subtrees
            if (foldersParsed.uniqueIds.length > 0) {
                if (!this.db.folders?.findOwned || !this.db.folders?.listByProject) {
                    throw new CrudServiceError("Folder repository is unavailable", {
                        statusCode: 500,
                        errorCode: "FOLDER_REPO_UNAVAILABLE",
                        traceId,
                        operation,
                    });
                }

                const foldersByProject = new Map();
                for (const folderId of foldersParsed.uniqueIds) {
                    const folder = await this.db.folders.findOwned(folderId, userId);
                    if (!folder) {
                        throw new CrudServiceError("Folder not found", {
                            statusCode: 404,
                            errorCode: "NOT_FOUND",
                            traceId,
                            operation,
                        });
                    }
                    const projectId = folder.project_id;
                    if (!foldersByProject.has(projectId)) {
                        foldersByProject.set(projectId, []);
                    }
                    foldersByProject.get(projectId).push(folder);
                }

                for (const [projectId, ownedFolders] of foldersByProject.entries()) {
                    const projectFolders = await this.db.folders.listByProject(projectId, userId);
                    const byId = indexById(projectFolders);
                    const children = indexChildren(projectFolders);
                    const uniqueTreeIdsSet = new Set();

                    for (const folder of ownedFolders) {
                        for (const descId of collectDescendantIds(children, folder.id)) {
                            uniqueTreeIdsSet.add(descId);
                        }
                    }

                    const uniqueTreeIds = [...uniqueTreeIdsSet];
                    let ownedFolderWorkflowIds = [];

                    if (this.workflowService?.listOwnedWorkflowIdsInFolders) {
                        ownedFolderWorkflowIds = await this.workflowService.listOwnedWorkflowIdsInFolders({
                            folderIds: uniqueTreeIds,
                            userId,
                            projectId,
                            req,
                        });
                        for (const wfId of ownedFolderWorkflowIds) {
                            allWorkflowIdsSet.add(wfId);
                        }
                    }

                    projectFolderPlans.push({
                        projectId,
                        byId,
                        uniqueTreeIds,
                        workflowIds: ownedFolderWorkflowIds,
                    });
                }
            }

            // 1b. Explicit workflow_ids: verify bulk ownership upfront
            if (workflowsParsed.uniqueIds.length > 0) {
                const ownedWorkflowIds = await this.authService.verifyWorkflowOwnershipBulk(
                    workflowsParsed.uniqueIds,
                    userId,
                    req
                );
                if (!ownedWorkflowIds || ownedWorkflowIds.length !== workflowsParsed.uniqueIds.length) {
                    throw new CrudServiceError("Workflow not found", {
                        statusCode: 404,
                        errorCode: "NOT_FOUND",
                        traceId,
                        operation,
                    });
                }
                for (const wfId of ownedWorkflowIds) {
                    allWorkflowIdsSet.add(wfId);
                }
            }

            // 1c. Explicit character_ids: verify ownership & split workflow-backed vs orphan
            for (const charId of charactersParsed.uniqueIds) {
                await assertOwns("character", charId, userId);
                const charRecord = this.db.characters?.findByCharacterId
                    ? await this.db.characters.findByCharacterId(charId)
                    : (this.db.characters?.findById ? await this.db.characters.findById(charId) : null);

                if (charRecord && charRecord.workflow_id == null) {
                    orphanCharacterIdsSet.add(charRecord.id);
                } else {
                    const targetWfId = cleanWorkflowId(charRecord?.workflow_id || charId);
                    if (targetWfId) {
                        allWorkflowIdsSet.add(targetWfId);
                    }
                }
            }

            // 1d. Explicit element_ids: verify ownership & split workflow-backed vs orphan
            for (const elemId of elementsParsed.uniqueIds) {
                await assertOwns("element", elemId, userId);
                const elemRecord = this.db.elements?.resolveRecord
                    ? await this.db.elements.resolveRecord(elemId)
                    : (this.db.elements?.findById ? await this.db.elements.findById(elemId) : null);

                if (elemRecord && elemRecord.workflow_id == null) {
                    orphanElementIdsSet.add(elemRecord.id);
                } else {
                    const targetWfId = cleanWorkflowId(elemRecord ? elemRecord.workflow_id : elemId);
                    if (targetWfId) {
                        allWorkflowIdsSet.add(targetWfId);
                    }
                }
            }

            // 1e. Inspect media statuses for all targeted workflows upfront (ZERO mutations if any is in-flight)
            const uniqueWorkflowIds = [...allWorkflowIdsSet];
            const mediaStatusMap = await this._getMediaStatusesByWorkflowIds(uniqueWorkflowIds);
            const inFlightWorkflowIds = uniqueWorkflowIds.filter((wfId) =>
                hasInFlightMedia(mediaStatusMap.get(wfId))
            );
            if (inFlightWorkflowIds.length > 0) {
                throw new MediaConflictError("Cannot delete while media is still processing", {
                    context: { workflowIds: inFlightWorkflowIds, operation },
                });
            }

            const failedOnlyWorkflowIds = uniqueWorkflowIds.filter((wfId) =>
                areAllWorkflowMediaFailed(mediaStatusMap.get(wfId))
            );
            const failedOnlySet = new Set(failedOnlyWorkflowIds);
            const trashableWorkflowIds = uniqueWorkflowIds.filter((wfId) => !failedOnlySet.has(wfId));

            // ── Phase 2: Safe mutation sequence ──

            let trashedWorkflowIds = [];
            let alreadyTrashedWorkflowIds = [];

            // 2. Idempotently insert trashable workflow_ids into public.trash (NEVER call requestDelete! Never trash failed-only workflows!)
            if (trashableWorkflowIds.length > 0) {
                let insertedRows = [];
                if (typeof this.db.trash.insertManyIfAbsent === "function") {
                    insertedRows = await this.db.trash.insertManyIfAbsent({
                        workflowIds: trashableWorkflowIds,
                        userId,
                        deletedBy: userId,
                    });
                } else {
                    for (const wfId of trashableWorkflowIds) {
                        const row = await this.db.trash.insertIfAbsent({
                            workflowId: wfId,
                            userId,
                            deletedBy: userId,
                        });
                        if (row) insertedRows.push(row);
                    }
                }

                const newlyTrashedSet = new Set(
                    (insertedRows || []).map((row) => row?.workflow_id).filter(Boolean)
                );
                trashedWorkflowIds = trashableWorkflowIds.filter((id) => newlyTrashedSet.has(id));
                alreadyTrashedWorkflowIds = trashableWorkflowIds.filter((id) => !newlyTrashedSet.has(id));
            }

            // 3. Unlink workflows in deleted folder subtrees (folder_id = NULL) before folder deletion
            for (const plan of projectFolderPlans) {
                if (plan.workflowIds.length > 0) {
                    if (typeof this.workflowService?.unlinkWorkflowsFromFolders !== "function") {
                        throw new CrudServiceError("Workflow unlinking service is unavailable", {
                            statusCode: 500,
                            errorCode: "WORKFLOW_UNLINK_UNAVAILABLE",
                            traceId,
                            operation,
                        });
                    }
                    await this.workflowService.unlinkWorkflowsFromFolders({
                        workflowIds: plan.workflowIds,
                        folderIds: plan.uniqueTreeIds,
                        userId,
                        projectId: plan.projectId,
                        req,
                    });
                }
            }

            // 4. Permanently delete all unique folders per project deepest-first
            const deletedFolderIds = [];
            for (const plan of projectFolderPlans) {
                const deepestFirst = plan.uniqueTreeIds
                    .slice()
                    .sort((a, b) => getDepth(plan.byId, b) - getDepth(plan.byId, a));

                try {
                    for (const id of deepestFirst) {
                        const deleted = await this.db.folders.deleteOwned(id, userId);
                        if (deleted) {
                            deletedFolderIds.push(id);
                        }
                    }
                } catch (err) {
                    if (err?.code === "23503") {
                        throw new CrudServiceError("Cannot delete folder that still has dependent rows", {
                            statusCode: 409,
                            errorCode: "FOLDER_NOT_EMPTY",
                            traceId,
                            operation,
                        });
                    }
                    throw err;
                }
            }

            // 5. Permanently delete failed-only workflows directly (bypassing trash) & orphan characters/elements
            const effectiveConcurrency = clampBulkDeleteConcurrency(
                concurrency === undefined ? envConfig.bulkDeleteConcurrency : concurrency
            );

            const deletedFailedWorkflowIds = [];
            if (failedOnlyWorkflowIds.length > 0) {
                await runWithConcurrency(
                    failedOnlyWorkflowIds,
                    async (wfId) => {
                        await this._permanentlyDeleteByWorkflowOwner({
                            workflowId: wfId,
                            userId,
                            req,
                        });
                        deletedFailedWorkflowIds.push(wfId);
                    },
                    { concurrency: effectiveConcurrency }
                );
            }

            const orphanCharIds = [...orphanCharacterIdsSet];
            const orphanElemIds = [...orphanElementIdsSet];
            const orphanTasks = [
                ...orphanCharIds.map((id) => ({ kind: "character", id })),
                ...orphanElemIds.map((id) => ({ kind: "element", id })),
            ];

            if (orphanTasks.length > 0) {
                await runWithConcurrency(
                    orphanTasks,
                    async (task) => {
                        if (task.kind === "character") {
                            await this.characterService.deleteCharacter({
                                characterId: task.id,
                                userId,
                                req,
                            });
                        } else {
                            await this.elementService.deleteElement(task.id, userId);
                        }
                    },
                    { concurrency: effectiveConcurrency }
                );
            }

            const result = {
                ok: true,
                deleted_folder_ids: deletedFolderIds,
                trashed_workflow_ids: trashedWorkflowIds,
                already_trashed_workflow_ids: alreadyTrashedWorkflowIds,
                deleted_workflow_ids: deletedFailedWorkflowIds,
                deleted_orphan_character_ids: orphanCharIds,
                deleted_orphan_element_ids: orphanElemIds,
            };

            crudOperationLog({
                traceId,
                operation,
                status: "ok",
                durationMs: Date.now() - start,
                deletedFolders: deletedFolderIds.length,
                trashedWorkflows: trashedWorkflowIds.length,
                alreadyTrashedWorkflows: alreadyTrashedWorkflowIds.length,
                deletedFailedWorkflows: deletedFailedWorkflowIds.length,
                deletedOrphanCharacters: orphanCharIds.length,
                deletedOrphanElements: orphanElemIds.length,
            });

            return result;
        } catch (err) {
            crudOperationLog({
                traceId,
                operation,
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || err.statusCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    /**
     * Explicit-intent Trash Permanent Bulk Delete & Empty Trash.
     * Permanently destroys ONLY workflows currently in public.trash for userId,
     * executing cleanup through the configurable bounded-concurrency worker pool.
     */
    async deleteTrashed({
        userId,
        workflow_ids,
        workflowIds,
        folder_ids,
        folderIds,
        all,
        project_id,
        projectId,
        concurrency,
        req = null,
    } = {}) {
        const traceId = randomUUID();
        const start = Date.now();
        const operation = "trash.deleteTrashed";

        try {
            if (!userId) {
                throw new CrudServiceError("Authentication required", {
                    statusCode: 401,
                    errorCode: "UNAUTHORIZED",
                    traceId,
                    operation,
                });
            }

            // Reject non-empty (or invalid) folder_ids/folderIds: folders never live in Trash
            for (const rawFolders of [folder_ids, folderIds]) {
                if (rawFolders === undefined) continue;
                if (!Array.isArray(rawFolders) || rawFolders.length > 0) {
                    throw new CrudServiceError(
                        "Folders do not live in Trash and cannot be permanently deleted via /api/trash/delete",
                        {
                            statusCode: 400,
                            errorCode: "VALIDATION_ERROR",
                            traceId,
                            operation,
                        }
                    );
                }
            }

            if (all !== undefined && typeof all !== "boolean") {
                throw new CrudServiceError("'all' must be a boolean", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation,
                });
            }

            const isAllMode = all === true;
            const hasWorkflowIds = workflow_ids !== undefined || workflowIds !== undefined;

            if (isAllMode && hasWorkflowIds) {
                throw new CrudServiceError("Cannot specify both 'all: true' and 'workflow_ids'", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation,
                });
            }

            if (!isAllMode && !hasWorkflowIds) {
                throw new CrudServiceError("Either 'all: true' or 'workflow_ids' is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation,
                });
            }

            let targetWorkflowIds = [];

            if (isAllMode) {
                const rawProjectId = project_id !== undefined ? project_id : projectId;
                let normalizedProjectId = null;

                if (rawProjectId !== undefined && rawProjectId !== null && rawProjectId !== "") {
                    if (typeof rawProjectId !== "string" || !rawProjectId.trim()) {
                        throw new CrudServiceError("project_id must be a non-empty string", {
                            statusCode: 400,
                            errorCode: "VALIDATION_ERROR",
                            traceId,
                            operation,
                        });
                    }
                    normalizedProjectId = rawProjectId.trim();
                }

                if (normalizedProjectId) {
                    await assertOwns("project", normalizedProjectId, userId);
                    const workflowsResult = await this.db.workflows.findByProject(normalizedProjectId, {
                        partitioned: true,
                    });
                    const trashedWfs = workflowsResult?.trashed || [];
                    const projectTrashedIds = [...new Set(trashedWfs.map((w) => w.id).filter(Boolean))];
                    if (projectTrashedIds.length > 0) {
                        const verifiedUserTrashedIds = await this._findUserTrashedWorkflowIds({
                            userId,
                            workflowIds: projectTrashedIds,
                        });
                        const verifiedSet = new Set(verifiedUserTrashedIds || []);
                        targetWorkflowIds = projectTrashedIds.filter((id) => verifiedSet.has(id));
                    }
                } else {
                    const userTrashedIds = await this._findUserTrashedWorkflowIds({ userId });
                    targetWorkflowIds = [...new Set((userTrashedIds || []).filter(Boolean))];
                }

                if (targetWorkflowIds.length === 0) {
                    crudOperationLog({
                        traceId,
                        operation,
                        status: "ok",
                        durationMs: Date.now() - start,
                        mode: "all",
                        count: 0,
                        projectId: normalizedProjectId || undefined,
                    });
                    return {
                        ok: true,
                        deleted_workflow_ids: [],
                        count: 0,
                        deleted_media_count: 0,
                        storage_failures: [],
                    };
                }
            } else {
                const parsed = parseStrictIdArray(workflow_ids, workflowIds, "workflow_ids", {
                    stripWorkflowPrefix: true,
                    traceId,
                    operation,
                });

                if (parsed.rawCount === 0) {
                    throw new CrudServiceError("workflow_ids must contain at least one workflow ID", {
                        statusCode: 400,
                        errorCode: "VALIDATION_ERROR",
                        traceId,
                        operation,
                    });
                }

                if (parsed.rawCount > BULK_DELETE_MAX_ITEMS) {
                    throw new CrudServiceError(
                        `Cannot permanently delete more than ${BULK_DELETE_MAX_ITEMS} workflows per request`,
                        {
                            statusCode: 400,
                            errorCode: "VALIDATION_ERROR",
                            traceId,
                            operation,
                        }
                    );
                }

                const ownedIds = await this.authService.verifyWorkflowOwnershipBulk(
                    parsed.uniqueIds,
                    userId,
                    req
                );
                if (!ownedIds || ownedIds.length !== parsed.uniqueIds.length) {
                    throw new CrudServiceError("Workflow not found", {
                        statusCode: 404,
                        errorCode: "NOT_FOUND",
                        traceId,
                        operation,
                    });
                }

                const trashedIds = await this._findUserTrashedWorkflowIds({
                    userId,
                    workflowIds: ownedIds,
                });
                const trashedSet = new Set(trashedIds || []);
                const nonTrashedIds = ownedIds.filter((id) => !trashedSet.has(id));
                if (nonTrashedIds.length > 0) {
                    throw new CrudServiceError(
                        "One or more workflows are not in Trash and cannot be permanently deleted",
                        {
                            statusCode: 400,
                            errorCode: "WORKFLOW_NOT_IN_TRASH",
                            traceId,
                            operation,
                        }
                    );
                }

                targetWorkflowIds = ownedIds;
            }

            // Defense-in-depth: reject if any targeted workflow still has in-flight media
            const mediaStatusMap = await this._getMediaStatusesByWorkflowIds(targetWorkflowIds);
            const inFlightWorkflowIds = targetWorkflowIds.filter((wfId) =>
                hasInFlightMedia(mediaStatusMap.get(wfId))
            );
            if (inFlightWorkflowIds.length > 0) {
                throw new MediaConflictError("Cannot delete while media is still processing", {
                    context: { workflowIds: inFlightWorkflowIds, operation },
                });
            }

            const effectiveConcurrency = clampBulkDeleteConcurrency(
                concurrency === undefined ? envConfig.bulkDeleteConcurrency : concurrency
            );

            const perWorkflowResults = await runWithConcurrency(
                targetWorkflowIds,
                (workflowId) => this._permanentlyDeleteByWorkflowOwner({ workflowId, userId, req }),
                { concurrency: effectiveConcurrency }
            );

            const deletedWorkflowIds = [];
            let deletedMediaCount = 0;
            const storageFailures = [];

            for (let i = 0; i < targetWorkflowIds.length; i += 1) {
                const res = perWorkflowResults[i] || {};
                deletedWorkflowIds.push(res.workflowId || targetWorkflowIds[i]);
                deletedMediaCount += Number(res.deletedMediaCount || 0);
                if (Array.isArray(res.storageFailures) && res.storageFailures.length > 0) {
                    storageFailures.push(...res.storageFailures);
                }
            }

            crudOperationLog({
                traceId,
                operation,
                status: "ok",
                durationMs: Date.now() - start,
                mode: isAllMode ? "all" : "selected",
                count: deletedWorkflowIds.length,
                deletedMediaCount,
                storageFailureCount: storageFailures.length,
                concurrency: effectiveConcurrency,
            });

            return {
                ok: true,
                deleted_workflow_ids: deletedWorkflowIds,
                count: deletedWorkflowIds.length,
                deleted_media_count: deletedMediaCount,
                storage_failures: storageFailures,
            };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation,
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || err.statusCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    async requestDelete({ kind = "workflow", id, userId, trash = true, req = null } = {}) {
        const traceId = randomUUID();
        const start = Date.now();
        const shouldMoveToTrash = !(trash === false || String(trash).toLowerCase() === "false");

        try {
            const { workflowId, orphanKind, orphanId } = await this._resolveOwnedWorkflowTarget({
                kind,
                id,
                userId,
                req,
                traceId,
            });

            if (orphanKind === "element") {
                return await this.elementService.deleteElement(orphanId, userId);
            }
            if (orphanKind === "character") {
                return await this.characterService.deleteCharacter({ characterId: orphanId, userId, req });
            }

            const mediaStatusMap = await this._getMediaStatusesByWorkflowIds([workflowId]);
            const workflowMedia = mediaStatusMap.get(workflowId) || [];

            if (hasInFlightMedia(workflowMedia)) {
                throw new MediaConflictError("Cannot delete while media is still processing", {
                    context: { workflowId, kind },
                });
            }

            const isFailedOnlyWorkflow = areAllWorkflowMediaFailed(workflowMedia);

            if (shouldMoveToTrash === true && !isFailedOnlyWorkflow) {
                const inserted = await this.db.trash.insertIfAbsent({
                    workflowId,
                    userId,
                    deletedBy: userId,
                });

                if (inserted) {
                    crudOperationLog({
                        traceId,
                        operation: "requestDelete:trashed",
                        status: "ok",
                        durationMs: Date.now() - start,
                        workflowId,
                        kind,
                    });
                    return buildEmptyDeleteResult(workflowId, { trashed: true });
                }
            }

            const result = await this._permanentlyDeleteByWorkflowOwner({ workflowId, userId, req });
            crudOperationLog({
                traceId,
                operation: isFailedOnlyWorkflow ? "requestDelete:failedDirectPermanent" : "requestDelete:permanent",
                status: "ok",
                durationMs: Date.now() - start,
                workflowId,
                kind,
            });
            return result;
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "requestDelete",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || err.statusCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    async requestDeleteMany({ ids = [], userId, trash = true, req = null } = {}) {
        const traceId = randomUUID();
        const start = Date.now();
        const cleanIds = normalizeWorkflowIds(ids);

        try {
            if (!cleanIds.length) {
                throw new CrudServiceError("workflow_ids is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "requestDeleteMany",
                });
            }

            const ownedIds = await this.authService.verifyWorkflowOwnershipBulk(cleanIds, userId, req);
            if (!ownedIds) {
                throw new CrudServiceError("Workflow not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "requestDeleteMany",
                });
            }

            const mediaStatusMap = await this._getMediaStatusesByWorkflowIds(ownedIds);
            const inFlightWorkflowIds = ownedIds.filter((wfId) =>
                hasInFlightMedia(mediaStatusMap.get(wfId))
            );
            if (inFlightWorkflowIds.length > 0) {
                throw new MediaConflictError("Cannot delete while media is still processing", {
                    context: { workflowIds: inFlightWorkflowIds, operation: "requestDeleteMany" },
                });
            }

            const settled = await Promise.allSettled(
                ownedIds.map((id) => this.requestDelete({ kind: "workflow", id, userId, trash, req }))
            );

            const successfulIds = settled
                .filter((r) => r.status === "fulfilled")
                .map((r) => r.value.workflowId);

            const anyTrashed = settled.some((r) => r.status === "fulfilled" && r.value?.trashed === true);

            const response = {
                workflow_ids: successfulIds,
                count: successfulIds.length,
                results: settled.map((r, i) => ({
                    id: ownedIds[i],
                    status: r.status,
                    ...(r.status === "fulfilled" ? r.value : { error: r.reason?.message }),
                })),
            };

            if (anyTrashed) {
                response.trashed = true;
            }

            crudOperationLog({
                traceId,
                operation: "requestDeleteMany",
                status: "ok",
                durationMs: Date.now() - start,
                count: successfulIds.length,
            });

            return response;
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "requestDeleteMany",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || err.statusCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    async restore({ workflowId, userId } = {}) {
        const cleanId = cleanWorkflowId(workflowId);
        if (!cleanId) {
            throw new CrudServiceError("workflowId is required", {
                statusCode: 400,
                errorCode: "VALIDATION_ERROR",
                operation: "trash.restore",
            });
        }
        if (!userId) {
            throw new CrudServiceError("Authentication required", {
                statusCode: 401,
                errorCode: "UNAUTHORIZED",
                operation: "trash.restore",
            });
        }

        const deleted = await this.db.trash.deleteByWorkflowAndUser({
            workflowId: cleanId,
            userId,
        });

        if (!deleted) {
            throw new CrudServiceError("Workflow not found in trash", {
                statusCode: 404,
                errorCode: "NOT_FOUND",
                operation: "trash.restore",
            });
        }

        return {
            workflow_id: cleanId,
            restored: true,
        };
    }

    async restoreAll({ userId, projectId = null, workflowIds = null } = {}) {
        const start = Date.now();
        const traceId = randomUUID();

        if (!userId) {
            throw new CrudServiceError("Authentication required", {
                statusCode: 401,
                errorCode: "UNAUTHORIZED",
                traceId,
                operation: "trash.restoreAll",
            });
        }

        let targetIds = null;

        if (projectId) {
            await assertOwns("project", projectId, userId);
            const workflowsResult = await this.db.workflows.findByProject(projectId, {
                partitioned: true,
            });
            const trashedWfs = workflowsResult?.trashed || [];
            targetIds = trashedWfs.map((w) => w.id).filter(Boolean);

            if (Array.isArray(workflowIds) && workflowIds.length > 0) {
                const passedIds = normalizeWorkflowIds(workflowIds);
                targetIds = targetIds.filter((id) => passedIds.includes(id));
            }

            if (targetIds.length === 0) {
                return {
                    restored: true,
                    count: 0,
                    workflow_ids: [],
                };
            }
        } else if (Array.isArray(workflowIds)) {
            targetIds = normalizeWorkflowIds(workflowIds);
            if (targetIds.length === 0) {
                return {
                    restored: true,
                    count: 0,
                    workflow_ids: [],
                };
            }
        }

        const restoredIds = await this.db.trash.deleteManyByUser({
            userId,
            workflowIds: targetIds,
        });

        crudOperationLog({
            traceId,
            operation: "trash.restoreAll",
            status: "ok",
            durationMs: Date.now() - start,
            count: restoredIds.length,
            projectId: projectId || undefined,
        });

        return {
            restored: true,
            count: restoredIds.length,
            workflow_ids: restoredIds,
        };
    }
}
