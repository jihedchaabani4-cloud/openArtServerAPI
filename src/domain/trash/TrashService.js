/**
 * TrashService
 * @owns Workflow trash lifecycle (move to trash, permanent delete dispatch, list, and restore)
 *
 * Public methods:
 *   - requestDelete({ kind, id, userId, req })
 *   - requestDeleteMany({ ids, userId, req })
 *   - list({ userId })
 *   - restore({ workflowId, userId })
 */

import { randomUUID } from "node:crypto";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { assertOwns } from "../../platform/security/ownership.js";

function cleanWorkflowId(rawId) {
    return String(rawId || "").replace(/^workflows\//, "").trim();
}

function normalizeWorkflowIds(ids = []) {
    return [...new Set((ids || []).map(cleanWorkflowId).filter(Boolean))];
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

    async _permanentlyDeleteByWorkflowOwner({ workflowId, userId, req }) {
        const elementRecord = await this.db.elements.findByWorkflowId(workflowId);
        if (elementRecord) {
            return this.elementService.deleteElement(elementRecord.id, userId);
        }

        const characterRecord = await this.db.characters.findByCharacterId(workflowId);
        if (characterRecord) {
            return this.characterService.deleteCharacter({ characterId: workflowId, userId, req });
        }

        return this.workflowService.deleteWorkflow({ workflowId, userId, req });
    }

    async requestDelete({ kind = "workflow", id, userId, req = null } = {}) {
        const traceId = randomUUID();
        const start = Date.now();

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

            const result = await this._permanentlyDeleteByWorkflowOwner({ workflowId, userId, req });
            crudOperationLog({
                traceId,
                operation: "requestDelete:permanent",
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

    async requestDeleteMany({ ids = [], userId, req = null } = {}) {
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

            const settled = await Promise.allSettled(
                ownedIds.map((id) => this.requestDelete({ kind: "workflow", id, userId, req }))
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

    async list({ userId } = {}) {
        if (!userId) {
            throw new CrudServiceError("Authentication required", {
                statusCode: 401,
                errorCode: "UNAUTHORIZED",
                operation: "trash.list",
            });
        }
        return this.db.trash.listByUser(userId);
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
}
