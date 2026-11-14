import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { supabase, supabaseAdmin } from "#shared/db/supabase.js";
import { WorkflowRepository } from "#generation/tools";
import { ElementRepository } from "#elements/tools";
import { CharacterRepository } from "#characters/tools";
import { FolderRepository } from "#workspace/tools";
import { ProjectReadService } from "#workspace/tools";
import { WorkflowAuthorizationService } from "#generation/tools";
import { assertOwns, setDb } from "#identity/tools";

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
            setDb(null);
            supabase.from = origSupabaseFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });
});
