import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TrashRepository, TrashService, FolderRepository, FolderService, ProjectReadService, configureWorkspace } from "#workspace/tools";
import { MediaConflictError } from "#media/tools";
import { setDb, assertOwns, resetLimitersForTest } from "#identity/tools";
import { supabase, supabaseAdmin } from "#shared/db/supabase.js";
import { WorkflowRepository, WorkflowService } from "#generation/tools";
import { WorkflowAuthorizationService } from "../../../src/systems/generation/internal/services/WorkflowAuthorizationService.js";
import { ElementRepository } from "#elements/tools";
import { CharacterRepository } from "#characters/tools";
import express from "express";
import http from "node:http";
import apiRouter from "../../../src/api/routes.js";
import { db, workflowService, trashService as containerTrashService } from "../../../src/container.js";
import { rateLimitRedisConnection, redisConnection, workerRedisConnection } from "#shared";
import { workflowsRouter } from "#generation/api";
import elementRoutes from "#elements/api";
import charactersRouter from "#characters/api";

// ─── Source: trashMigrationAndService.test.js ───
{
describe("T1: TrashRepository and TrashService", () => {
    it("TrashRepository scopes all operations by workflow_id/user_id and does not expose unscoped findById or deleteById", async () => {
        const repo = new TrashRepository();
        assert.equal(repo.findById, undefined, "TrashRepository must not expose unscoped findById");
        assert.equal(repo.deleteById, undefined, "TrashRepository must not expose unscoped deleteById");
        assert.equal(repo.delete, undefined, "TrashRepository must not expose unscoped delete");

        const calls = [];
        let simulatedUpsertRows = [
            {
                id: "trash-row-1",
                workflow_id: "wf-1",
                user_id: "user-1",
                deleted_at: "2026-10-25T18:00:00.000Z",
                deleted_by: "user-1",
            },
        ];
        let simulatedListRows = [
            {
                workflow_id: "wf-1",
                deleted_at: "2026-10-25T18:00:00.000Z",
                workflow: { display_name: "Sunset", workflow_type: "GENERATION" },
            },
        ];
        let simulatedDeleteRows = [{ id: "trash-row-1" }];

        repo.client = () => ({
            from: (table) => {
                calls.push({ op: "from", table });
                return {
                    upsert: (payload, opts) => {
                        calls.push({ op: "upsert", payload, opts });
                        return {
                            select: async () => ({ data: simulatedUpsertRows, error: null }),
                        };
                    },
                    select: (cols) => {
                        calls.push({ op: "select", cols });
                        const chain = {
                            eq: (col, val) => {
                                calls.push({ op: "eq", col, val });
                                return chain;
                            },
                            in: (col, vals) => {
                                calls.push({ op: "in", col, vals });
                                return chain;
                            },
                            order: async (col, opts) => {
                                calls.push({ op: "order", col, opts });
                                return { data: simulatedListRows, error: null };
                            },
                            then: (resolve) => resolve({
                                data: simulatedListRows.map((r) => ({
                                    workflow_id: r.workflow_id,
                                    deleted_at: r.deleted_at,
                                    deleted_by: "user-1",
                                })),
                                error: null,
                            }),
                        };
                        return chain;
                    },
                    delete: () => {
                        calls.push({ op: "delete" });
                        const delChain = {
                            eq: (col, val) => {
                                calls.push({ op: "eq", col, val });
                                return delChain;
                            },
                            select: async (cols) => {
                                calls.push({ op: "deleteSelect", cols });
                                return { data: simulatedDeleteRows, error: null };
                            },
                        };
                        return delChain;
                    },
                };
            },
        });

        const inserted = await repo.insertIfAbsent({ workflowId: "wf-1", userId: "user-1" });
        assert.equal(inserted?.workflow_id, "wf-1");
        assert.deepEqual(calls[1], {
            op: "upsert",
            payload: { workflow_id: "wf-1", user_id: "user-1", deleted_by: "user-1" },
            opts: { onConflict: "workflow_id", ignoreDuplicates: true },
        });

        // Conflict returns empty array -> insertIfAbsent returns null
        simulatedUpsertRows = [];
        const conflict = await repo.insertIfAbsent({ workflowId: "wf-1", userId: "user-1" });
        assert.equal(conflict, null);

        // getTrashedDetailsMap returns candidate workflow details
        const detailsMap = await repo.getTrashedDetailsMap({ workflowIds: ["wf-1", "wf-2"] });
        assert.equal(detailsMap.size, 1);
        assert.deepEqual(detailsMap.get("wf-1"), {
            workflow_id: "wf-1",
            deleted_at: "2026-10-25T18:00:00.000Z",
            deleted_by: "user-1",
        });

        // deleteByWorkflowAndUser returns true when row deleted, false when 0 rows deleted
        const delOk = await repo.deleteByWorkflowAndUser({ workflowId: "wf-1", userId: "user-1" });
        assert.equal(delOk, true);
        simulatedDeleteRows = [];
        const delMissing = await repo.deleteByWorkflowAndUser({ workflowId: "wf-1", userId: "user-1" });
        assert.equal(delMissing, false);

        // listWorkflowIds returns array of workflow_id strings
        const ids = await repo.listWorkflowIds({ workflowIds: ["wf-1", "wf-2"], userId: "user-1" });
        assert.deepEqual(ids, ["wf-1"]);
    });

    it("TrashService constructor throws when any required dependency is missing", () => {
        const fakeDb = { trash: {} };
        const fakeWf = { authService: {} };
        const fakeEl = {};
        const fakeCh = {};

        assert.throws(
            () => new TrashService({ workflowService: fakeWf, elementService: fakeEl, characterService: fakeCh }),
            /TrashService requires db\.trash/
        );
        assert.throws(
            () => new TrashService({ db: {}, workflowService: fakeWf, elementService: fakeEl, characterService: fakeCh }),
            /TrashService requires db\.trash/
        );
        assert.throws(
            () => new TrashService({ db: fakeDb, elementService: fakeEl, characterService: fakeCh }),
            /TrashService requires workflowService/
        );
        assert.throws(
            () => new TrashService({ db: fakeDb, workflowService: fakeWf, characterService: fakeCh }),
            /TrashService requires elementService/
        );
        assert.throws(
            () => new TrashService({ db: fakeDb, workflowService: fakeWf, elementService: fakeEl }),
            /TrashService requires characterService/
        );
    });

    it("TrashService.requestDelete enforces ownership (404 on cross-tenant), moves to trash on 1st call, and dispatches to canonical owner on 2nd call", async () => {
        const trashRows = new Map();
        const permanentCalls = [];

        const mockWorkflows = new Map([
            ["wf-gen-1", { id: "wf-gen-1", project_id: "proj-u1", user_id: "user-1", workflow_type: "GENERATION" }],
            ["wf-elem-1", { id: "wf-elem-1", project_id: "proj-u1", user_id: "user-1", workflow_type: "ELEMENT_SHEET" }],
            ["wf-char-1", { id: "wf-char-1", project_id: "proj-u1", user_id: "user-1", workflow_type: "CHARACTER" }],
        ]);
        const mockElements = new Map([
            ["elem-1", { id: "elem-1", workflow_id: "wf-elem-1", name: "Ancient Relic" }],
            ["elem-orphan", { id: "elem-orphan", workflow_id: null, user_id: "user-1", name: "Orphan Relic" }],
        ]);
        const mockCharacters = new Map([
            ["wf-char-1", { id: "wf-char-1", workflow_id: "wf-char-1", user_id: "user-1", project_id: "proj-u1", name: "Aria" }],
            ["char-orphan", { id: "char-orphan", workflow_id: null, user_id: "user-1", project_id: "proj-u1", name: "Orphan Hero" }],
        ]);

        const fakeDb = {
            trash: {
                insertIfAbsent: async ({ workflowId, userId, deletedBy = userId }) => {
                    if (trashRows.has(workflowId)) return null;
                    const row = {
                        id: `trash-${workflowId}`,
                        workflow_id: workflowId,
                        user_id: userId,
                        deleted_at: new Date().toISOString(),
                        deleted_by: deletedBy,
                    };
                    trashRows.set(workflowId, row);
                    return row;
                },
                listByUser: async (userId) =>
                    [...trashRows.values()].filter((r) => r.user_id === userId),
                deleteByWorkflowAndUser: async ({ workflowId, userId }) => {
                    const row = trashRows.get(workflowId);
                    if (!row || row.user_id !== userId) return false;
                    trashRows.delete(workflowId);
                    return true;
                },
            },
            workflows: {
                findById: async (id) => mockWorkflows.get(id) || null,
                getWorkflow: async (id) => mockWorkflows.get(id) || null,
            },
            elements: {
                resolveRecord: async (id) =>
                    mockElements.get(id) ||
                    [...mockElements.values()].find((e) => e.workflow_id === id) ||
                    null,
                findById: async (id) => mockElements.get(id) || null,
                findByWorkflowId: async (wfId) =>
                    [...mockElements.values()].find((e) => e.workflow_id === wfId) || null,
            },
            characters: {
                findByCharacterId: async (id) =>
                    mockCharacters.get(id) ||
                    [...mockCharacters.values()].find((c) => c.workflow_id === id) ||
                    null,
                findById: async (id) => mockCharacters.get(id) || null,
            },
            projects: {
                findByUser: async (uid, pid) => (uid === "user-1" && pid === "proj-u1" ? [{ id: "proj-u1", user_id: "user-1" }] : []),
            },
        };

        let shouldFailPermanentDelete = false;
        const trashService = new TrashService({
            db: fakeDb,
            workflowService: {
                authService: {
                    verifyWorkflowOwnership: async (wfId, uid) => {
                        const wf = mockWorkflows.get(wfId);
                        return Boolean(wf && wf.user_id === uid);
                    },
                    verifyWorkflowOwnershipBulk: async (wfIds, uid) => {
                        const owned = wfIds.filter((id) => mockWorkflows.get(id)?.user_id === uid);
                        return owned.length === wfIds.length ? owned : null;
                    },
                },
                deleteWorkflow: async ({ workflowId, userId }) => {
                    if (shouldFailPermanentDelete) {
                        throw new Error("Simulated permanent workflow delete failure");
                    }
                    permanentCalls.push({ service: "workflow", workflowId, userId });
                    trashRows.delete(workflowId); // Simulates PostgreSQL ON DELETE CASCADE
                    return {
                        workflowId,
                        unlinkedMediaCount: 1,
                        deletedOrphanCount: 1,
                        deletedMediaCount: 1,
                        storageFailures: [],
                    };
                },
            },
            elementService: {
                deleteElement: async (id, userId) => {
                    const elem = mockElements.get(id);
                    permanentCalls.push({ service: "element", id, userId });
                    if (elem?.workflow_id) trashRows.delete(elem.workflow_id);
                    return {
                        workflowId: elem?.workflow_id || id,
                        unlinkedMediaCount: elem?.workflow_id ? 2 : 0,
                        deletedOrphanCount: elem?.workflow_id ? 2 : 0,
                        deletedMediaCount: elem?.workflow_id ? 2 : 0,
                        storageFailures: [],
                    };
                },
            },
            characterService: {
                deleteCharacter: async ({ characterId, userId }) => {
                    const char = mockCharacters.get(characterId);
                    permanentCalls.push({ service: "character", characterId, userId });
                    if (char?.workflow_id) trashRows.delete(char.workflow_id);
                    return {
                        workflowId: char?.workflow_id || characterId,
                        unlinkedMediaCount: char?.workflow_id ? 3 : 0,
                        deletedOrphanCount: char?.workflow_id ? 3 : 0,
                        deletedMediaCount: char?.workflow_id ? 3 : 0,
                        storageFailures: [],
                    };
                },
            },
        });

        setDb(fakeDb);
        try {
            // 0. Unauthenticated element or character delete -> 401 before any trash insert
            await assert.rejects(
                () => trashService.requestDelete({ kind: "element", id: "elem-1", userId: null }),
                (err) => err.statusCode === 401
            );
            await assert.rejects(
                () => trashService.requestDelete({ kind: "character", id: "wf-char-1", userId: null }),
                (err) => err.statusCode === 401
            );

            // 1. Cross-tenant workflow, element, and character -> 404 before any trash insert
        await assert.rejects(
            () => trashService.requestDelete({ kind: "workflow", id: "wf-gen-1", userId: "attacker" }),
            (err) => err.statusCode === 404
        );
        await assert.rejects(
            () => trashService.requestDelete({ kind: "element", id: "elem-1", userId: "attacker" }),
            (err) => err.statusCode === 404
        );
        await assert.rejects(
            () => trashService.requestDelete({ kind: "character", id: "wf-char-1", userId: "attacker" }),
            (err) => err.statusCode === 404
        );
        assert.equal(trashRows.size, 0, "Cross-tenant requests must never insert into trash");

        // 2. First delete on workflow -> inserts into trash, 0 permanent deletes, returns trashed: true
        const wfFirst = await trashService.requestDelete({ kind: "workflow", id: "workflows/wf-gen-1", userId: "user-1" });
        assert.deepEqual(wfFirst, {
            workflowId: "wf-gen-1",
            unlinkedMediaCount: 0,
            deletedOrphanCount: 0,
            deletedMediaCount: 0,
            storageFailures: [],
            trashed: true,
        });
        assert.equal(trashRows.has("wf-gen-1"), true);
        assert.equal(permanentCalls.length, 0);

        // 3. Second delete on workflow when permanent delete fails -> trash row stays intact
        shouldFailPermanentDelete = true;
        await assert.rejects(
            () => trashService.requestDelete({ kind: "workflow", id: "wf-gen-1", userId: "user-1" }),
            /Simulated permanent workflow delete failure/
        );
        assert.equal(trashRows.has("wf-gen-1"), true, "Trash row must remain intact if permanent delete throws");
        shouldFailPermanentDelete = false;

        // 4. Second delete on workflow -> permanent delete via workflowService.deleteWorkflow, no trashed key
        const wfSecond = await trashService.requestDelete({ kind: "workflow", id: "wf-gen-1", userId: "user-1" });
        assert.deepEqual(wfSecond, {
            workflowId: "wf-gen-1",
            unlinkedMediaCount: 1,
            deletedOrphanCount: 1,
            deletedMediaCount: 1,
            storageFailures: [],
        });
        assert.equal("trashed" in wfSecond, false);
        assert.equal(trashRows.has("wf-gen-1"), false);
        assert.deepEqual(permanentCalls[0], { service: "workflow", workflowId: "wf-gen-1", userId: "user-1" });

        // 5. Element 1st delete -> moves container workflow wf-elem-1 to trash; 2nd delete via workflow endpoint still dispatches to elementService.deleteElement!
        const elemFirst = await trashService.requestDelete({ kind: "element", id: "elem-1", userId: "user-1" });
        assert.equal(elemFirst.trashed, true);
        assert.equal(elemFirst.workflowId, "wf-elem-1");
        assert.equal(trashRows.has("wf-elem-1"), true);

        const elemSecondViaWf = await trashService.requestDelete({ kind: "workflow", id: "wf-elem-1", userId: "user-1" });
        assert.equal("trashed" in elemSecondViaWf, false);
        assert.equal(elemSecondViaWf.deletedMediaCount, 2);
        assert.deepEqual(permanentCalls[1], { service: "element", id: "elem-1", userId: "user-1" });

        // 6. Character 1st delete -> moves wf-char-1 to trash; 2nd delete dispatches to characterService.deleteCharacter
        const charFirst = await trashService.requestDelete({ kind: "character", id: "wf-char-1", userId: "user-1" });
        assert.equal(charFirst.trashed, true);
        assert.equal(charFirst.workflowId, "wf-char-1");

        const charSecond = await trashService.requestDelete({ kind: "character", id: "wf-char-1", userId: "user-1" });
        assert.equal("trashed" in charSecond, false);
        assert.equal(charSecond.deletedMediaCount, 3);
        assert.deepEqual(permanentCalls[2], { service: "character", characterId: "wf-char-1", userId: "user-1" });

        // 7. Orphan element (workflow_id = null) and orphan character (workflow_id = null) -> permanent delete immediately without touching trash
        const orphanElemRes = await trashService.requestDelete({ kind: "element", id: "elem-orphan", userId: "user-1" });
        assert.deepEqual(orphanElemRes, {
            workflowId: "elem-orphan",
            unlinkedMediaCount: 0,
            deletedOrphanCount: 0,
            deletedMediaCount: 0,
            storageFailures: [],
        });
        assert.equal("trashed" in orphanElemRes, false);
        assert.equal(trashRows.size, 0);

        const orphanCharRes = await trashService.requestDelete({ kind: "character", id: "char-orphan", userId: "user-1" });
        assert.deepEqual(orphanCharRes, {
            workflowId: "char-orphan",
            unlinkedMediaCount: 0,
            deletedOrphanCount: 0,
            deletedMediaCount: 0,
            storageFailures: [],
        });
        assert.equal("trashed" in orphanCharRes, false);
        assert.equal(trashRows.size, 0);
        } finally {
            setDb(db);
        }
    });

    it("TrashService.requestDeleteMany verifies bulk ownership upfront and handles mixed trash/permanent batches", async () => {
        const trashSet = new Set(["wf-already-trashed"]);
        const mockWorkflows = new Map([
            ["wf-fresh", { id: "wf-fresh", user_id: "user-1" }],
            ["wf-already-trashed", { id: "wf-already-trashed", user_id: "user-1" }],
        ]);

        const trashService = new TrashService({
            db: {
                trash: {
                    insertIfAbsent: async ({ workflowId, userId }) => {
                        if (trashSet.has(workflowId)) return null;
                        trashSet.add(workflowId);
                        return { id: `t-${workflowId}`, workflow_id: workflowId, user_id: userId };
                    },
                },
                elements: { findByWorkflowId: async () => null },
                characters: { findByCharacterId: async () => null },
            },
            workflowService: {
                authService: {
                    verifyWorkflowOwnership: async (id, uid) => mockWorkflows.get(id)?.user_id === uid,
                    verifyWorkflowOwnershipBulk: async (ids, uid) => {
                        const owned = ids.filter((id) => mockWorkflows.get(id)?.user_id === uid);
                        return owned.length === ids.length ? owned : null;
                    },
                },
                deleteWorkflow: async ({ workflowId }) => {
                    trashSet.delete(workflowId);
                    return {
                        workflowId,
                        unlinkedMediaCount: 1,
                        deletedOrphanCount: 1,
                        deletedMediaCount: 1,
                        storageFailures: [],
                    };
                },
            },
            elementService: { deleteElement: async () => ({}) },
            characterService: { deleteCharacter: async () => ({}) },
        });

        // Empty ids -> 400
        await assert.rejects(
            () => trashService.requestDeleteMany({ ids: [], userId: "user-1" }),
            (err) => err.statusCode === 400
        );

        // One unowned id in batch -> 404 upfront before touching anything
        await assert.rejects(
            () => trashService.requestDeleteMany({ ids: ["wf-fresh", "wf-foreign"], userId: "user-1" }),
            (err) => err.statusCode === 404
        );
        assert.equal(trashSet.has("wf-fresh"), false, "All-or-nothing ownership failure must not trash any item");

        // Mixed batch: wf-fresh is moved to trash, wf-already-trashed is permanently deleted
        const batchRes = await trashService.requestDeleteMany({
            ids: ["workflows/wf-fresh", "wf-already-trashed"],
            userId: "user-1",
        });
        assert.deepEqual(batchRes.workflow_ids, ["wf-fresh", "wf-already-trashed"]);
        assert.equal(batchRes.count, 2);
        assert.equal(batchRes.trashed, true);
        assert.equal(batchRes.results[0].trashed, true);
        assert.equal("trashed" in batchRes.results[1], false);
    });

    it("TrashService.list and TrashService.restore enforce tenant isolation and return 404 when workflow is not in user's trash", async () => {
        const trashRows = new Map([
            [
                "wf-u1-1",
                {
                    workflow_id: "wf-u1-1",
                    user_id: "user-1",
                    display_name: "First",
                    workflow_type: "UPLOAD",
                    deleted_at: "2026-10-25T18:10:00.000Z",
                },
            ],
        ]);
        let workflowDeleteCalled = false;

        const trashService = new TrashService({
            db: {
                trash: {
                    listByUser: async (userId) =>
                        [...trashRows.values()]
                            .filter((r) => r.user_id === userId)
                            .map(({ workflow_id, display_name, workflow_type, deleted_at }) => ({
                                workflow_id,
                                display_name,
                                workflow_type,
                                deleted_at,
                            })),
                    deleteByWorkflowAndUser: async ({ workflowId, userId }) => {
                        const row = trashRows.get(workflowId);
                        if (!row || row.user_id !== userId) return false;
                        trashRows.delete(workflowId);
                        return true;
                    },
                },
            },
            workflowService: {
                authService: {},
                deleteWorkflow: async () => {
                    workflowDeleteCalled = true;
                },
            },
            elementService: {},
            characterService: {},
        });

        // Cross-tenant restore -> 404 and leaves user-1's trash row untouched
        await assert.rejects(
            () => trashService.restore({ workflowId: "wf-u1-1", userId: "user-2" }),
            (err) => err.statusCode === 404 && err.errorCode === "NOT_FOUND"
        );
        assert.equal(trashRows.has("wf-u1-1"), true);

        // Owner restore -> deletes only trash row, returns { workflow_id, restored: true }
        const restored = await trashService.restore({ workflowId: "workflows/wf-u1-1", userId: "user-1" });
        assert.deepEqual(restored, { workflow_id: "wf-u1-1", restored: true });
        assert.equal(trashRows.has("wf-u1-1"), false);
        assert.equal(workflowDeleteCalled, false);

        // Second restore (already restored / not in trash) -> 404
        await assert.rejects(
            () => trashService.restore({ workflowId: "wf-u1-1", userId: "user-1" }),
            (err) => err.statusCode === 404 && err.errorCode === "NOT_FOUND"
        );
    });

    it("TrashService.restoreAll restores all trashed workflows scoped by user and project", async () => {
        const trashRows = new Map([
            ["wf-1", { workflow_id: "wf-1", user_id: "user-1" }],
            ["wf-2", { workflow_id: "wf-2", user_id: "user-1" }],
            ["wf-foreign", { workflow_id: "wf-foreign", user_id: "user-2" }],
        ]);

        const trashService = new TrashService({
            db: {
                trash: {
                    deleteManyByUser: async ({ userId, workflowIds }) => {
                        const restored = [];
                        for (const [id, row] of trashRows.entries()) {
                            if (row.user_id === userId) {
                                if (!workflowIds || workflowIds.includes(id)) {
                                    restored.push(id);
                                    trashRows.delete(id);
                                }
                            }
                        }
                        return restored;
                    },
                },
                workflows: {
                    findByProject: async (projectId, { partitioned } = {}) => {
                        if (projectId === "proj-1") {
                            return {
                                active: [],
                                trashed: [{ id: "wf-1" }, { id: "wf-2" }],
                            };
                        }
                        return { active: [], trashed: [] };
                    },
                },
            },
            workflowService: {
                authService: {},
            },
            elementService: {},
            characterService: {},
        });

        // 1. Unauthenticated -> 401
        await assert.rejects(
            () => trashService.restoreAll({}),
            (err) => err.statusCode === 401 && err.errorCode === "UNAUTHORIZED"
        );

        // 2. Restore all workflows for user-1
        const result = await trashService.restoreAll({ userId: "user-1" });
        assert.equal(result.restored, true);
        assert.equal(result.count, 2);
        assert.deepEqual(result.workflow_ids.sort(), ["wf-1", "wf-2"]);

        // user-2 foreign trash row remains untouched
        assert.equal(trashRows.has("wf-foreign"), true);
        assert.equal(trashRows.has("wf-1"), false);
        assert.equal(trashRows.has("wf-2"), false);

        // 3. Called when trash is empty -> returns count 0
        const emptyResult = await trashService.restoreAll({ userId: "user-1" });
        assert.equal(emptyResult.restored, true);
        assert.equal(emptyResult.count, 0);
        assert.deepEqual(emptyResult.workflow_ids, []);
    });

    it("TrashService.requestDelete and requestDeleteMany default trash=true on 1st delete, permanently delete directly on 1st delete when trash=false, keep data in trash when trash is unknown, and return 404 on cross-tenant trash=false", async () => {
        const trashRows = new Map();
        const insertTrashCalls = [];
        const permanentCalls = [];

        const mockWorkflows = new Map([
            ["wf-default", { id: "wf-default", project_id: "proj-u1", user_id: "user-1", workflow_type: "GENERATION" }],
            ["wf-unknown-param", { id: "wf-unknown-param", project_id: "proj-u1", user_id: "user-1", workflow_type: "GENERATION" }],
            ["wf-direct-del", { id: "wf-direct-del", project_id: "proj-u1", user_id: "user-1", workflow_type: "GENERATION" }],
            ["wf-elem-direct", { id: "wf-elem-direct", project_id: "proj-u1", user_id: "user-1", workflow_type: "ELEMENT_SHEET" }],
            ["wf-char-direct", { id: "wf-char-direct", project_id: "proj-u1", user_id: "user-1", workflow_type: "CHARACTER" }],
            ["wf-batch-1", { id: "wf-batch-1", project_id: "proj-u1", user_id: "user-1", workflow_type: "GENERATION" }],
            ["wf-batch-2", { id: "wf-batch-2", project_id: "proj-u1", user_id: "user-1", workflow_type: "GENERATION" }],
        ]);
        const mockElements = new Map([
            ["elem-direct", { id: "elem-direct", workflow_id: "wf-elem-direct", name: "Direct Relic" }],
        ]);
        const mockCharacters = new Map([
            ["wf-char-direct", { id: "wf-char-direct", workflow_id: "wf-char-direct", user_id: "user-1", project_id: "proj-u1", name: "Direct Hero" }],
        ]);

        const fakeDb = {
            trash: {
                insertIfAbsent: async ({ workflowId, userId, deletedBy = userId }) => {
                    insertTrashCalls.push(workflowId);
                    if (trashRows.has(workflowId)) return null;
                    const row = {
                        id: `trash-${workflowId}`,
                        workflow_id: workflowId,
                        user_id: userId,
                        deleted_at: new Date().toISOString(),
                        deleted_by: deletedBy,
                    };
                    trashRows.set(workflowId, row);
                    return row;
                },
            },
            workflows: {
                findById: async (id) => mockWorkflows.get(id) || null,
                getWorkflow: async (id) => mockWorkflows.get(id) || null,
            },
            elements: {
                resolveRecord: async (id) =>
                    mockElements.get(id) ||
                    [...mockElements.values()].find((e) => e.workflow_id === id) ||
                    null,
                findById: async (id) => mockElements.get(id) || null,
                findByWorkflowId: async (wfId) =>
                    [...mockElements.values()].find((e) => e.workflow_id === wfId) || null,
            },
            characters: {
                findByCharacterId: async (id) =>
                    mockCharacters.get(id) ||
                    [...mockCharacters.values()].find((c) => c.workflow_id === id) ||
                    null,
                findById: async (id) => mockCharacters.get(id) || null,
            },
            projects: {
                findByUser: async (uid, pid) => (uid === "user-1" && pid === "proj-u1" ? [{ id: "proj-u1", user_id: "user-1" }] : []),
            },
        };

        const trashService = new TrashService({
            db: fakeDb,
            workflowService: {
                authService: {
                    verifyWorkflowOwnership: async (wfId, uid) => mockWorkflows.get(wfId)?.user_id === uid,
                    verifyWorkflowOwnershipBulk: async (wfIds, uid) => {
                        const owned = wfIds.filter((id) => mockWorkflows.get(id)?.user_id === uid);
                        return owned.length === wfIds.length ? owned : null;
                    },
                },
                deleteWorkflow: async ({ workflowId, userId }) => {
                    permanentCalls.push({ service: "workflow", workflowId, userId });
                    trashRows.delete(workflowId);
                    return {
                        workflowId,
                        unlinkedMediaCount: 1,
                        deletedOrphanCount: 1,
                        deletedMediaCount: 1,
                        storageFailures: [],
                    };
                },
            },
            elementService: {
                deleteElement: async (id, userId) => {
                    const elem = mockElements.get(id);
                    permanentCalls.push({ service: "element", id, userId });
                    if (elem?.workflow_id) trashRows.delete(elem.workflow_id);
                    return {
                        workflowId: elem?.workflow_id || id,
                        unlinkedMediaCount: 2,
                        deletedOrphanCount: 2,
                        deletedMediaCount: 2,
                        storageFailures: [],
                    };
                },
            },
            characterService: {
                deleteCharacter: async ({ characterId, userId }) => {
                    const char = mockCharacters.get(characterId);
                    permanentCalls.push({ service: "character", characterId, userId });
                    if (char?.workflow_id) trashRows.delete(char.workflow_id);
                    return {
                        workflowId: char?.workflow_id || characterId,
                        unlinkedMediaCount: 3,
                        deletedOrphanCount: 3,
                        deletedMediaCount: 3,
                        storageFailures: [],
                    };
                },
            },
        });

        setDb(fakeDb);
        try {
            // 1. Cross-tenant with trash: false -> 404 before any delete or trash write
            await assert.rejects(
                () => trashService.requestDelete({ kind: "workflow", id: "wf-direct-del", userId: "attacker", trash: false }),
                (err) => err.statusCode === 404
            );
            assert.equal(permanentCalls.length, 0);
            assert.equal(insertTrashCalls.length, 0);

            // 2. Omitted trash (default true) and unknown trash value -> move to trash (keep data)
            const defaultRes = await trashService.requestDelete({ kind: "workflow", id: "wf-default", userId: "user-1" });
            assert.equal(defaultRes.trashed, true);
            assert.equal(trashRows.has("wf-default"), true);

            const unknownRes = await trashService.requestDelete({ kind: "workflow", id: "wf-unknown-param", userId: "user-1", trash: "unexpected" });
            assert.equal(unknownRes.trashed, true);
            assert.equal(trashRows.has("wf-unknown-param"), true);
            assert.equal(permanentCalls.length, 0);

            // 3. Explicit trash: false on 1st delete -> skips insertIfAbsent and permanently deletes directly
            insertTrashCalls.length = 0;
            const directWfRes = await trashService.requestDelete({ kind: "workflow", id: "wf-direct-del", userId: "user-1", trash: false });
            assert.equal("trashed" in directWfRes, false);
            assert.equal(directWfRes.deletedMediaCount, 1);
            assert.equal(insertTrashCalls.length, 0, "trash=false must skip insertIfAbsent");
            assert.deepEqual(permanentCalls[0], { service: "workflow", workflowId: "wf-direct-del", userId: "user-1" });

            // 4. Explicit trash: "false" (query string form) on 1st delete for element and character -> direct permanent delete
            const directElemRes = await trashService.requestDelete({ kind: "element", id: "elem-direct", userId: "user-1", trash: "false" });
            assert.equal("trashed" in directElemRes, false);
            assert.equal(directElemRes.deletedMediaCount, 2);
            assert.equal(insertTrashCalls.length, 0);
            assert.deepEqual(permanentCalls[1], { service: "element", id: "elem-direct", userId: "user-1" });

            const directCharRes = await trashService.requestDelete({ kind: "character", id: "wf-char-direct", userId: "user-1", trash: false });
            assert.equal("trashed" in directCharRes, false);
            assert.equal(directCharRes.deletedMediaCount, 3);
            assert.equal(insertTrashCalls.length, 0);
            assert.deepEqual(permanentCalls[2], { service: "character", characterId: "wf-char-direct", userId: "user-1" });

            // 5. requestDeleteMany with trash: false -> permanently deletes batch on 1st delete without inserting into trash
            const batchDirectRes = await trashService.requestDeleteMany({
                ids: ["wf-batch-1", "wf-batch-2"],
                userId: "user-1",
                trash: false,
            });
            assert.deepEqual(batchDirectRes.workflow_ids, ["wf-batch-1", "wf-batch-2"]);
            assert.equal("trashed" in batchDirectRes, false);
            assert.equal(insertTrashCalls.length, 0);
            assert.equal(permanentCalls.length, 5);
        } finally {
            setDb(db);
        }
    });
});
}

