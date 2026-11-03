import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TrashRepository } from "../../src/db/TrashRepository.js";
import { TrashService } from "../../src/domain/trash/TrashService.js";
import { setDb } from "#platform/identity";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, "../../../supabase/migrations");
const trashMigrationPath = path.join(migrationsDir, "20261025180000_create_trash_table.sql");

describe("T1: public.trash Migration, TrashRepository, and TrashService", () => {
    it("migration 20261025180000_create_trash_table.sql exists, has timestamp > 20261024000000, and defines public.trash schema, RLS, and service_role grants", () => {
        assert.equal(
            fs.existsSync(trashMigrationPath),
            true,
            `Trash migration file must exist at ${trashMigrationPath}`
        );

        const filename = path.basename(trashMigrationPath);
        const tsMatch = filename.match(/^(\d{14})_/);
        assert.ok(tsMatch, "Migration filename must start with 14-digit timestamp");
        assert.equal(
            BigInt(tsMatch[1]) > 20261024000000n,
            true,
            "Trash migration timestamp must be strictly greater than 20261024000000"
        );

        const sql = fs.readFileSync(trashMigrationPath, "utf8");

        assert.doesNotMatch(
            sql,
            /Status:\s*APPLIED/i,
            "New migration must not contain 'Status: APPLIED' header"
        );
        assert.doesNotMatch(
            sql,
            /DROP\s+TABLE\s+IF\s+EXISTS\s+public\.trash/i,
            "Rollback SQL must not be placed inside supabase/migrations/"
        );

        assert.match(sql, /CREATE\s+TABLE\s+public\.trash\s*\(/i);
        assert.match(sql, /\bid\s+uuid\s+PRIMARY\s+KEY\s+DEFAULT\s+gen_random_uuid\(\)/i);
        assert.match(
            sql,
            /\bworkflow_id\s+uuid\s+NOT\s+NULL\s+UNIQUE\s+REFERENCES\s+public\.workflow\(id\)\s+ON\s+DELETE\s+CASCADE/i
        );
        assert.match(
            sql,
            /\buser_id\s+uuid\s+NOT\s+NULL\s+REFERENCES\s+auth\.users\(id\)\s+ON\s+DELETE\s+CASCADE/i
        );
        assert.match(sql, /\bdeleted_at\s+timestamptz\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i);
        assert.match(sql, /\bdeleted_by\s+uuid\b/i);
        assert.match(
            sql,
            /CREATE\s+INDEX\s+idx_trash_user_id\s+ON\s+public\.trash\s+USING\s+btree\s*\(\s*user_id\s*\)/i
        );
        assert.match(sql, /ALTER\s+TABLE\s+public\.trash\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
        assert.match(
            sql,
            /REVOKE\s+ALL\s+ON\s+TABLE\s+public\.trash\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i
        );
        assert.match(sql, /GRANT\s+ALL\s+ON\s+TABLE\s+public\.trash\s+TO\s+service_role/i);
    });

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
            setDb(null);
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
            setDb(null);
        }
    });
});