// ─── Source: trashReaderFiltering.test.js ───
{
/**
 * Builds an in-memory Supabase table query simulator supporting:
 * select (with count/head), eq, in, not, is, or, ilike, order, range, limit, maybeSingle, single.
 */
function createTableClient(tables) {
    return {
        from(tableName) {
            const rows = tables[tableName] || [];
            const filters = [];
            const orders = [];
            let rangeSpec = null;
            let limitCount = null;
            let countMode = false;
            let headMode = false;

            const applyFilters = () => {
                return rows.filter((row) =>
                    filters.every((fn) => fn(row))
                );
            };

            const execute = () => {
                let matched = applyFilters();
                const totalCount = matched.length;

                if (headMode && countMode) {
                    return { data: null, count: totalCount, error: null };
                }

                for (const { col, ascending } of orders) {
                    matched = [...matched].sort((a, b) => {
                        const va = a[col] ?? "";
                        const vb = b[col] ?? "";
                        if (va === vb) return 0;
                        return ascending ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
                    });
                }

                if (rangeSpec) {
                    matched = matched.slice(rangeSpec.from, rangeSpec.to + 1);
                } else if (typeof limitCount === "number") {
                    matched = matched.slice(0, limitCount);
                }

                return {
                    data: matched,
                    count: countMode ? totalCount : undefined,
                    error: null,
                };
            };

            const builder = {
                select(_cols = "*", opts = {}) {
                    if (opts?.count) countMode = true;
                    if (opts?.head) headMode = true;
                    return builder;
                },
                eq(col, val) {
                    filters.push((row) => row[col] === val);
                    return builder;
                },
                in(col, vals) {
                    const set = new Set(vals || []);
                    filters.push((row) => set.has(row[col]));
                    return builder;
                },
                not(col, op, val) {
                    if (op === "is" && val === null) {
                        filters.push((row) => row[col] !== null && row[col] !== undefined);
                    } else if (op === "in") {
                        const parsed = Array.isArray(val)
                            ? val
                            : String(val || "")
                                  .replace(/^\(|\)$/g, "")
                                  .split(",")
                                  .map((s) => s.trim().replace(/^"|"$/g, ""))
                                  .filter(Boolean);
                        const excluded = new Set(parsed);
                        filters.push((row) => !excluded.has(row[col]));
                    }
                    return builder;
                },
                is(col, val) {
                    filters.push((row) => (val === null ? row[col] === null || row[col] === undefined : row[col] === val));
                    return builder;
                },
                ilike(col, val) {
                    const needle = String(val || "").toLowerCase();
                    filters.push((row) => String(row[col] || "").toLowerCase() === needle);
                    return builder;
                },
                or(expr) {
                    // Supports expressions used by repositories:
                    // - "project_id.eq.<pid>,workflow_id.in.(...)"
                    // - "id.eq.<id>,workflow_id.eq.<id>"
                    filters.push((row) => {
                        const parts = String(expr).split(",");
                        const pidMatch = expr.match(/project_id\.eq\.([^,]+)/);
                        const wfInMatch = expr.match(/workflow_id\.in\.\(([^)]*)\)/);
                        if (pidMatch || wfInMatch) {
                            const byPid = pidMatch ? row.project_id === pidMatch[1] : false;
                            const inIds = wfInMatch
                                ? wfInMatch[1].split(",").map((s) => s.trim()).filter(Boolean)
                                : [];
                            const byWf = inIds.includes(row.workflow_id);
                            return byPid || byWf;
                        }
                        return parts.some((part) => {
                            const eqMatch = part.match(/^([a-zA-Z0-9_]+)\.eq\.(.+)$/);
                            if (eqMatch) {
                                return row[eqMatch[1]] === eqMatch[2];
                            }
                            return false;
                        });
                    });
                    return builder;
                },
                order(col, { ascending = true } = {}) {
                    orders.push({ col, ascending });
                    return builder;
                },
                range(from, to) {
                    rangeSpec = { from, to };
                    return builder;
                },
                limit(n) {
                    limitCount = n;
                    return builder;
                },
                async maybeSingle() {
                    const res = execute();
                    return { data: res.data?.[0] || null, error: null };
                },
                async single() {
                    const res = execute();
                    if (!res.data?.length) {
                        return { data: null, error: { code: "PGRST116", message: "Not found" } };
                    }
                    return { data: res.data[0], error: null };
                },
                then(resolve, reject) {
                    try {
                        return Promise.resolve(execute()).then(resolve, reject);
                    } catch (err) {
                        return Promise.reject(err).then(resolve, reject);
                    }
                },
            };

            return builder;
        },
    };
}

describe("T2: Reader Filtering Excludes Trashed Workflows While Preserving By-ID and Auth Reads", () => {
    it("1. WorkflowRepository readers (findByProject, findByProjectsPaginated, findByIdInProjects, listProjectAssets) exclude trashed workflows", async () => {
        const mockClient = createTableClient({
            workflow: [
                {
                    id: "wf-active",
                    project_id: "proj-1",
                    user_id: "user-1",
                    folder_id: "folder-1",
                    display_name: "Active Workflow",
                    favorited: false,
                    workflow_type: "GENERATION",
                    create_time: "2026-10-25T12:00:00.000Z",
                },
                {
                    id: "wf-trashed",
                    project_id: "proj-1",
                    user_id: "user-1",
                    folder_id: "folder-1",
                    display_name: "Trashed Workflow",
                    favorited: true,
                    workflow_type: "GENERATION",
                    create_time: "2026-10-25T13:00:00.000Z",
                },
            ],
            trash: [
                {
                    id: "trash-1",
                    workflow_id: "wf-trashed",
                    user_id: "user-1",
                    deleted_at: "2026-10-25T14:00:00.000Z",
                },
            ],
        });

        const origSupabaseFrom = supabase.from;
        const origAdminFrom = supabaseAdmin.from;
        supabase.from = mockClient.from.bind(mockClient);
        supabaseAdmin.from = mockClient.from.bind(mockClient);

        try {
            const repo = new WorkflowRepository();

            const byProject = await repo.findByProject("proj-1");
            assert.deepEqual(
                byProject.map((w) => w.id),
                ["wf-active"],
                "findByProject must exclude wf-trashed"
            );

            const paginated = await repo.findByProjectsPaginated(["proj-1"], { limit: 10, offset: 0 });
            assert.equal(paginated.total, 1, "findByProjectsPaginated total count must exclude wf-trashed");
            assert.deepEqual(
                paginated.workflows.map((w) => w.id),
                ["wf-active"],
                "findByProjectsPaginated workflows page must exclude wf-trashed"
            );

            const trashedDetail = await repo.findByIdInProjects("wf-trashed", ["proj-1"]);
            assert.equal(trashedDetail, null, "findByIdInProjects must return null for trashed workflow");

            const activeDetail = await repo.findByIdInProjects("wf-active", ["proj-1"]);
            assert.equal(activeDetail?.id, "wf-active", "findByIdInProjects must return active workflow");

            const assets = await repo.listProjectAssets("proj-1", { folderIds: ["folder-1"] });
            assert.deepEqual(
                assets.map((w) => w.id),
                ["wf-active"],
                "listProjectAssets must exclude wf-trashed"
            );
        } finally {
            supabase.from = origSupabaseFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });

    it("2. ElementRepository readers (list and findByName) exclude elements whose container workflow is in trash", async () => {
        const mockClient = createTableClient({
            workflow: [
                { id: "wf-elem-active", project_id: "proj-1", workflow_type: "ELEMENT_SHEET" },
                { id: "wf-elem-trashed", project_id: "proj-1", workflow_type: "ELEMENT_SHEET" },
                { id: "wf-elem-only-trashed", project_id: "proj-1", workflow_type: "ELEMENT_SHEET" },
            ],
            element: [
                {
                    id: "elem-trashed",
                    workflow_id: "wf-elem-trashed",
                    name: "DragonSword",
                    create_time: "2026-10-25T13:00:00.000Z",
                },
                {
                    id: "elem-active",
                    workflow_id: "wf-elem-active",
                    name: "DragonSword",
                    create_time: "2026-10-25T14:00:00.000Z",
                },
                {
                    id: "elem-only-trashed",
                    workflow_id: "wf-elem-only-trashed",
                    name: "DeletedShield",
                    create_time: "2026-10-25T15:00:00.000Z",
                },
            ],
            trash: [
                { id: "t-1", workflow_id: "wf-elem-trashed", user_id: "user-1" },
                { id: "t-2", workflow_id: "wf-elem-only-trashed", user_id: "user-1" },
            ],
        });

        const origSupabaseFrom = supabase.from;
        const origAdminFrom = supabaseAdmin.from;
        supabase.from = mockClient.from.bind(mockClient);
        supabaseAdmin.from = mockClient.from.bind(mockClient);

        try {
            const repo = new ElementRepository();

            const listed = await repo.list({ projectId: "proj-1" });
            assert.deepEqual(
                listed.map((e) => e.id),
                ["elem-active"],
                "ElementRepository.list must exclude elements whose workflow_id is in trash"
            );

            const foundSameName = await repo.findByName("dragonsword", "proj-1");
            assert.equal(
                foundSameName?.id,
                "elem-active",
                "ElementRepository.findByName must ignore trashed element with the same name and return active element"
            );

            const foundOnlyTrashed = await repo.findByName("deletedshield", "proj-1");
            assert.equal(
                foundOnlyTrashed,
                null,
                "ElementRepository.findByName must return null when only a trashed element matches the name"
            );
        } finally {
            supabase.from = origSupabaseFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });

    it("3. CharacterRepository.findByProjectOrWorkflowIds excludes characters whose workflow is in trash even when matched by project_id", async () => {
        const mockClient = createTableClient({
            characters: [
                {
                    id: "wf-char-active",
                    workflow_id: "wf-char-active",
                    project_id: "proj-1",
                    user_id: "user-1",
                    name: "Active Hero",
                },
                {
                    id: "wf-char-trashed",
                    workflow_id: "wf-char-trashed",
                    project_id: "proj-1",
                    user_id: "user-1",
                    name: "Trashed Hero",
                },
            ],
            trash: [
                { id: "t-char", workflow_id: "wf-char-trashed", user_id: "user-1" },
            ],
        });

        const origSupabaseFrom = supabase.from;
        const origAdminFrom = supabaseAdmin.from;
        supabase.from = mockClient.from.bind(mockClient);
        supabaseAdmin.from = mockClient.from.bind(mockClient);

        try {
            const repo = new CharacterRepository();

            const withWorkflowIds = await repo.findByProjectOrWorkflowIds({
                projectId: "proj-1",
                workflowIds: ["wf-char-active"],
            });
            assert.deepEqual(
                withWorkflowIds.map((c) => c.id),
                ["wf-char-active"],
                "findByProjectOrWorkflowIds({ projectId, workflowIds }) must exclude trashed character matched by project_id"
            );

            const byProjectOnly = await repo.findByProjectOrWorkflowIds({
                projectId: "proj-1",
            });
            assert.deepEqual(
                byProjectOnly.map((c) => c.id),
                ["wf-char-active"],
                "findByProjectOrWorkflowIds({ projectId }) must exclude trashed character"
            );
        } finally {
            supabase.from = origSupabaseFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });

    it("4. FolderRepository.countAssetsByFolder excludes trashed workflows while listIdsByFolderIds and countAssetsIn still include trashed workflows", async () => {
        const mockClient = createTableClient({
            workflow: [
                { id: "wf-f1-active", project_id: "proj-1", folder_id: "folder-1", user_id: "user-1" },
                { id: "wf-f1-trashed", project_id: "proj-1", folder_id: "folder-1", user_id: "user-1" },
                { id: "wf-f2-trashed", project_id: "proj-1", folder_id: "folder-2", user_id: "user-1" },
            ],
            trash: [
                { id: "t-1", workflow_id: "wf-f1-trashed", user_id: "user-1" },
                { id: "t-2", workflow_id: "wf-f2-trashed", user_id: "user-1" },
            ],
        });

        const origSupabaseFrom = supabase.from;
        const origAdminFrom = supabaseAdmin.from;
        supabase.from = mockClient.from.bind(mockClient);
        supabaseAdmin.from = mockClient.from.bind(mockClient);

        try {
            const folderRepo = new FolderRepository(mockClient);
            const wfRepo = new WorkflowRepository();

            const badgeCounts = await folderRepo.countAssetsByFolder("proj-1", "user-1");
            assert.deepEqual(
                badgeCounts,
                { "folder-1": 1 },
                "countAssetsByFolder must exclude trashed workflows from UI folder badge counts"
            );

            const cascadeIds = await wfRepo.listIdsByFolderIds({
                folderIds: ["folder-1", "folder-2"],
                projectId: "proj-1",
                userId: "user-1",
            });
            assert.deepEqual(
                cascadeIds.sort(),
                ["wf-f1-active", "wf-f1-trashed", "wf-f2-trashed"].sort(),
                "WorkflowRepository.listIdsByFolderIds must still include trashed workflows for folder tree deletion"
            );

            const directCount = await folderRepo.countAssetsIn("folder-1", "user-1");
            assert.equal(
                directCount,
                2,
                "FolderRepository.countAssetsIn must still include trashed workflows"
            );
        } finally {
            supabase.from = origSupabaseFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });

    it("5. ProjectReadService.getProjectData excludes trashed workflows, elements, and characters across all 3 locations (both when active workflows remain and when all workflows are trashed)", async () => {
        const tables = {
            project: [{ id: "proj-1", project_name: "Studio Project", user_id: "user-1" }],
            workflow: [
                {
                    id: "wf-active-elem",
                    project_id: "proj-1",
                    display_name: "Active Element WF",
                    workflow_type: "ELEMENT_SHEET",
                    create_time: "2026-10-25T10:00:00.000Z",
                },
                {
                    id: "wf-trashed-elem",
                    project_id: "proj-1",
                    display_name: "Trashed Element WF",
                    workflow_type: "ELEMENT_SHEET",
                    create_time: "2026-10-25T11:00:00.000Z",
                },
                {
                    id: "wf-trashed-char",
                    project_id: "proj-1",
                    display_name: "Trashed Character WF",
                    workflow_type: "CHARACTER",
                    create_time: "2026-10-25T12:00:00.000Z",
                },
            ],
            element: [
                { id: "el-active", workflow_id: "wf-active-elem", name: "ActiveElem" },
                { id: "el-trashed", workflow_id: "wf-trashed-elem", name: "TrashedElem" },
            ],
            characters: [
                {
                    id: "wf-trashed-char",
                    workflow_id: "wf-trashed-char",
                    project_id: "proj-1",
                    user_id: "user-1",
                    name: "TrashedChar",
                },
            ],
            media: [],
            workflow_media: [],
            trash: [
                { id: "t-el", workflow_id: "wf-trashed-elem", user_id: "user-1" },
                { id: "t-ch", workflow_id: "wf-trashed-char", user_id: "user-1" },
            ],
        };

        const mockClient = createTableClient(tables);
        const origSupabaseFrom = supabase.from;
        const origAdminFrom = supabaseAdmin.from;
        supabase.from = mockClient.from.bind(mockClient);
        supabaseAdmin.from = mockClient.from.bind(mockClient);

        try {
            const db = {
                projects: { findById: async (id) => tables.project.find((p) => p.id === id) || null },
                workflows: new WorkflowRepository(),
                elements: new ElementRepository(),
                characters: new CharacterRepository(),
                media: { findByProjectAll: async () => [] },
                workflowMedia: { findRelationsByWorkflowIds: async () => [] },
            };
            const service = new ProjectReadService({ db });

            // Case A: Some active workflows remain (workflowIds.length > 0 -> locations 1 & 2)
            const partialResult = await service.getProjectData({ projectId: "proj-1", userId: "user-1" });
            assert.deepEqual(
                partialResult.workflows.map((w) => w.id),
                ["wf-active-elem"],
                "getProjectData must exclude trashed workflows"
            );
            assert.deepEqual(
                partialResult.elements.map((e) => e.id),
                ["el-active"],
                "getProjectData must exclude trashed elements"
            );
            assert.deepEqual(
                partialResult.characters.map((c) => c.id),
                [],
                "getProjectData (workflowIds.length > 0) must exclude trashed characters"
            );

            // Case B: All workflows in project are trashed (workflowIds.length === 0 -> location 3)
            tables.trash.push({ id: "t-el-active", workflow_id: "wf-active-elem", user_id: "user-1" });
            const allTrashedResult = await service.getProjectData({ projectId: "proj-1", userId: "user-1" });
            assert.deepEqual(allTrashedResult.workflows, []);
            assert.deepEqual(allTrashedResult.elements, []);
            assert.deepEqual(
                allTrashedResult.characters,
                [],
                "getProjectData (workflowIds.length === 0) must also exclude trashed characters fetched by project_id"
            );
        } finally {
            supabase.from = origSupabaseFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });

    it("6. By-ID readers and authorization checks still return trashed workflows, elements, and characters", async () => {
        const tables = {
            project: [{ id: "proj-1", user_id: "user-1" }],
            workflow: [
                {
                    id: "00000000-0000-4000-8000-000000000001",
                    project_id: "proj-1",
                    user_id: "user-1",
                    display_name: "Trashed WF",
                    workflow_type: "ELEMENT_SHEET",
                    project: { user_id: "user-1" },
                },
            ],
            element: [
                {
                    id: "00000000-0000-4000-8000-000000000002",
                    workflow_id: "00000000-0000-4000-8000-000000000001",
                    name: "TrashedElem",
                },
            ],
            characters: [
                {
                    id: "00000000-0000-4000-8000-000000000001",
                    workflow_id: "00000000-0000-4000-8000-000000000001",
                    project_id: "proj-1",
                    user_id: "user-1",
                    name: "TrashedChar",
                },
            ],
            trash: [
                {
                    id: "trash-1",
                    workflow_id: "00000000-0000-4000-8000-000000000001",
                    user_id: "user-1",
                },
            ],
        };

        const mockClient = createTableClient(tables);
        const origSupabaseFrom = supabase.from;
        const origAdminFrom = supabaseAdmin.from;
        supabase.from = mockClient.from.bind(mockClient);
        supabaseAdmin.from = mockClient.from.bind(mockClient);

        const wfId = "00000000-0000-4000-8000-000000000001";
        const elemId = "00000000-0000-4000-8000-000000000002";

        const wfRepo = new WorkflowRepository();
        const elemRepo = new ElementRepository();
        const charRepo = new CharacterRepository();
        const fakeDb = {
            workflows: wfRepo,
            elements: elemRepo,
            characters: charRepo,
            projects: {
                findByUser: async (uid, pid) =>
                    uid === "user-1" && pid === "proj-1" ? [{ id: "proj-1", user_id: "user-1" }] : [],
            },
        };
        setDb(fakeDb);

        try {
            assert.equal((await wfRepo.findById(wfId))?.id, wfId, "WorkflowRepository.findById must return trashed workflow");
            assert.equal((await wfRepo.getWorkflow(wfId))?.id, wfId, "WorkflowRepository.getWorkflow must return trashed workflow");
            assert.equal((await elemRepo.findById(elemId))?.id, elemId, "ElementRepository.findById must return trashed element");
            assert.equal((await elemRepo.findByWorkflowId(wfId))?.id, elemId, "ElementRepository.findByWorkflowId must return trashed element");
            assert.equal((await elemRepo.resolveRecord(elemId))?.id, elemId, "ElementRepository.resolveRecord must return trashed element");
            assert.equal((await charRepo.findByCharacterId(wfId))?.id, wfId, "CharacterRepository.findByCharacterId must return trashed character");

            const authService = new WorkflowAuthorizationService({ db: fakeDb });
            assert.equal(
                await authService.verifyWorkflowOwnership(wfId, "user-1"),
                true,
                "verifyWorkflowOwnership must still return true for trashed workflow"
            );

            assert.equal((await assertOwns("workflow", wfId, "user-1"))?.id, wfId, "assertOwns('workflow') must return trashed workflow");
            assert.equal((await assertOwns("element", elemId, "user-1"))?.id, elemId, "assertOwns('element') must return trashed element");
            assert.equal((await assertOwns("character", wfId, "user-1"))?.id, wfId, "assertOwns('character') must return trashed character");
        } finally {
            setDb(db);
            supabase.from = origSupabaseFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });
});
}

// ─── Source: trashRoutesBoundary.test.js ───
{
// @covers GET /api/trash
// @covers POST /api/trash/:workflowId/restore

describe("Trash List and Restore Routes Boundary Tests (T4)", () => {
    let server;
    let baseUrl;
    let origGetUser;

    let mockProjects;
    let mockWorkflows;
    let mockElements;
    let mockCharacters;
    let mockTrash;

    let originalDbProjects;
    let originalDbWorkflows;
    let originalDbElements;
    let originalDbCharacters;
    let originalDbTrash;

    let workflowDeleteCount;
    let workflowCreateCount;

    before(async () => {
        origGetUser = supabase.auth.getUser;
        supabase.auth.getUser = async (token) => {
            if (token === "token-user-A") return { data: { user: { id: "user-A" } }, error: null };
            if (token === "token-user-B") return { data: { user: { id: "user-B" } }, error: null };
            return { data: { user: null }, error: new Error("Invalid token") };
        };

        const app = express();
        app.use(express.json());
        app.use("/api", apiRouter);
        app.use((err, req, res, _next) => {
            res.status(err.statusCode || 500).json({
                ok: false,
                message: err.message,
            });
        });

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
    });

    after(async () => {
        supabase.auth.getUser = origGetUser;
        await Promise.allSettled([
            rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect()),
            redisConnection?.quit().catch(() => redisConnection?.disconnect()),
            workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect()),
        ]);
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    beforeEach(() => {
        workflowDeleteCount = 0;
        workflowCreateCount = 0;

        mockProjects = [
            { id: "proj-A", user_id: "user-A", project_name: "Project A" },
            { id: "proj-B", user_id: "user-B", project_name: "Project B" },
        ];

        mockWorkflows = [
            {
                id: "wf-A-1",
                project_id: "proj-A",
                user_id: "user-A",
                display_name: "First WF A",
                workflow_type: "IMAGE",
                create_time: "2026-10-25T10:00:00.000Z",
            },
            {
                id: "wf-A-2",
                project_id: "proj-A",
                user_id: "user-A",
                display_name: "Second WF A",
                workflow_type: "VIDEO",
                create_time: "2026-10-25T11:00:00.000Z",
            },
            {
                id: "wf-elem-A",
                project_id: "proj-A",
                user_id: "user-A",
                display_name: "Element WF A",
                workflow_type: "ELEMENT_SHEET",
                create_time: "2026-10-25T12:00:00.000Z",
            },
            {
                id: "wf-char-A",
                project_id: "proj-A",
                user_id: "user-A",
                display_name: "Character WF A",
                workflow_type: "CHARACTER_SHEET",
                create_time: "2026-10-25T13:00:00.000Z",
            },
            {
                id: "wf-B-1",
                project_id: "proj-B",
                user_id: "user-B",
                display_name: "Foreign WF B",
                workflow_type: "IMAGE",
                create_time: "2026-10-25T14:00:00.000Z",
            },
        ];

        mockElements = [
            {
                id: "elem-A",
                workflow_id: "wf-elem-A",
                project_id: "proj-A",
                user_id: "user-A",
                name: "Sword A",
                element_type: "object",
            },
        ];

        mockCharacters = [
            {
                id: "wf-char-A",
                workflow_id: "wf-char-A",
                project_id: "proj-A",
                user_id: "user-A",
                name: "Hero A",
            },
        ];

        mockTrash = [];

        originalDbProjects = { ...db.projects };
        originalDbWorkflows = { ...db.workflows };
        originalDbElements = { ...db.elements };
        originalDbCharacters = { ...db.characters };
        originalDbTrash = { ...db.trash };

        db.projects.findByUser = async (userId, projectId = null) =>
            mockProjects.filter((p) => p.user_id === userId && (!projectId || p.id === projectId));
        db.projects.findById = async (id) => mockProjects.find((p) => p.id === id) || null;

        db.workflows.findById = async (id) => mockWorkflows.find((w) => w.id === id) || null;
        db.workflows.getWorkflow = async (id) => mockWorkflows.find((w) => w.id === id) || null;
        db.workflows.createWorkflow = async (data) => {
            workflowCreateCount += 1;
            mockWorkflows.push(data);
            return data;
        };
        db.workflows.deleteById = async (id) => {
            workflowDeleteCount += 1;
            const idx = mockWorkflows.findIndex((w) => w.id === id);
            if (idx !== -1) mockWorkflows.splice(idx, 1);
            return true;
        };
        db.workflows.findByProject = async (projectId, options = {}) => {
            const trashedIds = new Set(mockTrash.map((t) => t.workflow_id));
            if (options?.partitioned) {
                const active = mockWorkflows.filter((w) => w.project_id === projectId && !trashedIds.has(w.id));
                const trashed = mockWorkflows.filter((w) => w.project_id === projectId && trashedIds.has(w.id));
                return { active, trashed };
            }
            return mockWorkflows.filter((w) => w.project_id === projectId && !trashedIds.has(w.id));
        };
        db.workflows.client = () => ({
            from(table) {
                assert.equal(table, "workflow");
                return {
                    select() {
                        return {
                            async in(col, ids) {
                                assert.equal(col, "id");
                                const rows = mockWorkflows
                                    .filter((w) => ids.includes(w.id))
                                    .map((w) => {
                                        const proj = mockProjects.find((p) => p.id === w.project_id);
                                        return {
                                            id: w.id,
                                            project: proj ? { user_id: proj.user_id } : null,
                                        };
                                    });
                                return { data: rows, error: null };
                            },
                        };
                    },
                };
            },
        });

        db.elements.resolveRecord = async (id) =>
            mockElements.find((e) => e.id === id || e.workflow_id === id) || null;
        db.elements.findById = async (id) => mockElements.find((e) => e.id === id) || null;
        db.elements.findByWorkflowId = async (workflowId) =>
            mockElements.find((e) => e.workflow_id === workflowId) || null;
        db.elements.list = async ({ projectId }) => {
            const trashedIds = new Set(mockTrash.map((t) => t.workflow_id));
            const activeWfIds = new Set(
                mockWorkflows.filter((w) => w.project_id === projectId && !trashedIds.has(w.id)).map((w) => w.id)
            );
            return mockElements.filter((e) => activeWfIds.has(e.workflow_id));
        };

        db.characters.findByCharacterId = async (id) =>
            mockCharacters.find((c) => c.id === id || c.workflow_id === id) || null;
        db.characters.findById = async (id) => mockCharacters.find((c) => c.id === id) || null;
        db.characters.findByProjectOrWorkflowIds = async ({ projectId, workflowIds = [] } = {}) => {
            const trashedIds = new Set(mockTrash.map((t) => t.workflow_id));
            return mockCharacters.filter(
                (c) =>
                    (c.project_id === projectId || workflowIds.includes(c.workflow_id)) &&
                    !trashedIds.has(c.workflow_id || c.id)
            );
        };

        db.trash.insertIfAbsent = async ({ workflowId, userId, deletedBy = userId }) => {
            const existing = mockTrash.find((t) => t.workflow_id === workflowId);
            if (existing) return null;
            const row = {
                id: `trash-${mockTrash.length + 1}`,
                workflow_id: workflowId,
                user_id: userId,
                deleted_at: new Date().toISOString(),
                deleted_by: deletedBy ?? userId,
            };
            mockTrash.push(row);
            return row;
        };

        db.trash.listByUser = async (userId) => {
            return mockTrash
                .filter((t) => t.user_id === userId)
                .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at))
                .map((t) => {
                    const wf = mockWorkflows.find((w) => w.id === t.workflow_id);
                    return {
                        workflow_id: t.workflow_id,
                        display_name: wf?.display_name ?? null,
                        workflow_type: wf?.workflow_type ?? null,
                        deleted_at: t.deleted_at,
                    };
                });
        };

        db.trash.deleteByWorkflowAndUser = async ({ workflowId, userId }) => {
            const idx = mockTrash.findIndex((t) => t.workflow_id === workflowId && t.user_id === userId);
            if (idx === -1) return null;
            const [removed] = mockTrash.splice(idx, 1);
            return removed;
        };

        db.trash.deleteManyByUser = async ({ userId, workflowIds = null }) => {
            const removedIds = [];
            for (let i = mockTrash.length - 1; i >= 0; i--) {
                const item = mockTrash[i];
                if (item.user_id === userId) {
                    if (!workflowIds || workflowIds.includes(item.workflow_id)) {
                        removedIds.push(item.workflow_id);
                        mockTrash.splice(i, 1);
                    }
                }
            }
            return removedIds;
        };
    });

    afterEach(() => {
        Object.assign(db.projects, originalDbProjects);
        Object.assign(db.workflows, originalDbWorkflows);
        Object.assign(db.elements, originalDbElements);
        Object.assign(db.characters, originalDbCharacters);
        Object.assign(db.trash, originalDbTrash);
    });

    it("1. Authentication guard: unauthenticated POST /api/trash/:workflowId/restore returns 401", async () => {
        const restoreRes = await fetch(`${baseUrl}/api/trash/wf-A-1/restore`, {
            method: "POST",
        });
        assert.equal(restoreRes.status, 401);
    });

    it("2. End-to-end Trash -> Restore -> Reader visibility lifecycle without deleting or recreating public.workflow", async () => {
        const originalWfRef = mockWorkflows.find((w) => w.id === "wf-elem-A");

        // 1. Delete element via DELETE /api/v2/elements/elem-A -> moves wf-elem-A to Trash
        const delRes = await fetch(`${baseUrl}/api/v2/elements/elem-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(delRes.status, 200);
        const delBody = await delRes.json();
        assert.equal(delBody.trashed, true);

        // Also delete character via DELETE /api/characters/wf-char-A -> moves wf-char-A to Trash
        const delCharRes = await fetch(`${baseUrl}/api/characters/wf-char-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(delCharRes.status, 200);

        // 2. Workflows are hidden from active readers
        const activeWfsWhileTrashed = await db.workflows.findByProject("proj-A");
        assert.equal(activeWfsWhileTrashed.some((w) => w.id === "wf-elem-A"), false);
        assert.equal(activeWfsWhileTrashed.some((w) => w.id === "wf-char-A"), false);
        const activeElemsWhileTrashed = await db.elements.list({ projectId: "proj-A" });
        assert.equal(activeElemsWhileTrashed.some((e) => e.id === "elem-A"), false);
        const activeCharsWhileTrashed = await db.characters.findByProjectOrWorkflowIds({
            projectId: "proj-A",
            workflowIds: ["wf-char-A"],
        });
        assert.equal(activeCharsWhileTrashed.some((c) => c.id === "wf-char-A"), false);

        // 3. Restore both via POST /api/trash/:workflowId/restore
        const restoreRes = await fetch(`${baseUrl}/api/trash/wf-elem-A/restore`, {
            method: "POST",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(restoreRes.status, 200);
        const restoreBody = await restoreRes.json();
        assert.deepEqual(restoreBody, {
            ok: true,
            workflow_id: "wf-elem-A",
            restored: true,
        });

        const restoreCharRes = await fetch(`${baseUrl}/api/trash/wf-char-A/restore`, {
            method: "POST",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(restoreCharRes.status, 200);

        // 4. Verify public.workflow row was never deleted or recreated (exact same object reference)
        assert.equal(workflowDeleteCount, 0, "restore must never delete public.workflow");
        assert.equal(workflowCreateCount, 0, "restore must never recreate public.workflow");
        assert.equal(mockWorkflows.find((w) => w.id === "wf-elem-A"), originalWfRef);

        // 5. Reappears in active readers
        const activeWfsAfterRestore = await db.workflows.findByProject("proj-A");
        assert.equal(activeWfsAfterRestore.some((w) => w.id === "wf-elem-A"), true);
        assert.equal(activeWfsAfterRestore.some((w) => w.id === "wf-char-A"), true);
        const activeElemsAfterRestore = await db.elements.list({ projectId: "proj-A" });
        assert.equal(activeElemsAfterRestore.some((e) => e.id === "elem-A"), true);
        const activeCharsAfterRestore = await db.characters.findByProjectOrWorkflowIds({
            projectId: "proj-A",
            workflowIds: ["wf-char-A"],
        });
        assert.equal(activeCharsAfterRestore.some((c) => c.id === "wf-char-A"), true);
    });

    it("3. POST /api/trash/:workflowId/restore returns 404 when workflow is not in Trash, when called a second time after restore, or for a non-existent workflowId", async () => {
        // Active workflow not in Trash -> 404
        const resNotTrashed = await fetch(`${baseUrl}/api/trash/wf-A-1/restore`, {
            method: "POST",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(resNotTrashed.status, 404);
        const bodyNotTrashed = await resNotTrashed.json();
        assert.equal(bodyNotTrashed.ok, false);
        assert.equal(bodyNotTrashed.errorCode, "NOT_FOUND");
        assert.match(bodyNotTrashed.message, /Workflow not found in trash/i);

        // Move wf-A-1 to Trash, restore once (200), then restore a second time (404)
        await db.trash.insertIfAbsent({ workflowId: "wf-A-1", userId: "user-A" });
        const resFirstRestore = await fetch(`${baseUrl}/api/trash/wf-A-1/restore`, {
            method: "POST",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(resFirstRestore.status, 200);

        const resSecondRestore = await fetch(`${baseUrl}/api/trash/wf-A-1/restore`, {
            method: "POST",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(resSecondRestore.status, 404);
        const bodySecondRestore = await resSecondRestore.json();
        assert.equal(bodySecondRestore.ok, false);
        assert.equal(bodySecondRestore.errorCode, "NOT_FOUND");

        // Non-existent workflowId -> 404
        const resMissing = await fetch(`${baseUrl}/api/trash/00000000-0000-4000-8000-000000000999/restore`, {
            method: "POST",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(resMissing.status, 404);
        const bodyMissing = await resMissing.json();
        assert.equal(bodyMissing.ok, false);
        assert.equal(bodyMissing.errorCode, "NOT_FOUND");
    });

    it("5. Cross-tenant restore returns 404 (never 403) and leaves owner's public.trash row intact", async () => {
        await db.trash.insertIfAbsent({ workflowId: "wf-A-1", userId: "user-A" });

        const crossRes = await fetch(`${baseUrl}/api/trash/wf-A-1/restore`, {
            method: "POST",
            headers: { Authorization: "Bearer token-user-B" },
        });
        assert.equal(crossRes.status, 404);
        const crossBody = await crossRes.json();
        assert.equal(crossBody.ok, false);
        assert.equal(crossBody.errorCode, "NOT_FOUND");
        assert.equal(mockTrash.length, 1, "User A's trash row must remain untouched after cross-tenant restore attempt");
        assert.equal(mockTrash[0].workflow_id, "wf-A-1");
        assert.equal(mockTrash[0].user_id, "user-A");
    });

    it("6. POST /api/trash/restore-all restores all trashed workflows for authenticated user and returns count", async () => {
        // Setup: add 2 items for user-A and 1 item for user-B to trash
        await db.trash.insertIfAbsent({ workflowId: "wf-A-1", userId: "user-A" });
        await db.trash.insertIfAbsent({ workflowId: "wf-elem-A", userId: "user-A" });
        await db.trash.insertIfAbsent({ workflowId: "wf-B-1", userId: "user-B" });

        // Unauthenticated -> 401
        const unauthRes = await fetch(`${baseUrl}/api/trash/restore-all`, {
            method: "POST",
        });
        assert.equal(unauthRes.status, 401);

        // User A restores all
        const restoreAllRes = await fetch(`${baseUrl}/api/trash/restore-all`, {
            method: "POST",
            headers: {
                Authorization: "Bearer token-user-A",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ projectId: "proj-A" }),
        });
        assert.equal(restoreAllRes.status, 200);
        const restoreAllBody = await restoreAllRes.json();
        assert.equal(restoreAllBody.ok, true);
        assert.equal(restoreAllBody.restored, true);
        assert.equal(restoreAllBody.count >= 1, true);

        // User B's trash row must remain in trash
        assert.equal(mockTrash.some((t) => t.workflow_id === "wf-B-1" && t.user_id === "user-B"), true);
        assert.equal(mockTrash.some((t) => t.user_id === "user-A"), false);
    });
});
}

// ─── Source: workflowTrashDeleteRoutesBoundary.test.js ───
{
// @covers DELETE /api/workflows/workflows/:id
// @covers DELETE /api/workflows/:id
// @covers DELETE /api/workflows/workflows
// @covers DELETE /api/v2/elements/:id
// @covers DELETE /api/characters/:characterId

describe("Workflow Trash Delete Routes Boundary Tests (T3)", () => {
    let server;
    let baseUrl;
    let origGetUser;

    let mockProjects;
    let mockWorkflows;
    let mockElements;
    let mockCharacters;
    let mockTrash;

    let originalDbProjects;
    let originalDbWorkflows;
    let originalDbElements;
    let originalDbCharacters;
    let originalDbTrash;
    let originalReleaseWorkflowMedia;

    let callOrder;
    let releaseWorkflowMediaCalls;
    let failDeleteWorkflowForId;

    before(async () => {
        origGetUser = supabase.auth.getUser;
        supabase.auth.getUser = async (token) => {
            if (token === "token-user-A") return { data: { user: { id: "user-A" } }, error: null };
            if (token === "token-user-B") return { data: { user: { id: "user-B" } }, error: null };
            return { data: { user: null }, error: new Error("Invalid token") };
        };

        const app = express();
        app.use(express.json());
        app.use("/api/workflows", workflowsRouter);
        app.use("/api/v2/elements", elementRoutes);
        app.use("/api/characters", charactersRouter);
        app.use((err, req, res, _next) => {
            res.status(err.statusCode || 500).json({
                ok: false,
                message: err.message,
            });
        });

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
    });

    after(async () => {
        supabase.auth.getUser = origGetUser;
        await Promise.allSettled([
            rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect()),
            redisConnection?.quit().catch(() => redisConnection?.disconnect()),
            workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect()),
        ]);
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    beforeEach(() => {
        callOrder = [];
        releaseWorkflowMediaCalls = [];
        failDeleteWorkflowForId = null;

        mockProjects = [
            { id: "proj-user-A", user_id: "user-A" },
            { id: "proj-user-B", user_id: "user-B" },
        ];

        mockWorkflows = [
            { id: "wf-std-A", project_id: "proj-user-A", user_id: "user-A", display_name: "Standard WF A", workflow_type: "IMAGE" },
            { id: "wf-std-A-2", project_id: "proj-user-A", user_id: "user-A", display_name: "Standard WF A 2", workflow_type: "VIDEO" },
            { id: "wf-elem-A", project_id: "proj-user-A", user_id: "user-A", display_name: "Element WF A", workflow_type: "ELEMENT_SHEET" },
            { id: "wf-char-A", project_id: "proj-user-A", user_id: "user-A", display_name: "Character WF A", workflow_type: "CHARACTER_SHEET" },
            { id: "wf-std-B", project_id: "proj-user-B", user_id: "user-B", display_name: "Standard WF B", workflow_type: "IMAGE" },
        ];

        mockElements = [
            {
                id: "elem-user-A",
                workflow_id: "wf-elem-A",
                project_id: "proj-user-A",
                user_id: "user-A",
                name: "Sword A",
            },
            {
                id: "elem-orphan-A",
                workflow_id: null,
                project_id: "proj-user-A",
                user_id: "user-A",
                name: "Orphan Sword A",
            },
        ];

        mockCharacters = [
            {
                id: "wf-char-A",
                workflow_id: "wf-char-A",
                project_id: "proj-user-A",
                user_id: "user-A",
                name: "Hero A",
            },
            {
                id: "char-orphan-A",
                workflow_id: null,
                project_id: "proj-user-A",
                user_id: "user-A",
                name: "Orphan Hero A",
            },
        ];

        mockTrash = [];

        originalDbProjects = { ...db.projects };
        originalDbWorkflows = { ...db.workflows };
        originalDbElements = { ...db.elements };
        originalDbCharacters = { ...db.characters };
        originalDbTrash = { ...db.trash };
        originalReleaseWorkflowMedia = workflowService.mediaService.releaseWorkflowMedia;

        db.projects.findByUser = async (userId, projectId = null) =>
            mockProjects.filter((p) => p.user_id === userId && (!projectId || p.id === projectId));
        db.projects.findById = async (id) => mockProjects.find((p) => p.id === id) || null;

        db.workflows.findById = async (id) => mockWorkflows.find((w) => w.id === id) || null;
        db.workflows.getWorkflow = async (id) => mockWorkflows.find((w) => w.id === id) || null;
        db.workflows.updateFields = async (id, fields) => {
            const wf = mockWorkflows.find((w) => w.id === id);
            if (wf) Object.assign(wf, fields);
            return wf || null;
        };
        db.workflows.deleteById = async (id) => {
            if (failDeleteWorkflowForId === id) {
                throw new Error("Simulated workflow delete failure");
            }
            callOrder.push(`deleteWorkflowRow:${id}`);
            const idx = mockWorkflows.findIndex((w) => w.id === id);
            if (idx !== -1) mockWorkflows.splice(idx, 1);
            // Simulate PostgreSQL ON DELETE CASCADE on public.trash.workflow_id
            for (let i = mockTrash.length - 1; i >= 0; i--) {
                if (mockTrash[i].workflow_id === id) {
                    mockTrash.splice(i, 1);
                }
            }
            return true;
        };
        db.workflows.client = () => ({
            from(table) {
                assert.equal(table, "workflow");
                return {
                    select() {
                        return {
                            async in(col, ids) {
                                assert.equal(col, "id");
                                const rows = mockWorkflows
                                    .filter((w) => ids.includes(w.id))
                                    .map((w) => {
                                        const proj = mockProjects.find((p) => p.id === w.project_id);
                                        return {
                                            id: w.id,
                                            project: proj ? { user_id: proj.user_id } : null,
                                        };
                                    });
                                return { data: rows, error: null };
                            },
                        };
                    },
                };
            },
        });

        db.elements.resolveRecord = async (id) =>
            mockElements.find((e) => e.id === id || (e.workflow_id && e.workflow_id === id)) || null;
        db.elements.findById = async (id) => mockElements.find((e) => e.id === id) || null;
        db.elements.findByWorkflowId = async (workflowId) =>
            mockElements.find((e) => e.workflow_id === workflowId) || null;
        db.elements.deleteById = async (id) => {
            callOrder.push(`deleteElementRow:${id}`);
            const idx = mockElements.findIndex((e) => e.id === id);
            if (idx !== -1) mockElements.splice(idx, 1);
            return true;
        };

        db.characters.findByCharacterId = async (id) =>
            mockCharacters.find((c) => c.id === id || (c.workflow_id && c.workflow_id === id)) || null;
        db.characters.findById = async (id) => mockCharacters.find((c) => c.id === id) || null;
        db.characters.deleteById = async (id) => {
            callOrder.push(`deleteCharacterRow:${id}`);
            const idx = mockCharacters.findIndex((c) => c.id === id);
            if (idx !== -1) mockCharacters.splice(idx, 1);
            return true;
        };

        db.trash.insertIfAbsent = async ({ workflowId, userId, deletedBy = userId }) => {
            const existing = mockTrash.find((t) => t.workflow_id === workflowId);
            if (existing) {
                return null;
            }
            const row = {
                id: `trash-${mockTrash.length + 1}`,
                workflow_id: workflowId,
                user_id: userId,
                deleted_at: new Date().toISOString(),
                deleted_by: deletedBy ?? userId,
            };
            mockTrash.push(row);
            callOrder.push(`insertTrash:${workflowId}`);
            return row;
        };

        workflowService.mediaService.releaseWorkflowMedia = async ({ workflowId }) => {
            releaseWorkflowMediaCalls.push(workflowId);
            callOrder.push(`releaseWorkflowMedia:${workflowId}`);
            return {
                unlinkedMediaIds: [`media-${workflowId}`],
                deletedOrphanIds: [`media-${workflowId}`],
            };
        };
    });

    afterEach(() => {
        Object.assign(db.projects, originalDbProjects);
        Object.assign(db.workflows, originalDbWorkflows);
        Object.assign(db.elements, originalDbElements);
        Object.assign(db.characters, originalDbCharacters);
        Object.assign(db.trash, originalDbTrash);
        workflowService.mediaService.releaseWorkflowMedia = originalReleaseWorkflowMedia;
    });

    it("1 & 2 & 3. DELETE /api/workflows/workflows/:id and /api/workflows/:id move to Trash on 1st call, permanently delete on 2nd call (with rollback safety on failure), and return 404 on 3rd call", async () => {
        // 1st call via /api/workflows/workflows/:id -> move to Trash
        const res1 = await fetch(`${baseUrl}/api/workflows/workflows/wf-std-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(res1.status, 200);
        const body1 = await res1.json();
        assert.deepEqual(body1, {
            ok: true,
            deleted_workflow_id: "wf-std-A",
            deleted_media_count: 0,
            storage_failures: 0,
            trashed: true,
        });
        assert.equal(mockTrash.length, 1);
        assert.equal(mockTrash[0].workflow_id, "wf-std-A");
        assert.equal(mockTrash[0].user_id, "user-A");
        assert.equal(mockTrash[0].deleted_by, "user-A");
        assert.equal(mockWorkflows.some((w) => w.id === "wf-std-A"), true, "workflow row must stay untouched on 1st delete");
        assert.equal(releaseWorkflowMediaCalls.length, 0, "media must not be unlinked or reaped on 1st delete");

        // Simulate failure on 2nd call -> trash row and workflow row stay intact
        failDeleteWorkflowForId = "wf-std-A";
        const resFail = await fetch(`${baseUrl}/api/workflows/wf-std-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(resFail.status, 500);
        assert.equal(mockTrash.some((t) => t.workflow_id === "wf-std-A"), true, "trash row must stay when permanent delete fails");
        assert.equal(mockWorkflows.some((w) => w.id === "wf-std-A"), true, "workflow row must stay when permanent delete fails");
        failDeleteWorkflowForId = null;

        // 2nd call via alias /api/workflows/:id -> permanent delete
        const res2 = await fetch(`${baseUrl}/api/workflows/wf-std-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(res2.status, 200);
        const body2 = await res2.json();
        assert.deepEqual(body2, {
            ok: true,
            deleted_workflow_id: "wf-std-A",
            deleted_media_count: 1,
            storage_failures: 0,
        });
        assert.equal("trashed" in body2, false, "2nd delete response must omit trashed");
        assert.equal(mockWorkflows.some((w) => w.id === "wf-std-A"), false, "workflow row must be deleted on 2nd call");
        assert.equal(mockTrash.some((t) => t.workflow_id === "wf-std-A"), false, "trash row must cascade-delete on 2nd call");

        // 3rd call -> 404
        const res3 = await fetch(`${baseUrl}/api/workflows/workflows/wf-std-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(res3.status, 404);
        const body3 = await res3.json();
        assert.equal(body3.ok, false);
        assert.match(body3.message, /Workflow not found/i);
    });

    it("1 & 2 & 3. DELETE /api/v2/elements/:id moves container workflow to Trash on 1st call, permanently deletes workflow then element row on 2nd call, and returns 404 on 3rd call", async () => {
        // 1st call -> move container workflow wf-elem-A to Trash
        const res1 = await fetch(`${baseUrl}/api/v2/elements/elem-user-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(res1.status, 200);
        const body1 = await res1.json();
        assert.deepEqual(body1, {
            status: "success",
            deleted: true,
            id: "elem-user-A",
            trashed: true,
        });
        assert.equal(mockTrash.some((t) => t.workflow_id === "wf-elem-A"), true);
        assert.equal(mockElements.some((e) => e.id === "elem-user-A"), true, "element row must remain untouched on 1st delete");
        assert.equal(mockWorkflows.some((w) => w.id === "wf-elem-A"), true, "workflow row must remain untouched on 1st delete");
        assert.equal(releaseWorkflowMediaCalls.length, 0);

        // 2nd call -> permanent delete via elementService.deleteElement (workflow first, then element row)
        callOrder = [];
        const res2 = await fetch(`${baseUrl}/api/v2/elements/elem-user-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(res2.status, 200);
        const body2 = await res2.json();
        assert.deepEqual(body2, {
            status: "success",
            deleted: true,
            id: "elem-user-A",
        });
        assert.equal("trashed" in body2, false);
        assert.equal(mockWorkflows.some((w) => w.id === "wf-elem-A"), false);
        assert.equal(mockElements.some((e) => e.id === "elem-user-A"), false);
        assert.equal(mockTrash.some((t) => t.workflow_id === "wf-elem-A"), false);
        assert.deepEqual(callOrder, [
            "releaseWorkflowMedia:wf-elem-A",
            "deleteWorkflowRow:wf-elem-A",
            "deleteElementRow:elem-user-A",
        ]);

        // 3rd call -> 404
        const res3 = await fetch(`${baseUrl}/api/v2/elements/elem-user-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(res3.status, 404);
    });

    it("1 & 2 & 3. DELETE /api/characters/:characterId moves character workflow to Trash on 1st call, permanently deletes workflow then character row on 2nd call, and returns 404 on 3rd call", async () => {
        // 1st call -> move wf-char-A to Trash
        const res1 = await fetch(`${baseUrl}/api/characters/wf-char-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(res1.status, 200);
        const body1 = await res1.json();
        assert.deepEqual(body1, {
            ok: true,
            workflowId: "wf-char-A",
            unlinkedMediaCount: 0,
            deletedOrphanCount: 0,
            deletedMediaCount: 0,
            storageFailures: [],
            trashed: true,
        });
        assert.equal(mockTrash.some((t) => t.workflow_id === "wf-char-A"), true);
        assert.equal(mockCharacters.some((c) => c.id === "wf-char-A"), true, "character row must remain untouched on 1st delete");
        assert.equal(mockWorkflows.some((w) => w.id === "wf-char-A"), true, "workflow row must remain untouched on 1st delete");
        assert.equal(releaseWorkflowMediaCalls.length, 0);

        // 2nd call -> permanent delete via characterService.deleteCharacter (workflow first, then character row)
        callOrder = [];
        const res2 = await fetch(`${baseUrl}/api/characters/wf-char-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(res2.status, 200);
        const body2 = await res2.json();
        assert.deepEqual(body2, {
            ok: true,
            workflowId: "wf-char-A",
            unlinkedMediaCount: 1,
            deletedOrphanCount: 1,
            deletedMediaCount: 1,
            storageFailures: [],
        });
        assert.equal("trashed" in body2, false);
        assert.equal(mockWorkflows.some((w) => w.id === "wf-char-A"), false);
        assert.equal(mockCharacters.some((c) => c.id === "wf-char-A"), false);
        assert.equal(mockTrash.some((t) => t.workflow_id === "wf-char-A"), false);
        assert.deepEqual(callOrder, [
            "releaseWorkflowMedia:wf-char-A",
            "deleteWorkflowRow:wf-char-A",
            "deleteCharacterRow:wf-char-A",
        ]);

        // 3rd call -> 404
        const res3 = await fetch(`${baseUrl}/api/characters/wf-char-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(res3.status, 404);
    });

    it("4. Cross-tenant delete returns 404 (never 403) across all 4 delete endpoints for both active and already-trashed items without mutating state", async () => {
        // Pre-trash wf-std-A-2 as user-A
        await db.trash.insertIfAbsent({ workflowId: "wf-std-A-2", userId: "user-A" });
        callOrder = [];

        // User B on User A's active workflow
        const wfRes = await fetch(`${baseUrl}/api/workflows/workflows/wf-std-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-B" },
        });
        assert.equal(wfRes.status, 404);

        // User B on User A's already-trashed workflow
        const wfTrashedRes = await fetch(`${baseUrl}/api/workflows/wf-std-A-2`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-B" },
        });
        assert.equal(wfTrashedRes.status, 404);

        // User B on User A's element
        const elemRes = await fetch(`${baseUrl}/api/v2/elements/elem-user-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-B" },
        });
        assert.equal(elemRes.status, 404);

        // User B on User A's character
        const charRes = await fetch(`${baseUrl}/api/characters/wf-char-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-B" },
        });
        assert.equal(charRes.status, 404);

        assert.deepEqual(callOrder, [], "no trash insert or permanent delete calls may occur on cross-tenant 404");
        assert.equal(mockTrash.length, 1, "only the pre-existing trash row for wf-std-A-2 remains");
    });

    it("5. Bulk delete (DELETE /api/workflows/workflows) handles mixed [notTrashed, alreadyTrashed] states and rejects mixed-owner batches upfront with 404", async () => {
        // Pre-trash wf-std-A-2 so batch has [wf-std-A (not trashed), wf-std-A-2 (already trashed)]
        await db.trash.insertIfAbsent({ workflowId: "wf-std-A-2", userId: "user-A" });

        // Mixed-owner batch [wf-std-A, wf-std-B] -> fails upfront with 404 and touches nothing
        const crossRes = await fetch(`${baseUrl}/api/workflows/workflows`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer token-user-A",
            },
            body: JSON.stringify({ workflow_ids: ["wf-std-A", "wf-std-B"] }),
        });
        assert.equal(crossRes.status, 404);
        assert.equal(mockTrash.some((t) => t.workflow_id === "wf-std-A"), false, "wf-std-A must not be trashed when bulk ownership check fails");
        assert.equal(mockWorkflows.some((w) => w.id === "wf-std-A-2"), true, "wf-std-A-2 must not be deleted when bulk ownership check fails");

        // Legitimate mixed-state batch [wf-std-A, wf-std-A-2]
        const bulkRes = await fetch(`${baseUrl}/api/workflows/workflows`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer token-user-A",
            },
            body: JSON.stringify({ workflow_ids: ["wf-std-A", "wf-std-A-2"] }),
        });
        assert.equal(bulkRes.status, 200);
        const bulkBody = await bulkRes.json();
        assert.equal(bulkBody.ok, true);
        assert.deepEqual(bulkBody.workflow_ids, ["wf-std-A", "wf-std-A-2"]);
        assert.equal(bulkBody.count, 2);
        assert.equal(bulkBody.trashed, true);
        assert.equal(bulkBody.results.length, 2);

        // First item was not in Trash -> moved to Trash (trashed: true)
        assert.equal(bulkBody.results[0].id, "wf-std-A");
        assert.equal(bulkBody.results[0].workflowId, "wf-std-A");
        assert.equal(bulkBody.results[0].status, "fulfilled");
        assert.equal(bulkBody.results[0].trashed, true);
        assert.equal(mockTrash.some((t) => t.workflow_id === "wf-std-A"), true);
        assert.equal(mockWorkflows.some((w) => w.id === "wf-std-A"), true);

        // Second item was already in Trash -> permanently deleted (no trashed key)
        assert.equal(bulkBody.results[1].id, "wf-std-A-2");
        assert.equal(bulkBody.results[1].workflowId, "wf-std-A-2");
        assert.equal(bulkBody.results[1].status, "fulfilled");
        assert.equal("trashed" in bulkBody.results[1], false);
        assert.equal(mockWorkflows.some((w) => w.id === "wf-std-A-2"), false);
        assert.equal(mockTrash.some((t) => t.workflow_id === "wf-std-A-2"), false);
    });

    it("6. Orphan Element (workflow_id = null) and Orphan Character (workflow_id = null) permanently delete on first call without inserting into public.trash", async () => {
        callOrder = [];

        // Orphan Element delete
        const elemRes = await fetch(`${baseUrl}/api/v2/elements/elem-orphan-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(elemRes.status, 200);
        const elemBody = await elemRes.json();
        assert.deepEqual(elemBody, {
            status: "success",
            deleted: true,
            id: "elem-orphan-A",
        });
        assert.equal("trashed" in elemBody, false);
        assert.equal(mockElements.some((e) => e.id === "elem-orphan-A"), false);

        // Orphan Character delete
        const charRes = await fetch(`${baseUrl}/api/characters/char-orphan-A`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(charRes.status, 200);
        const charBody = await charRes.json();
        assert.deepEqual(charBody, {
            ok: true,
            workflowId: "char-orphan-A",
            unlinkedMediaCount: 0,
            deletedOrphanCount: 0,
            deletedMediaCount: 0,
            storageFailures: [],
        });
        assert.equal("trashed" in charBody, false);
        assert.equal(mockCharacters.some((c) => c.id === "char-orphan-A"), false);

        assert.equal(mockTrash.length, 0, "orphan deletes must never insert into public.trash");
        assert.equal(releaseWorkflowMediaCalls.length, 0, "orphan deletes must not invoke workflowService.deleteWorkflow");
        assert.deepEqual(callOrder, [
            "deleteElementRow:elem-orphan-A",
            "deleteCharacterRow:char-orphan-A",
        ]);
    });

    it("7. Explicit trash=false parameter on first delete bypasses public.trash and permanently deletes workflows, elements, characters, and bulk workflow batches", async () => {
        callOrder = [];

        // Cross-tenant with ?trash=false -> 404 without mutating state
        const crossRes = await fetch(`${baseUrl}/api/workflows/workflows/wf-std-A?trash=false`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-B" },
        });
        assert.equal(crossRes.status, 404);
        assert.deepEqual(callOrder, []);

        // 1. Single workflow delete on 1st call with ?trash=false -> direct permanent delete
        const wfRes = await fetch(`${baseUrl}/api/workflows/workflows/wf-std-A?trash=false`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(wfRes.status, 200);
        const wfBody = await wfRes.json();
        assert.deepEqual(wfBody, {
            ok: true,
            deleted_workflow_id: "wf-std-A",
            deleted_media_count: 1,
            storage_failures: 0,
        });
        assert.equal("trashed" in wfBody, false);
        assert.equal(mockTrash.length, 0, "trash=false must not insert into public.trash");
        assert.equal(mockWorkflows.some((w) => w.id === "wf-std-A"), false);

        // 2. Element delete on 1st call with ?trash=false -> direct permanent delete
        const elemRes = await fetch(`${baseUrl}/api/v2/elements/elem-user-A?trash=false`, {
            method: "DELETE",
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(elemRes.status, 200);
        const elemBody = await elemRes.json();
        assert.deepEqual(elemBody, {
            status: "success",
            deleted: true,
            id: "elem-user-A",
        });
        assert.equal("trashed" in elemBody, false);
        assert.equal(mockTrash.length, 0);
        assert.equal(mockElements.some((e) => e.id === "elem-user-A"), false);
        assert.equal(mockWorkflows.some((w) => w.id === "wf-elem-A"), false);

        // 3. Character delete on 1st call with body { trash: false } -> direct permanent delete
        const charRes = await fetch(`${baseUrl}/api/characters/wf-char-A`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer token-user-A",
            },
            body: JSON.stringify({ trash: false }),
        });
        assert.equal(charRes.status, 200);
        const charBody = await charRes.json();
        assert.equal(charBody.ok, true);
        assert.equal("trashed" in charBody, false);
        assert.equal(charBody.deletedMediaCount, 1);
        assert.equal(mockTrash.length, 0);
        assert.equal(mockCharacters.some((c) => c.id === "wf-char-A"), false);
        assert.equal(mockWorkflows.some((w) => w.id === "wf-char-A"), false);

        // 4. Bulk workflow delete on 1st call with body { workflow_ids: ["wf-std-A-2"], trash: false } -> direct permanent delete
        const bulkRes = await fetch(`${baseUrl}/api/workflows/workflows`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer token-user-A",
            },
            body: JSON.stringify({ workflow_ids: ["wf-std-A-2"], trash: false }),
        });
        assert.equal(bulkRes.status, 200);
        const bulkBody = await bulkRes.json();
        assert.equal(bulkBody.ok, true);
        assert.equal("trashed" in bulkBody, false);
        assert.equal("trashed" in bulkBody.results[0], false);
        assert.equal(mockTrash.length, 0);
        assert.equal(mockWorkflows.some((w) => w.id === "wf-std-A-2"), false);
    });
});
}

// ─── Folder Deletion -> Trash & Restore-at-Root Integration ───
{
describe("Folder Deletion -> Idempotent Trash, Unlink, and Restore at Project Root", () => {
    it("TrashRepository.insertManyIfAbsent bulk-upserts with ignoreDuplicates and preserves existing deleted_at", async () => {
        const repo = new TrashRepository();
        const existingRow = {
            id: "t-old",
            workflow_id: "wf-already-trashed",
            user_id: "user-1",
            deleted_by: "user-1",
            deleted_at: "2026-10-01T00:00:00.000Z",
        };
        const tableRows = [existingRow];
        const recordedOpts = [];

        repo.client = () => ({
            from: (table) => {
                assert.equal(table, "trash");
                return {
                    upsert: (rows, opts) => {
                        recordedOpts.push(opts);
                        const inserted = [];
                        for (const row of rows) {
                            if (!tableRows.some((r) => r.workflow_id === row.workflow_id)) {
                                const created = {
                                    id: `t-${row.workflow_id}`,
                                    ...row,
                                    deleted_at: "2026-11-21T01:00:00.000Z",
                                };
                                tableRows.push(created);
                                inserted.push(created);
                            }
                        }
                        return {
                            select: async () => ({ data: inserted, error: null }),
                        };
                    },
                };
            },
        });

        const empty = await repo.insertManyIfAbsent({ workflowIds: [], userId: "user-1" });
        assert.deepEqual(empty, []);
        assert.equal(recordedOpts.length, 0);

        const inserted = await repo.insertManyIfAbsent({
            workflowIds: ["wf-already-trashed", "wf-new-1", "wf-new-1"],
            userId: "user-1",
        });

        assert.deepEqual(recordedOpts, [{ onConflict: "workflow_id", ignoreDuplicates: true }]);
        assert.equal(inserted.length, 1);
        assert.equal(inserted[0].workflow_id, "wf-new-1");
        assert.equal(tableRows.length, 2);
        assert.equal(
            tableRows.find((r) => r.workflow_id === "wf-already-trashed").deleted_at,
            "2026-10-01T00:00:00.000Z"
        );
    });

    it("Deleting a folder tree moves active media/character/element workflows to Trash, preserves already-trashed workflows, unlinks folder_id, deletes folders deepest-first, and restores cleanly to project root", async () => {
        const earlierDeletedAt = "2026-10-15T09:30:00.000Z";
        const foldersTable = [
            { id: "f-A", project_id: "proj-1", user_id: "user-1", parent_id: null, name: "Root A", position: 0 },
            { id: "f-B", project_id: "proj-1", user_id: "user-1", parent_id: "f-A", name: "Child B", position: 0 },
            { id: "f-C", project_id: "proj-1", user_id: "user-1", parent_id: "f-B", name: "Leaf C", position: 0 },
            { id: "f-keep", project_id: "proj-1", user_id: "user-1", parent_id: null, name: "Keep", position: 1 },
        ];
        const workflowsTable = [
            { id: "wf-media-A", project_id: "proj-1", folder_id: "f-A", user_id: "user-1", workflow_type: "GENERATION" },
            { id: "wf-char-B", project_id: "proj-1", folder_id: "f-B", user_id: "user-1", workflow_type: "CHARACTER" },
            { id: "wf-elem-C", project_id: "proj-1", folder_id: "f-C", user_id: "user-1", workflow_type: "ELEMENT_SHEET" },
            { id: "wf-already-trashed", project_id: "proj-1", folder_id: "f-B", user_id: "user-1", workflow_type: "UPLOAD" },
            { id: "wf-untouched", project_id: "proj-1", folder_id: "f-keep", user_id: "user-1", workflow_type: "GENERATION" },
        ];
        const mediaTable = [
            { id: "m-1", project_id: "proj-1", url: "https://cdn.example/1.png" },
            { id: "m-2", project_id: "proj-1", url: "https://cdn.example/2.png" },
        ];
        const trashTable = [
            {
                id: "t-existing",
                workflow_id: "wf-already-trashed",
                user_id: "user-1",
                deleted_by: "user-1",
                deleted_at: earlierDeletedAt,
            },
        ];
        const deletedFoldersOrder = [];

        const trashRepo = new TrashRepository();
        trashRepo.client = () => ({
            from: (table) => {
                assert.equal(table, "trash");
                return {
                    upsert: (rows, opts) => {
                        assert.equal(opts.onConflict, "workflow_id");
                        assert.equal(opts.ignoreDuplicates, true);
                        const list = Array.isArray(rows) ? rows : [rows];
                        const inserted = [];
                        for (const row of list) {
                            if (!trashTable.some((t) => t.workflow_id === row.workflow_id)) {
                                const created = {
                                    id: `t-${row.workflow_id}`,
                                    ...row,
                                    deleted_at: "2026-11-21T02:00:00.000Z",
                                };
                                trashTable.push(created);
                                inserted.push(created);
                            }
                        }
                        return { select: async () => ({ data: inserted, error: null }) };
                    },
                    delete: () => {
                        const filters = {};
                        const chain = {
                            eq: (col, val) => {
                                filters[col] = val;
                                return chain;
                            },
                            select: async () => {
                                const removed = [];
                                for (let i = trashTable.length - 1; i >= 0; i -= 1) {
                                    const row = trashTable[i];
                                    const matches = Object.entries(filters).every(([k, v]) => row[k] === v);
                                    if (matches) {
                                        removed.push(row);
                                        trashTable.splice(i, 1);
                                    }
                                }
                                return { data: removed, error: null };
                            },
                        };
                        return chain;
                    },
                };
            },
        });

        const wfRepo = new WorkflowRepository();
        wfRepo.client = () => ({
            from: (table) => {
                assert.equal(table, "workflow");
                return {
                    select: () => {
                        const filters = {};
                        const chain = {
                            eq: (col, val) => {
                                filters[col] = val;
                                return chain;
                            },
                            in: (col, vals) => {
                                filters[col] = vals;
                                return chain;
                            },
                            then: (resolve) => {
                                const rows = workflowsTable
                                    .filter((w) => {
                                        if (filters.project_id && w.project_id !== filters.project_id) return false;
                                        if (filters.folder_id && !filters.folder_id.includes(w.folder_id)) return false;
                                        if (filters.id && !filters.id.includes(w.id)) return false;
                                        return true;
                                    })
                                    .map((w) => ({
                                        ...w,
                                        project: { user_id: w.user_id },
                                    }));
                                resolve({ data: rows, error: null });
                            },
                        };
                        return chain;
                    },
                    update: (patch) => {
                        const filters = {};
                        const chain = {
                            eq: (col, val) => {
                                filters[col] = val;
                                return chain;
                            },
                            in: (col, vals) => {
                                filters[col] = vals;
                                return chain;
                            },
                            select: async () => {
                                const updated = [];
                                for (const w of workflowsTable) {
                                    if (filters.project_id && w.project_id !== filters.project_id) continue;
                                    if (filters.id && !filters.id.includes(w.id)) continue;
                                    if (filters.folder_id && !filters.folder_id.includes(w.folder_id)) continue;
                                    Object.assign(w, patch);
                                    updated.push({ id: w.id });
                                }
                                return { data: updated, error: null };
                            },
                        };
                        return chain;
                    },
                };
            },
        });

        const folderRepo = {
            findOwned: async (id, userId) => foldersTable.find((f) => f.id === id && f.user_id === userId) || null,
            listByProject: async (projectId, userId) =>
                foldersTable.filter((f) => f.project_id === projectId && f.user_id === userId),
            deleteOwned: async (id, userId) => {
                // Enforce workflow_folder_same_project_fk (NO ACTION) in test double!
                const stillReferencedByWorkflow = workflowsTable.some((w) => w.folder_id === id);
                if (stillReferencedByWorkflow) {
                    const fkErr = new Error("violates foreign key constraint workflow_folder_same_project_fk");
                    fkErr.code = "23503";
                    throw fkErr;
                }
                const stillReferencedByChild = foldersTable.some((f) => f.parent_id === id);
                if (stillReferencedByChild) {
                    const fkErr = new Error("violates foreign key constraint folders_parent_same_project_fk");
                    fkErr.code = "23503";
                    throw fkErr;
                }
                const idx = foldersTable.findIndex((f) => f.id === id && f.user_id === userId);
                if (idx === -1) return false;
                deletedFoldersOrder.push(id);
                foldersTable.splice(idx, 1);
                return true;
            },
        };

        const wfService = new WorkflowService({
            db: { workflows: wfRepo, workflowMedia: { findByMedia: async () => [] } },
            storageService: {},
            mediaUploadService: { discard: async () => ({}) },
        });
        let deleteWorkflowCalled = false;
        wfService.deleteWorkflow = async () => {
            deleteWorkflowCalled = true;
            throw new Error("deleteWorkflow must NOT be called during folder deletion");
        };

        const folderServiceInst = new FolderService({
            folderRepo,
            trashRepo,
            workflowService: wfService,
        });

        const trashServiceInst = new TrashService({
            db: { trash: trashRepo, workflows: wfRepo },
            workflowService: wfService,
            elementService: {},
            characterService: {},
        });

        // 1. Delete root folder f-A (tree: f-A -> f-B -> f-C)
        const removed = await folderServiceInst.remove({ folderId: "f-A", userId: "user-1" });
        assert.equal(removed, true);
        assert.equal(deleteWorkflowCalled, false, "Folder deletion must never permanently delete workflows");

        // Folders deleted deepest-first without hitting FK 23503; sibling folder kept
        assert.deepEqual(deletedFoldersOrder, ["f-C", "f-B", "f-A"]);
        assert.deepEqual(foldersTable.map((f) => f.id), ["f-keep"]);

        // All workflows in tree are in Trash, with already-trashed deleted_at preserved
        assert.deepEqual(
            trashTable.map((t) => t.workflow_id).sort(),
            ["wf-already-trashed", "wf-char-B", "wf-elem-C", "wf-media-A"]
        );
        assert.equal(
            trashTable.find((t) => t.workflow_id === "wf-already-trashed").deleted_at,
            earlierDeletedAt,
            "Already-trashed workflow must preserve its original deleted_at"
        );

        // All workflows in tree are preserved in workflow table with folder_id = null; media untouched
        assert.equal(workflowsTable.length, 5);
        assert.equal(mediaTable.length, 2);
        for (const wfId of ["wf-media-A", "wf-char-B", "wf-elem-C", "wf-already-trashed"]) {
            assert.equal(
                workflowsTable.find((w) => w.id === wfId).folder_id,
                null,
                `${wfId} must be unlinked to project root (folder_id = null)`
            );
        }
        assert.equal(workflowsTable.find((w) => w.id === "wf-untouched").folder_id, "f-keep");

        // 2. Restore a trashed workflow whose original folder was deleted -> restores cleanly at project root
        const restoreRes = await trashServiceInst.restore({ workflowId: "wf-media-A", userId: "user-1" });
        assert.deepEqual(restoreRes, { workflow_id: "wf-media-A", restored: true });
        assert.equal(trashTable.some((t) => t.workflow_id === "wf-media-A"), false);
        assert.equal(workflowsTable.find((w) => w.id === "wf-media-A").folder_id, null);
        assert.equal(foldersTable.some((f) => f.id === "f-A"), false, "Restoring must not recreate deleted folder");
    });
});
}

// ─── Source: explicitIntentBulkDelete.test.js ───
{
describe("ADR-0002: Explicit-Intent Bulk Delete (POST /api/workspace/bulk-delete & POST /api/trash/delete)", () => {
    it("TrashRepository.findTrashedWorkflowIds enforces userId scoping and supports candidate filtering", async () => {
        const repo = new TrashRepository();
        const rows = [
            { workflow_id: "wf-1", user_id: "user-1" },
            { workflow_id: "wf-2", user_id: "user-1" },
            { workflow_id: "wf-3", user_id: "user-2" },
        ];

        repo.client = () => ({
            from: (table) => {
                assert.equal(table, "trash");
                const filters = {};
                const chain = {
                    select: () => chain,
                    eq: (col, val) => {
                        filters[col] = val;
                        return chain;
                    },
                    in: (col, vals) => {
                        filters[col] = vals;
                        return chain;
                    },
                    then: (resolve) => {
                        const matched = rows.filter((r) => {
                            if (filters.user_id && r.user_id !== filters.user_id) return false;
                            if (filters.workflow_id && !filters.workflow_id.includes(r.workflow_id)) return false;
                            return true;
                        });
                        resolve({ data: matched, error: null });
                    },
                };
                return chain;
            },
        });

        assert.deepEqual(await repo.findTrashedWorkflowIds({}), []);
        assert.deepEqual(await repo.findTrashedWorkflowIds({ userId: "user-1", workflowIds: [] }), []);
        assert.deepEqual(
            (await repo.findTrashedWorkflowIds({ userId: "user-1" })).sort(),
            ["wf-1", "wf-2"]
        );
        assert.deepEqual(
            await repo.findTrashedWorkflowIds({
                userId: "user-1",
                workflowIds: ["workflows/wf-1", "wf-3", "wf-missing"],
            }),
            ["wf-1"]
        );
    });

    describe("HTTP + Service end-to-end tests for /api/workspace/bulk-delete and /api/trash/delete", () => {
        let server;
        let baseUrl;
        let origGetUser;

        const USER_A = "user-bulk-A";
        const USER_B = "user-bulk-B";

        let state;
        let fakeTrashService;
        let origBulkConcurrencyEnv;

        function buildHarnessState() {
            const earlierDeletedAt = "2026-10-01T00:00:00.000Z";
            const projects = [
                { id: "proj-A1", user_id: USER_A, project_name: "A Project 1" },
                { id: "proj-A2", user_id: USER_A, project_name: "A Project 2" },
                { id: "proj-B1", user_id: USER_B, project_name: "B Project 1" },
            ];
            const folders = [
                { id: "f-root", project_id: "proj-A1", user_id: USER_A, parent_id: null, name: "Root" },
                { id: "f-child", project_id: "proj-A1", user_id: USER_A, parent_id: "f-root", name: "Child" },
                { id: "f-grand", project_id: "proj-A1", user_id: USER_A, parent_id: "f-child", name: "Grand" },
                { id: "f-sibling", project_id: "proj-A1", user_id: USER_A, parent_id: null, name: "Sibling" },
                { id: "f-p2", project_id: "proj-A2", user_id: USER_A, parent_id: null, name: "Proj2 Folder" },
                { id: "f-foreign", project_id: "proj-B1", user_id: USER_B, parent_id: null, name: "Foreign" },
            ];
            const workflows = [
                { id: "wf-in-root", project_id: "proj-A1", user_id: USER_A, folder_id: "f-root", workflow_type: "GENERATION" },
                { id: "wf-in-grand", project_id: "proj-A1", user_id: USER_A, folder_id: "f-grand", workflow_type: "GENERATION" },
                { id: "wf-already-trashed-in-folder", project_id: "proj-A1", user_id: USER_A, folder_id: "f-child", workflow_type: "GENERATION" },
                { id: "wf-in-p2-folder", project_id: "proj-A2", user_id: USER_A, folder_id: "f-p2", workflow_type: "GENERATION" },
                { id: "wf-explicit", project_id: "proj-A1", user_id: USER_A, folder_id: null, workflow_type: "UPLOAD" },
                { id: "wf-explicit-already-trashed", project_id: "proj-A1", user_id: USER_A, folder_id: null, workflow_type: "UPLOAD" },
                { id: "wf-char-backed", project_id: "proj-A1", user_id: USER_A, folder_id: null, workflow_type: "CHARACTER" },
                { id: "wf-elem-backed", project_id: "proj-A1", user_id: USER_A, folder_id: null, workflow_type: "ELEMENT_SHEET" },
                { id: "wf-p2-trashed", project_id: "proj-A2", user_id: USER_A, folder_id: null, workflow_type: "GENERATION" },
                { id: "wf-untouched", project_id: "proj-A1", user_id: USER_A, folder_id: "f-sibling", workflow_type: "GENERATION" },
                { id: "wf-foreign", project_id: "proj-B1", user_id: USER_B, folder_id: "f-foreign", workflow_type: "GENERATION" },
            ];
            const characters = [
                { id: "char-backed-1", workflow_id: "wf-char-backed", user_id: USER_A, project_id: "proj-A1", name: "Nova" },
                { id: "char-orphan-1", workflow_id: null, user_id: USER_A, project_id: "proj-A1", name: "Orphan Char" },
                { id: "char-foreign", workflow_id: "wf-foreign", user_id: USER_B, project_id: "proj-B1", name: "Foreign Char" },
            ];
            const elements = [
                { id: "elem-backed-1", workflow_id: "wf-elem-backed", user_id: USER_A, name: "Relic" },
                { id: "elem-orphan-1", workflow_id: null, user_id: USER_A, name: "Orphan Relic" },
                { id: "elem-foreign", workflow_id: "wf-foreign", user_id: USER_B, name: "Foreign Relic" },
            ];
            const trash = [
                { id: "t-1", workflow_id: "wf-already-trashed-in-folder", user_id: USER_A, deleted_by: USER_A, deleted_at: earlierDeletedAt },
                { id: "t-2", workflow_id: "wf-explicit-already-trashed", user_id: USER_A, deleted_by: USER_A, deleted_at: earlierDeletedAt },
                { id: "t-3", workflow_id: "wf-p2-trashed", user_id: USER_A, deleted_by: USER_A, deleted_at: earlierDeletedAt },
                { id: "t-foreign", workflow_id: "wf-foreign", user_id: USER_B, deleted_by: USER_B, deleted_at: earlierDeletedAt },
            ];

            const deletedFoldersOrder = [];
            const permanentlyDeletedWorkflows = [];
            const deletedOrphanCharacters = [];
            const deletedOrphanElements = [];
            const listByProjectCalls = [];
            let requestDeleteCalls = 0;

            const fakeDb = {
                projects: {
                    findByUser: async (uid, pid) => projects.filter((p) => p.user_id === uid && (!pid || p.id === pid)),
                    findById: async (pid) => projects.find((p) => p.id === pid) || null,
                },
                folders: {
                    findOwned: async (id, uid) => folders.find((f) => f.id === id && f.user_id === uid) || null,
                    listByProject: async (pid, uid) => {
                        listByProjectCalls.push(pid);
                        return folders.filter((f) => f.project_id === pid && f.user_id === uid);
                    },
                    deleteOwned: async (id, uid) => {
                        if (workflows.some((w) => w.folder_id === id)) {
                            const err = new Error("FK violation: workflow still references folder");
                            err.code = "23503";
                            throw err;
                        }
                        if (folders.some((f) => f.parent_id === id)) {
                            const err = new Error("FK violation: child folder still references parent");
                            err.code = "23503";
                            throw err;
                        }
                        const idx = folders.findIndex((f) => f.id === id && f.user_id === uid);
                        if (idx === -1) return false;
                        deletedFoldersOrder.push(id);
                        folders.splice(idx, 1);
                        return true;
                    },
                },
                workflows: {
                    findById: async (id) => workflows.find((w) => w.id === id) || null,
                    getWorkflow: async (id) => workflows.find((w) => w.id === id) || null,
                    findByProject: async (pid, { partitioned = false } = {}) => {
                        const rows = workflows.filter((w) => w.project_id === pid);
                        if (!partitioned) return rows;
                        const trashedIds = new Set(trash.map((t) => t.workflow_id));
                        return {
                            active: rows.filter((w) => !trashedIds.has(w.id)),
                            trashed: rows.filter((w) => trashedIds.has(w.id)),
                        };
                    },
                },
                characters: {
                    findByCharacterId: async (id) =>
                        characters.find((c) => c.id === id || c.workflow_id === id) || null,
                    findById: async (id) => characters.find((c) => c.id === id) || null,
                },
                elements: {
                    resolveRecord: async (id) =>
                        elements.find((e) => e.id === id || e.workflow_id === id) || null,
                    findById: async (id) => elements.find((e) => e.id === id) || null,
                    findByWorkflowId: async (wfId) => elements.find((e) => e.workflow_id === wfId) || null,
                },
                trash: {
                    insertManyIfAbsent: async ({ workflowIds = [], userId, deletedBy = userId }) => {
                        const inserted = [];
                        for (const wfId of [...new Set(workflowIds)]) {
                            if (!trash.some((t) => t.workflow_id === wfId)) {
                                const row = {
                                    id: `t-${wfId}`,
                                    workflow_id: wfId,
                                    user_id: userId,
                                    deleted_by: deletedBy,
                                    deleted_at: "2026-11-21T03:00:00.000Z",
                                };
                                trash.push(row);
                                inserted.push(row);
                            }
                        }
                        return inserted;
                    },
                    findTrashedWorkflowIds: async ({ userId, workflowIds = null } = {}) => {
                        if (!userId) return [];
                        return trash
                            .filter((t) => t.user_id === userId && (!workflowIds || workflowIds.includes(t.workflow_id)))
                            .map((t) => t.workflow_id);
                    },
                },
            };

            const mockWorkflowService = {
                authService: {
                    verifyWorkflowOwnership: async (wfId, uid) => {
                        const wf = workflows.find((w) => w.id === wfId);
                        return Boolean(wf && wf.user_id === uid);
                    },
                    verifyWorkflowOwnershipBulk: async (wfIds, uid) => {
                        const clean = [...new Set(wfIds)];
                        const owned = clean.filter((id) => workflows.find((w) => w.id === id)?.user_id === uid);
                        return owned.length === clean.length ? owned : null;
                    },
                },
                listOwnedWorkflowIdsInFolders: async ({ folderIds, userId, projectId }) => {
                    const matched = workflows.filter(
                        (w) => w.project_id === projectId && folderIds.includes(w.folder_id)
                    );
                    if (matched.some((w) => w.user_id !== userId)) {
                        const err = new Error("Workflow not found");
                        err.statusCode = 404;
                        throw err;
                    }
                    return matched.map((w) => w.id);
                },
                unlinkWorkflowsFromFolders: async ({ workflowIds, folderIds, projectId }) => {
                    const unlinked = [];
                    for (const w of workflows) {
                        if (
                            w.project_id === projectId &&
                            workflowIds.includes(w.id) &&
                            folderIds.includes(w.folder_id)
                        ) {
                            w.folder_id = null;
                            unlinked.push(w.id);
                        }
                    }
                    return { workflow_ids: unlinked, count: unlinked.length };
                },
                deleteWorkflow: async ({ workflowId, userId }) => {
                    permanentlyDeletedWorkflows.push({ owner: "workflow", workflowId, userId });
                    const wfIdx = workflows.findIndex((w) => w.id === workflowId);
                    if (wfIdx !== -1) workflows.splice(wfIdx, 1);
                    const tIdx = trash.findIndex((t) => t.workflow_id === workflowId);
                    if (tIdx !== -1) trash.splice(tIdx, 1);
                    return {
                        workflowId,
                        deletedMediaCount: 2,
                        storageFailures: workflowId === "wf-explicit-already-trashed" ? ["user/a/fail.png"] : [],
                    };
                },
            };

            const mockElementService = {
                deleteElement: async (id, userId) => {
                    const idx = elements.findIndex((e) => e.id === id);
                    const rec = idx !== -1 ? elements[idx] : null;
                    if (idx !== -1) elements.splice(idx, 1);
                    if (rec?.workflow_id) {
                        permanentlyDeletedWorkflows.push({ owner: "element", id, workflowId: rec.workflow_id, userId });
                        const wfIdx = workflows.findIndex((w) => w.id === rec.workflow_id);
                        if (wfIdx !== -1) workflows.splice(wfIdx, 1);
                        const tIdx = trash.findIndex((t) => t.workflow_id === rec.workflow_id);
                        if (tIdx !== -1) trash.splice(tIdx, 1);
                        return { workflowId: rec.workflow_id, deletedMediaCount: 3, storageFailures: [] };
                    }
                    deletedOrphanElements.push(id);
                    return { workflowId: id, deletedMediaCount: 0, storageFailures: [] };
                },
            };

            const mockCharacterService = {
                deleteCharacter: async ({ characterId, userId }) => {
                    const idx = characters.findIndex((c) => c.id === characterId || c.workflow_id === characterId);
                    const rec = idx !== -1 ? characters[idx] : null;
                    if (idx !== -1) characters.splice(idx, 1);
                    if (rec?.workflow_id) {
                        permanentlyDeletedWorkflows.push({ owner: "character", characterId, workflowId: rec.workflow_id, userId });
                        const wfIdx = workflows.findIndex((w) => w.id === rec.workflow_id);
                        if (wfIdx !== -1) workflows.splice(wfIdx, 1);
                        const tIdx = trash.findIndex((t) => t.workflow_id === rec.workflow_id);
                        if (tIdx !== -1) trash.splice(tIdx, 1);
                        return { workflowId: rec.workflow_id, deletedMediaCount: 4, storageFailures: [] };
                    }
                    deletedOrphanCharacters.push(rec?.id || characterId);
                    return { workflowId: characterId, deletedMediaCount: 0, storageFailures: [] };
                },
            };

            const svc = new TrashService({
                db: fakeDb,
                workflowService: mockWorkflowService,
                elementService: mockElementService,
                characterService: mockCharacterService,
            });
            const origReqDel = svc.requestDelete.bind(svc);
            svc.requestDelete = async (...args) => {
                requestDeleteCalls += 1;
                return origReqDel(...args);
            };

            return {
                earlierDeletedAt,
                projects,
                folders,
                workflows,
                characters,
                elements,
                trash,
                deletedFoldersOrder,
                permanentlyDeletedWorkflows,
                deletedOrphanCharacters,
                deletedOrphanElements,
                listByProjectCalls,
                getRequestDeleteCalls: () => requestDeleteCalls,
                fakeDb,
                svc,
            };
        }

        before(async () => {
            origGetUser = supabase.auth.getUser;
            supabase.auth.getUser = async (token) => {
                if (token === "token-user-a") return { data: { user: { id: USER_A } }, error: null };
                if (token === "token-user-b") return { data: { user: { id: USER_B } }, error: null };
                return { data: { user: null }, error: new Error("Invalid token") };
            };

            const app = express();
            app.use(express.json());
            app.use("/api", apiRouter);
            app.use((err, req, res, _next) => {
                res.status(err.statusCode || 500).json({ ok: false, message: err.message });
            });

            server = http.createServer(app);
            await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
            baseUrl = `http://127.0.0.1:${server.address().port}`;
        });

        after(async () => {
            supabase.auth.getUser = origGetUser;
            configureWorkspace({ trashService: containerTrashService });
            setDb(db);
            resetLimitersForTest();
            if (server) {
                await new Promise((resolve) => server.close(resolve));
            }
        });

        beforeEach(() => {
            origBulkConcurrencyEnv = process.env.BULK_DELETE_CONCURRENCY;
            resetLimitersForTest();
            state = buildHarnessState();
            fakeTrashService = state.svc;
            configureWorkspace({ trashService: fakeTrashService });
            setDb(state.fakeDb);
        });

        afterEach(() => {
            if (origBulkConcurrencyEnv === undefined) {
                delete process.env.BULK_DELETE_CONCURRENCY;
            } else {
                process.env.BULK_DELETE_CONCURRENCY = origBulkConcurrencyEnv;
            }
            configureWorkspace({ trashService: containerTrashService });
            setDb(db);
        });

        const postAsA = (path, body) =>
            fetch(`${baseUrl}${path}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer token-user-a",
                },
                body: JSON.stringify(body),
            });

        it("POST /api/workspace/bulk-delete handles mixed folders (nested + overlapping + cross-project), workflows, characters, elements, already-trashed preservation, and orphan direct deletion", async () => {
            const res = await postAsA("/api/workspace/bulk-delete", {
                // Overlapping parent + child folder AND a folder from a second project
                folder_ids: ["f-root", "f-child", "f-p2"],
                // Explicit workflow + duplicate of nested workflow + already-trashed workflow
                workflow_ids: ["workflows/wf-explicit", "wf-in-root", "wf-explicit-already-trashed"],
                // Workflow-backed character + orphan character
                character_ids: ["char-backed-1", "char-orphan-1"],
                // Workflow-backed element + orphan element
                element_ids: ["elem-backed-1", "elem-orphan-1"],
            });

            assert.equal(res.status, 200);
            const body = await res.json();

            assert.equal(body.ok, true);
            // Request must NEVER call TrashService.requestDelete (no implicit toggle!)
            assert.equal(state.getRequestDeleteCalls(), 0);
            assert.equal(state.permanentlyDeletedWorkflows.length, 0, "Workspace bulk delete must never permanently delete workflows");

            // Folders deleted deepest-first per project (f-grand -> f-child -> f-root, plus f-p2); sibling untouched
            assert.deepEqual(body.deleted_folder_ids, ["f-grand", "f-child", "f-root", "f-p2"]);
            assert.deepEqual(state.deletedFoldersOrder, ["f-grand", "f-child", "f-root", "f-p2"]);
            assert.equal(state.folders.some((f) => f.id === "f-sibling"), true);
            // listByProject called once per project (proj-A1 and proj-A2), not twice for overlapping folders
            assert.deepEqual(state.listByProjectCalls.sort(), ["proj-A1", "proj-A2"]);

            // Newly trashed vs already trashed accurately distinguished and deduplicated
            assert.deepEqual(body.trashed_workflow_ids.slice().sort(), [
                "wf-char-backed",
                "wf-elem-backed",
                "wf-explicit",
                "wf-in-grand",
                "wf-in-p2-folder",
                "wf-in-root",
            ]);
            assert.deepEqual(body.already_trashed_workflow_ids.slice().sort(), [
                "wf-already-trashed-in-folder",
                "wf-explicit-already-trashed",
            ]);

            // Already-trashed rows keep original deleted_at intact
            assert.equal(
                state.trash.find((t) => t.workflow_id === "wf-already-trashed-in-folder").deleted_at,
                state.earlierDeletedAt
            );
            assert.equal(
                state.trash.find((t) => t.workflow_id === "wf-explicit-already-trashed").deleted_at,
                state.earlierDeletedAt
            );

            // Workflows in deleted folders unlinked to folder_id = null; untouched workflow remains in f-sibling
            for (const wfId of ["wf-in-root", "wf-in-grand", "wf-already-trashed-in-folder", "wf-in-p2-folder"]) {
                assert.equal(state.workflows.find((w) => w.id === wfId).folder_id, null);
            }
            assert.equal(state.workflows.find((w) => w.id === "wf-untouched").folder_id, "f-sibling");

            // Orphan character & orphan element deleted directly; workflow-backed ones remain (in trash via workflow)
            assert.deepEqual(body.deleted_orphan_character_ids, ["char-orphan-1"]);
            assert.deepEqual(body.deleted_orphan_element_ids, ["elem-orphan-1"]);
            assert.deepEqual(state.deletedOrphanCharacters, ["char-orphan-1"]);
            assert.deepEqual(state.deletedOrphanElements, ["elem-orphan-1"]);
            assert.equal(state.characters.some((c) => c.id === "char-backed-1"), true);
            assert.equal(state.elements.some((e) => e.id === "elem-backed-1"), true);
        });

        it("POST /api/workspace/bulk-delete accepts camelCase payload aliases", async () => {
            const res = await postAsA("/api/workspace/bulk-delete", {
                folderIds: ["f-p2"],
                workflowIds: ["wf-explicit"],
                characterIds: ["char-orphan-1"],
                elementIds: ["elem-orphan-1"],
            });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.ok, true);
            assert.deepEqual(body.deleted_folder_ids, ["f-p2"]);
            assert.deepEqual(body.trashed_workflow_ids.slice().sort(), ["wf-explicit", "wf-in-p2-folder"]);
            assert.deepEqual(body.already_trashed_workflow_ids, []);
            assert.deepEqual(body.deleted_orphan_character_ids, ["char-orphan-1"]);
            assert.deepEqual(body.deleted_orphan_element_ids, ["elem-orphan-1"]);
        });

        it("POST /api/workspace/bulk-delete rejects empty, >100, non-array, and invalid entries with 400 and 0 mutations", async () => {
            const badPayloads = [
                {},
                { folder_ids: [], workflow_ids: [] },
                { workflow_ids: "wf-explicit" },
                { folder_ids: [""] },
                { workflow_ids: ["workflows/"] },
                { character_ids: [123] },
                {
                    workflow_ids: Array.from({ length: 101 }, (_, i) => `wf-${i}`),
                },
                {
                    folder_ids: Array.from({ length: 60 }, (_, i) => `f-${i}`),
                    workflow_ids: Array.from({ length: 41 }, (_, i) => `wf-${i}`),
                },
            ];

            for (const payload of badPayloads) {
                const res = await postAsA("/api/workspace/bulk-delete", payload);
                assert.equal(res.status, 400, `Expected 400 for payload ${JSON.stringify(payload).slice(0, 80)}`);
                const body = await res.json();
                assert.equal(body.ok, false);
            }

            assert.equal(state.deletedFoldersOrder.length, 0);
            assert.equal(state.trash.length, 4);
            assert.equal(state.deletedOrphanCharacters.length, 0);
            assert.equal(state.deletedOrphanElements.length, 0);
        });

        it("POST /api/workspace/bulk-delete enforces all-or-nothing 404 ownership across folders, workflows, characters, and elements with 0 mutations", async () => {
            const crossTenantPayloads = [
                { folder_ids: ["f-p2", "f-foreign"], workflow_ids: ["wf-explicit"] },
                { folder_ids: ["f-p2"], workflow_ids: ["wf-explicit", "wf-foreign"] },
                { folder_ids: ["f-p2"], character_ids: ["char-orphan-1", "char-foreign"] },
                { folder_ids: ["f-p2"], element_ids: ["elem-orphan-1", "elem-foreign"] },
                { workflow_ids: ["wf-explicit", "wf-does-not-exist"] },
            ];

            for (const payload of crossTenantPayloads) {
                const res = await postAsA("/api/workspace/bulk-delete", payload);
                assert.equal(res.status, 404, `Expected 404 for ${JSON.stringify(payload)}`);
                const body = await res.json();
                assert.equal(body.ok, false);
            }

            assert.equal(state.deletedFoldersOrder.length, 0, "No folders may be deleted on 404");
            assert.equal(state.trash.length, 4, "No workflows may be trashed on 404");
            assert.equal(state.deletedOrphanCharacters.length, 0, "No orphan characters may be deleted on 404");
            assert.equal(state.deletedOrphanElements.length, 0, "No orphan elements may be deleted on 404");
        });

        it("POST /api/trash/delete permanently deletes selected trashed workflows, dispatches to canonical owners, and aggregates media + storage failures", async () => {
            // Put char-backed and elem-backed into trash first via workspace bulk-delete
            const prep = await postAsA("/api/workspace/bulk-delete", {
                character_ids: ["char-backed-1"],
                element_ids: ["elem-backed-1"],
            });
            assert.equal(prep.status, 200);

            const res = await postAsA("/api/trash/delete", {
                workflow_ids: [
                    "workflows/wf-explicit-already-trashed",
                    "wf-char-backed",
                    "wf-elem-backed",
                    "wf-char-backed", // duplicate deduplicated
                ],
            });
            assert.equal(res.status, 200);
            const body = await res.json();

            assert.equal(body.ok, true);
            assert.equal(body.count, 3);
            assert.deepEqual(body.deleted_workflow_ids, [
                "wf-explicit-already-trashed",
                "wf-char-backed",
                "wf-elem-backed",
            ]);
            // 2 (workflow) + 4 (character) + 3 (element) = 9
            assert.equal(body.deleted_media_count, 9);
            assert.deepEqual(body.storage_failures, ["user/a/fail.png"]);
            assert.deepEqual(
                state.permanentlyDeletedWorkflows.map((x) => `${x.owner}:${x.workflowId}`).sort(),
                [
                    "character:wf-char-backed",
                    "element:wf-elem-backed",
                    "workflow:wf-explicit-already-trashed",
                ]
            );
            // Foreign trash untouched
            assert.equal(state.trash.some((t) => t.workflow_id === "wf-foreign"), true);
        });

        it("POST /api/trash/delete rejects active non-trashed workflow with 400 WORKFLOW_NOT_IN_TRASH and deletes nothing", async () => {
            const res = await postAsA("/api/trash/delete", {
                workflowIds: ["wf-explicit-already-trashed", "wf-explicit"],
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.equal(body.ok, false);
            assert.equal(body.errorCode, "WORKFLOW_NOT_IN_TRASH");
            assert.equal(state.permanentlyDeletedWorkflows.length, 0, "Zero permanent deletes when any workflow is not in Trash");
            assert.equal(state.trash.some((t) => t.workflow_id === "wf-explicit-already-trashed"), true);
        });

        it("POST /api/trash/delete rejects folder_ids, >100, empty, invalid modes, and cross-tenant items with 0 mutations", async () => {
            const bad400 = [
                { folder_ids: ["f-root"], workflow_ids: ["wf-explicit-already-trashed"] },
                { folderIds: ["f-root"] },
                {},
                { all: false },
                { all: "true" },
                { all: true, workflow_ids: ["wf-explicit-already-trashed"] },
                { all: true, workflowIds: ["wf-explicit-already-trashed"] },
                { workflow_ids: [] },
                { workflow_ids: ["   "] },
                { workflow_ids: "wf-explicit-already-trashed" },
                { workflow_ids: Array.from({ length: 101 }, (_, i) => `wf-${i}`) },
            ];

            for (const payload of bad400) {
                const res = await postAsA("/api/trash/delete", payload);
                assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(payload).slice(0, 80)}`);
            }

            // Cross-tenant workflow -> 404
            const resForeignWf = await postAsA("/api/trash/delete", {
                workflow_ids: ["wf-explicit-already-trashed", "wf-foreign"],
            });
            assert.equal(resForeignWf.status, 404);

            // Cross-tenant project_id on Empty Trash -> 404
            const resForeignProj = await postAsA("/api/trash/delete", {
                all: true,
                project_id: "proj-B1",
            });
            assert.equal(resForeignProj.status, 404);

            assert.equal(state.permanentlyDeletedWorkflows.length, 0);
        });

        it("POST /api/trash/delete supports Empty Trash scoped by project_id, global { all: true }, and idempotent empty trash", async () => {
            // 1. Project-scoped Empty Trash on proj-A2 -> only deletes wf-p2-trashed
            const resProj = await postAsA("/api/trash/delete", {
                all: true,
                projectId: "proj-A2",
            });
            assert.equal(resProj.status, 200);
            const bodyProj = await resProj.json();
            assert.equal(bodyProj.ok, true);
            assert.equal(bodyProj.count, 1);
            assert.deepEqual(bodyProj.deleted_workflow_ids, ["wf-p2-trashed"]);
            assert.equal(bodyProj.deleted_media_count, 2);

            // proj-A1 trashed items and foreign user's trashed items still remain
            assert.equal(state.trash.some((t) => t.workflow_id === "wf-explicit-already-trashed"), true);
            assert.equal(state.trash.some((t) => t.workflow_id === "wf-already-trashed-in-folder"), true);
            assert.equal(state.trash.some((t) => t.workflow_id === "wf-foreign"), true);

            // 2. Global Empty Trash { all: true } -> deletes remaining USER_A trashed items only
            const resAll = await postAsA("/api/trash/delete", { all: true });
            assert.equal(resAll.status, 200);
            const bodyAll = await resAll.json();
            assert.equal(bodyAll.ok, true);
            assert.equal(bodyAll.count, 2);
            assert.deepEqual(bodyAll.deleted_workflow_ids.slice().sort(), [
                "wf-already-trashed-in-folder",
                "wf-explicit-already-trashed",
            ]);
            assert.equal(bodyAll.deleted_media_count, 4);
            assert.deepEqual(bodyAll.storage_failures, ["user/a/fail.png"]);
            // Foreign user's trash STILL untouched
            assert.equal(state.trash.some((t) => t.workflow_id === "wf-foreign"), true);

            // 3. Idempotent Empty Trash when Trash is already empty -> 200 OK with count: 0
            const resEmpty = await postAsA("/api/trash/delete", { all: true });
            assert.equal(resEmpty.status, 200);
            const bodyEmpty = await resEmpty.json();
            assert.deepEqual(bodyEmpty, {
                ok: true,
                deleted_workflow_ids: [],
                count: 0,
                deleted_media_count: 0,
                storage_failures: [],
            });
        });

        it("TrashService.deleteTrashed bounds in-flight permanent deletes via BULK_DELETE_CONCURRENCY across 1, 10, 15, and clamped <1 / >15", async () => {
            const testCases = [
                { envValue: "1", expectedCap: 1, total: 6 },
                { envValue: "0", expectedCap: 1, total: 6 },
                { envValue: "-5", expectedCap: 1, total: 6 },
                { envValue: "10", expectedCap: 10, total: 24 },
                { envValue: "15", expectedCap: 15, total: 32 },
                { envValue: "99", expectedCap: 15, total: 32 },
            ];

            for (const { envValue, expectedCap, total } of testCases) {
                process.env.BULK_DELETE_CONCURRENCY = envValue;

                const ids = Array.from({ length: total }, (_, i) => `wf-conc-${i}`);
                let inFlight = 0;
                let maxInFlight = 0;

                const svc = new TrashService({
                    db: {
                        trash: {
                            findTrashedWorkflowIds: async ({ userId, workflowIds }) =>
                                userId === USER_A ? (workflowIds || ids) : [],
                        },
                        elements: { findByWorkflowId: async () => null },
                        characters: { findByCharacterId: async () => null },
                    },
                    workflowService: {
                        authService: {
                            verifyWorkflowOwnershipBulk: async (wfIds, uid) => (uid === USER_A ? wfIds : null),
                        },
                        deleteWorkflow: async ({ workflowId }) => {
                            inFlight += 1;
                            if (inFlight > maxInFlight) maxInFlight = inFlight;
                            await new Promise((resolve) => setTimeout(resolve, 10));
                            inFlight -= 1;
                            return { workflowId, deletedMediaCount: 1, storageFailures: [] };
                        },
                    },
                    elementService: { deleteElement: async () => ({}) },
                    characterService: { deleteCharacter: async () => ({}) },
                });

                const res = await svc.deleteTrashed({
                    userId: USER_A,
                    workflow_ids: ids,
                });

                assert.equal(res.ok, true);
                assert.equal(res.count, total);
                assert.equal(res.deleted_media_count, total);
                assert.deepEqual(res.deleted_workflow_ids, ids);
                assert.equal(inFlight, 0);
                assert.ok(
                    maxInFlight <= expectedCap,
                    `maxInFlight (${maxInFlight}) exceeded cap (${expectedCap}) for BULK_DELETE_CONCURRENCY=${envValue}`
                );
                assert.equal(
                    maxInFlight,
                    Math.min(expectedCap, total),
                    `Expected worker pool to saturate up to cap (${expectedCap}) for BULK_DELETE_CONCURRENCY=${envValue}`
                );
            }
        });

        it("POST /api/workspace/bulk-delete rejects upfront with 409 MEDIA_PROCESSING and 0 mutations when any targeted workflow (explicit or inside folder) has processing/pending media", async () => {
            state.fakeDb.workflowMedia = {
                findMediaStatusesByWorkflowIds: async (ids) =>
                    new Map(
                        ids.map((id) => [
                            id,
                            id === "wf-in-grand"
                                ? [{ id: "m-proc", status: "processing", url: null }]
                                : [{ id: `m-${id}`, status: "completed", url: "https://cdn/ok.png" }],
                        ])
                    ),
            };

            const res = await postAsA("/api/workspace/bulk-delete", {
                folder_ids: ["f-root"],
                workflow_ids: ["wf-explicit"],
                character_ids: ["char-orphan-1"],
            });

            assert.equal(res.status, 409);
            const body = await res.json();
            assert.equal(body.ok, false);
            assert.equal(body.errorCode, "MEDIA_PROCESSING");
            assert.equal(state.deletedFoldersOrder.length, 0, "No folders deleted on 409");
            assert.equal(state.trash.length, 4, "No workflows trashed on 409");
            assert.equal(state.permanentlyDeletedWorkflows.length, 0);
            assert.equal(state.deletedOrphanCharacters.length, 0);
        });

        it("POST /api/workspace/bulk-delete hard-deletes failed-only workflows directly (never trashing them) while trashing completed and mixed (failed + completed) workflows", async () => {
            state.fakeDb.workflowMedia = {
                findMediaStatusesByWorkflowIds: async (ids) =>
                    new Map(
                        ids.map((id) => {
                            if (id === "wf-explicit" || id === "wf-in-grand") {
                                return [id, [{ id: `m-${id}`, status: "failed", url: null }]];
                            }
                            if (id === "wf-in-root") {
                                return [
                                    id,
                                    [
                                        { id: "m-root-fail", status: "failed", url: null },
                                        { id: "m-root-ok", status: "success", url: "https://cdn/root.png" },
                                    ],
                                ];
                            }
                            return [id, [{ id: `m-${id}`, status: "completed", url: "https://cdn/ok.png" }]];
                        })
                    ),
            };

            const res = await postAsA("/api/workspace/bulk-delete", {
                folder_ids: ["f-root"],
                workflow_ids: ["wf-explicit"],
            });

            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.ok, true);
            assert.deepEqual(body.deleted_folder_ids, ["f-grand", "f-child", "f-root"]);
            assert.deepEqual(
                body.deleted_workflow_ids.slice().sort(),
                ["wf-explicit", "wf-in-grand"],
                "Failed-only workflows must be hard-deleted directly"
            );
            assert.deepEqual(
                body.trashed_workflow_ids,
                ["wf-in-root"],
                "Mixed (failed + success) workflow must still go to trash"
            );
            assert.deepEqual(body.already_trashed_workflow_ids, ["wf-already-trashed-in-folder"]);
            assert.equal(state.trash.some((t) => t.workflow_id === "wf-explicit"), false, "Failed-only wf-explicit must never enter trash");
            assert.equal(state.trash.some((t) => t.workflow_id === "wf-in-grand"), false, "Failed-only wf-in-grand must never enter trash");
            assert.deepEqual(
                state.permanentlyDeletedWorkflows.map((x) => x.workflowId).sort(),
                ["wf-explicit", "wf-in-grand"]
            );
        });

        it("POST /api/trash/delete defense-in-depth rejects with 409 MEDIA_PROCESSING and 0 deletes if a trashed workflow has processing media", async () => {
            state.fakeDb.workflowMedia = {
                findMediaStatusesByWorkflowIds: async (ids) =>
                    new Map(
                        ids.map((id) => [
                            id,
                            id === "wf-explicit-already-trashed"
                                ? [{ id: "m-proc", status: "pending", url: null }]
                                : [{ id: `m-${id}`, status: "completed", url: "https://cdn/ok.png" }],
                        ])
                    ),
            };

            // Selected mode
            const resSelected = await postAsA("/api/trash/delete", {
                workflow_ids: ["wf-explicit-already-trashed", "wf-already-trashed-in-folder"],
            });
            assert.equal(resSelected.status, 409);
            const bodySelected = await resSelected.json();
            assert.equal(bodySelected.ok, false);
            assert.equal(bodySelected.errorCode, "MEDIA_PROCESSING");
            assert.equal(state.permanentlyDeletedWorkflows.length, 0);

            // Empty trash ({ all: true }) mode
            const resAll = await postAsA("/api/trash/delete", { all: true });
            assert.equal(resAll.status, 409);
            const bodyAll = await resAll.json();
            assert.equal(bodyAll.errorCode, "MEDIA_PROCESSING");
            assert.equal(state.permanentlyDeletedWorkflows.length, 0);
        });
    });
});

describe("Media Status Deletion Guard: TrashService.requestDelete & requestDeleteMany", () => {
    it("requestDelete rejects processing/pending/queued media (409 MEDIA_PROCESSING) on both trash=true and trash=false, hard-deletes failed-only directly, and trashes mixed or completed workflows", async () => {
        const trashRows = new Map();
        const permanentDeletes = [];
        const mediaByWf = new Map([
            ["wf-processing", [{ id: "m-1", status: "processing", url: null }]],
            ["wf-pending", [{ id: "m-2", status: "pending", url: null }]],
            ["wf-queued", [{ id: "m-3", status: "queued", url: null }]],
            [
                "wf-mixed-processing",
                [
                    { id: "m-4a", status: "completed", url: "https://cdn/ok.png" },
                    { id: "m-4b", status: "processing", url: null },
                ],
            ],
            ["wf-failed-only", [{ id: "m-5", status: "failed", url: null }]],
            [
                "wf-all-failed-multi",
                [
                    { id: "m-6a", status: "failed", url: null },
                    { id: "m-6b", status: "FAILED", url: null },
                ],
            ],
            [
                "wf-mixed-failed-completed",
                [
                    { id: "m-7a", status: "failed", url: null },
                    { id: "m-7b", status: "completed", url: "https://cdn/7.png" },
                ],
            ],
            ["wf-completed", [{ id: "m-8", status: "success", url: "https://cdn/8.png" }]],
            ["wf-empty", []],
        ]);

        const trashService = new TrashService({
            db: {
                trash: {
                    insertIfAbsent: async ({ workflowId, userId }) => {
                        if (trashRows.has(workflowId)) return null;
                        const row = { workflow_id: workflowId, user_id: userId };
                        trashRows.set(workflowId, row);
                        return row;
                    },
                },
                workflowMedia: {
                    findMediaStatusesByWorkflowIds: async (ids) =>
                        new Map(ids.map((id) => [id, mediaByWf.get(id) || []])),
                },
                elements: { findByWorkflowId: async () => null },
                characters: { findByCharacterId: async () => null },
            },
            workflowService: {
                authService: {
                    verifyWorkflowOwnership: async (id, uid) => uid === "user-1" && mediaByWf.has(id),
                    verifyWorkflowOwnershipBulk: async (ids, uid) =>
                        uid === "user-1" && ids.every((id) => mediaByWf.has(id)) ? ids : null,
                },
                deleteWorkflow: async ({ workflowId }) => {
                    permanentDeletes.push(workflowId);
                    trashRows.delete(workflowId);
                    return {
                        workflowId,
                        unlinkedMediaCount: 1,
                        deletedOrphanCount: 1,
                        deletedMediaCount: 1,
                        storageFailures: [],
                    };
                },
            },
            elementService: { deleteElement: async () => ({}) },
            characterService: { deleteCharacter: async () => ({}) },
        });

        // 1. In-flight statuses rejected for BOTH trash=true and trash=false with 0 mutations
        for (const wfId of ["wf-processing", "wf-pending", "wf-queued", "wf-mixed-processing"]) {
            for (const trash of [true, false]) {
                await assert.rejects(
                    () => trashService.requestDelete({ kind: "workflow", id: wfId, userId: "user-1", trash }),
                    (err) => {
                        assert.ok(err instanceof MediaConflictError);
                        assert.equal(err.statusCode, 409);
                        assert.equal(err.errorCode, "MEDIA_PROCESSING");
                        return true;
                    }
                );
            }
        }
        assert.equal(trashRows.size, 0);
        assert.equal(permanentDeletes.length, 0);

        // 2. Failed-only workflows bypass Trash and hard-delete directly on 1st delete (default trash=true)
        const failedRes = await trashService.requestDelete({ kind: "workflow", id: "wf-failed-only", userId: "user-1" });
        assert.equal("trashed" in failedRes, false, "Failed-only workflow must not return trashed: true");
        assert.equal(failedRes.workflowId, "wf-failed-only");
        assert.equal(failedRes.deletedMediaCount, 1);
        assert.equal(trashRows.has("wf-failed-only"), false, "Failed-only workflow must never enter public.trash");
        assert.deepEqual(permanentDeletes, ["wf-failed-only"]);

        const multiFailedRes = await trashService.requestDelete({ kind: "workflow", id: "wf-all-failed-multi", userId: "user-1" });
        assert.equal("trashed" in multiFailedRes, false);
        assert.equal(trashRows.has("wf-all-failed-multi"), false);
        assert.deepEqual(permanentDeletes, ["wf-failed-only", "wf-all-failed-multi"]);

        // 3. Mixed (failed + completed), completed, and empty workflows still move to Trash
        for (const wfId of ["wf-mixed-failed-completed", "wf-completed", "wf-empty"]) {
            const res = await trashService.requestDelete({ kind: "workflow", id: wfId, userId: "user-1" });
            assert.equal(res.trashed, true, `${wfId} must move to trash`);
            assert.equal(trashRows.has(wfId), true);
        }
        assert.deepEqual(permanentDeletes, ["wf-failed-only", "wf-all-failed-multi"]);
    });

    it("requestDeleteMany rejects upfront with 409 MEDIA_PROCESSING if any workflow is processing (0 mutations), and directly hard-deletes failed-only workflows while trashing completed ones", async () => {
        const trashRows = new Map();
        const permanentDeletes = [];
        const mediaByWf = new Map([
            ["wf-ok", [{ id: "m-1", status: "completed", url: "https://cdn/1.png" }]],
            ["wf-fail", [{ id: "m-2", status: "failed", url: null }]],
            ["wf-busy", [{ id: "m-3", status: "processing", url: null }]],
        ]);

        const trashService = new TrashService({
            db: {
                trash: {
                    insertIfAbsent: async ({ workflowId, userId }) => {
                        if (trashRows.has(workflowId)) return null;
                        const row = { workflow_id: workflowId, user_id: userId };
                        trashRows.set(workflowId, row);
                        return row;
                    },
                },
                workflowMedia: {
                    findMediaStatusesByWorkflowIds: async (ids) =>
                        new Map(ids.map((id) => [id, mediaByWf.get(id) || []])),
                },
                elements: { findByWorkflowId: async () => null },
                characters: { findByCharacterId: async () => null },
            },
            workflowService: {
                authService: {
                    verifyWorkflowOwnership: async (id, uid) => uid === "user-1" && mediaByWf.has(id),
                    verifyWorkflowOwnershipBulk: async (ids, uid) =>
                        uid === "user-1" && ids.every((id) => mediaByWf.has(id)) ? ids : null,
                },
                deleteWorkflow: async ({ workflowId }) => {
                    permanentDeletes.push(workflowId);
                    return {
                        workflowId,
                        unlinkedMediaCount: 1,
                        deletedOrphanCount: 1,
                        deletedMediaCount: 1,
                        storageFailures: [],
                    };
                },
            },
            elementService: { deleteElement: async () => ({}) },
            characterService: { deleteCharacter: async () => ({}) },
        });

        // 1. Batch containing one processing workflow -> rejected upfront with 409 and 0 mutations
        await assert.rejects(
            () => trashService.requestDeleteMany({ ids: ["wf-ok", "wf-fail", "wf-busy"], userId: "user-1" }),
            (err) => {
                assert.ok(err instanceof MediaConflictError);
                assert.equal(err.statusCode, 409);
                assert.equal(err.errorCode, "MEDIA_PROCESSING");
                return true;
            }
        );
        assert.equal(trashRows.size, 0);
        assert.equal(permanentDeletes.length, 0);

        // 2. Batch containing [completed, failed-only] -> completed trashed, failed-only directly hard-deleted
        const res = await trashService.requestDeleteMany({ ids: ["wf-ok", "wf-fail"], userId: "user-1" });
        assert.equal(res.count, 2);
        assert.deepEqual(res.workflow_ids, ["wf-ok", "wf-fail"]);
        assert.equal(res.trashed, true);
        assert.equal(res.results[0].trashed, true);
        assert.equal("trashed" in res.results[1], false);
        assert.equal(trashRows.has("wf-ok"), true);
        assert.equal(trashRows.has("wf-fail"), false);
        assert.deepEqual(permanentDeletes, ["wf-fail"]);
    });
});
}
