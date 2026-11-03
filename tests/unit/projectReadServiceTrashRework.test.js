import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { supabase, supabaseAdmin } from "../../lib/supabase.js";
import { WorkflowRepository } from "../../src/db/WorkflowRepository.js";
import { ElementRepository } from "../../src/db/ElementRepository.js";
import { CharacterRepository } from "../../src/db/CharacterRepository.js";
import { ProjectReadService } from "../../src/domain/project/ProjectReadService.js";
import { assertOwns, setDb } from "#platform/identity";

/**
 * Builds an in-memory Supabase table query simulator supporting
 * select, eq, in, not, is, or, ilike, order, range, limit, maybeSingle, single.
 */
function createTableClient(tables) {
    return {
        from(tableName) {
            const rows = tables[tableName] || [];
            const filters = [];
            const orders = [];
            let rangeSpec = null;
            let limitCount = null;

            const applyFilters = () => {
                return rows.filter((row) =>
                    filters.every((fn) => fn(row))
                );
            };

            const execute = () => {
                let matched = applyFilters();
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
                return { data: matched, error: null };
            };

            const builder = {
                select() { return builder; },
                eq(col, val) {
                    filters.push((row) => row[col] === val);
                    return builder;
                },
                in(col, vals) {
                    const set = new Set(vals);
                    filters.push((row) => set.has(row[col]));
                    return builder;
                },
                not(col, op, val) {
                    if (op === "is" && val === null) {
                        filters.push((row) => row[col] !== null && row[col] !== undefined);
                    }
                    return builder;
                },
                is(col, val) {
                    filters.push((row) => row[col] === val);
                    return builder;
                },
                or(expr) {
                    filters.push((row) => {
                        const parts = expr.split(",");
                        return parts.some((p) => {
                            const [field, op, val] = p.split(".");
                            if (op === "eq") return row[field] === val;
                            if (op === "in") {
                                const list = val.replace(/^\(|\)$/g, "").split(",");
                                return list.includes(row[field]);
                            }
                            return false;
                        });
                    });
                    return builder;
                },
                order(column, { ascending = true } = {}) {
                    orders.push({ col: column, ascending });
                    return builder;
                },
                range(from, to) {
                    rangeSpec = { from, to };
                    return builder;
                },
                limit(count) {
                    limitCount = count;
                    return builder;
                },
                then(resolve, reject) {
                    try {
                        const res = execute();
                        return Promise.resolve(resolve(res));
                    } catch (err) {
                        return Promise.reject(reject ? reject(err) : err);
                    }
                },
            };
            return builder;
        },
    };
}

describe("ProjectReadService: Trash Rework & Media Isolation", () => {
    it("STEP 1: Trashed workflow media must NOT appear in projectContents.media, but appears in projectContents.trashedWorkflows", async () => {
        const tables = {
            project: [{ id: "proj-1", project_name: "Studio Proj", user_id: "user-1" }],
            workflow: [
                {
                    id: "wf-active",
                    project_id: "proj-1",
                    display_name: "Active Generation",
                    workflow_type: "GENERATION",
                    create_time: "2026-10-25T10:00:00.000Z",
                    primary_media_id: "media-active",
                },
                {
                    id: "wf-trashed",
                    project_id: "proj-1",
                    display_name: "Trashed Generation",
                    workflow_type: "GENERATION",
                    create_time: "2026-10-25T11:00:00.000Z",
                    primary_media_id: "media-trashed",
                },
            ],
            element: [],
            characters: [],
            media: [
                {
                    id: "media-active",
                    project_id: "proj-1",
                    url: "https://storage/active.png",
                    width: 1024,
                    height: 1024,
                    status: "completed",
                    create_time: "2026-10-25T10:01:00.000Z",
                },
                {
                    id: "media-trashed",
                    project_id: "proj-1",
                    url: "https://storage/trashed.png",
                    width: 1024,
                    height: 1024,
                    status: "completed",
                    create_time: "2026-10-25T11:01:00.000Z",
                },
            ],
            workflow_media: [
                {
                    workflow_id: "wf-active",
                    media_id: "media-active",
                    role: "output",
                    is_primary: true,
                    created_at: "2026-10-25T10:01:00.000Z",
                },
                {
                    workflow_id: "wf-trashed",
                    media_id: "media-trashed",
                    role: "output",
                    is_primary: true,
                    created_at: "2026-10-25T11:01:00.000Z",
                },
            ],
            trash: [
                { id: "t-1", workflow_id: "wf-trashed", user_id: "user-1", deleted_at: "2026-10-25T12:00:00.000Z" },
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
                media: { findByProjectAll: async () => tables.media },
                workflowMedia: {
                    findRelationsByWorkflowIds: async (wfIds) =>
                        tables.workflow_media.filter((wm) => wfIds.includes(wm.workflow_id)),
                },
            };
            const service = new ProjectReadService({ db });

            const result = await service.getProjectData({ projectId: "proj-1", userId: "user-1" });

            // Active workflows must contain ONLY wf-active
            assert.deepEqual(
                result.workflows.map((w) => w.id),
                ["wf-active"],
                "projectContents.workflows must contain only active workflows"
            );

            // Active media must contain ONLY media-active (media-trashed must NOT appear!)
            assert.deepEqual(
                result.media.map((m) => m.id),
                ["media-active"],
                "projectContents.media must contain only active media, excluding media from trashed workflows"
            );

            // trashedWorkflows must contain wf-trashed with its media and deleted_at
            assert.ok(Array.isArray(result.trashedWorkflows), "trashedWorkflows must be an array");
            assert.equal(result.trashedWorkflows.length, 1, "trashedWorkflows must contain exactly 1 item");
            const trashedWf = result.trashedWorkflows[0];
            assert.equal(trashedWf.id, "wf-trashed");
            assert.equal(trashedWf.display_name, "Trashed Generation");
            assert.equal(trashedWf.deleted_at, "2026-10-25T12:00:00.000Z");
            assert.equal(trashedWf.primary_media_id, "media-trashed");
            assert.ok(Array.isArray(trashedWf.media), "trashed workflow must have media array");
            assert.equal(trashedWf.media.length, 1);
            assert.equal(trashedWf.media[0].id, "media-trashed");
            assert.equal(trashedWf.media[0].url, "https://storage/trashed.png");
        } finally {
            supabase.from = origSupabaseFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });

    it("STEP 2: Empty trash returns empty trashedWorkflows array; restore brings workflow and media back to active arrays; foreign project throws 404", async () => {
        const tables = {
            project: [
                { id: "proj-1", project_name: "Studio Proj", user_id: "user-1" },
                { id: "proj-foreign", project_name: "Foreign Proj", user_id: "user-other" },
            ],
            workflow: [
                {
                    id: "wf-1",
                    project_id: "proj-1",
                    display_name: "Test Generation",
                    workflow_type: "GENERATION",
                    create_time: "2026-10-25T10:00:00.000Z",
                    primary_media_id: "media-1",
                },
            ],
            element: [],
            characters: [],
            media: [
                {
                    id: "media-1",
                    project_id: "proj-1",
                    url: "https://storage/1.png",
                    width: 1024,
                    height: 1024,
                    status: "completed",
                    create_time: "2026-10-25T10:01:00.000Z",
                },
            ],
            workflow_media: [
                {
                    workflow_id: "wf-1",
                    media_id: "media-1",
                    role: "output",
                    is_primary: true,
                    created_at: "2026-10-25T10:01:00.000Z",
                },
            ],
            trash: [],
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
                media: { findByProjectAll: async () => tables.media },
                workflowMedia: {
                    findRelationsByWorkflowIds: async (wfIds) =>
                        tables.workflow_media.filter((wm) => wfIds.includes(wm.workflow_id)),
                },
            };
            setDb(db);
            const service = new ProjectReadService({ db });

            // A: Project without trash -> trashedWorkflows is empty array
            const resClean = await service.getProjectData({ projectId: "proj-1", userId: "user-1" });
            assert.deepEqual(resClean.trashedWorkflows, []);
            assert.equal(resClean.workflows.length, 1);
            assert.equal(resClean.media.length, 1);

            // B: Foreign project -> throws 404
            const prevBypass = process.env.DEV_AUTH_BYPASS;
            process.env.DEV_AUTH_BYPASS = "false";
            try {
                await assert.rejects(
                    async () => service.getProjectData({ projectId: "proj-foreign", userId: "user-1" }),
                    (err) => err?.statusCode === 404,
                    "Accessing another user's project must throw 404"
                );
            } finally {
                process.env.DEV_AUTH_BYPASS = prevBypass;
            }

            // C: Move wf-1 to trash -> moves to trashedWorkflows, excluded from active
            tables.trash.push({ id: "t-1", workflow_id: "wf-1", user_id: "user-1", deleted_at: "2026-10-25T12:00:00.000Z" });
            const resTrashed = await service.getProjectData({ projectId: "proj-1", userId: "user-1" });
            assert.deepEqual(resTrashed.workflows, []);
            assert.deepEqual(resTrashed.media, []);
            assert.equal(resTrashed.trashedWorkflows.length, 1);
            assert.equal(resTrashed.trashedWorkflows[0].id, "wf-1");

            // D: Restore wf-1 (remove trash row) -> reappears in workflows and media, disappears from trashedWorkflows
            tables.trash.length = 0;
            const resRestored = await service.getProjectData({ projectId: "proj-1", userId: "user-1" });
            assert.equal(resRestored.workflows.length, 1);
            assert.equal(resRestored.workflows[0].id, "wf-1");
            assert.equal(resRestored.media.length, 1);
            assert.equal(resRestored.media[0].id, "media-1");
            assert.deepEqual(resRestored.trashedWorkflows, []);
        } finally {
            supabase.from = origSupabaseFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });

    it("STEP 3: When trash table query fails (e.g. migration not applied), active workflows are still preserved", async () => {
        const tables = {
            project: [{ id: "proj-1", project_name: "Studio Proj", user_id: "user-1" }],
            workflow: [
                {
                    id: "wf-1",
                    project_id: "proj-1",
                    display_name: "Active 1",
                    workflow_type: "GENERATION",
                    create_time: "2026-10-25T10:00:00.000Z",
                    primary_media_id: "media-1",
                },
            ],
            element: [],
            characters: [],
            media: [
                {
                    id: "media-1",
                    project_id: "proj-1",
                    url: "https://storage/1.png",
                    width: 1024,
                    height: 1024,
                    status: "completed",
                    create_time: "2026-10-25T10:01:00.000Z",
                },
            ],
            workflow_media: [
                {
                    workflow_id: "wf-1",
                    media_id: "media-1",
                    role: "output",
                    is_primary: true,
                    created_at: "2026-10-25T10:01:00.000Z",
                },
            ],
        };

        const client = createTableClient(tables);
        const origFrom = client.from;
        client.from = (tableName) => {
            if (tableName === "trash") {
                return {
                    select() {
                        return {
                            in() {
                                return Promise.reject(new Error('relation "trash" does not exist'));
                            },
                        };
                    },
                };
            }
            return origFrom(tableName);
        };

        const origSupabaseFrom = supabase.from;
        const origAdminFrom = supabaseAdmin.from;
        supabase.from = client.from.bind(client);
        supabaseAdmin.from = client.from.bind(client);

        try {
            const workflowRepo = new WorkflowRepository("workflow");
            const dbMock = {
                workflows: workflowRepo,
                projects: {
                    findById: async () => ({ id: "proj-1", project_name: "Studio Proj", user_id: "user-1" }),
                },
                media: {
                    findByProjectAll: async () => tables.media,
                },
                elements: new ElementRepository("element"),
                characters: new CharacterRepository("characters"),
            };

            const service = new ProjectReadService({ db: dbMock });
            const res = await service.getProjectData({ projectId: "proj-1", userId: "user-1" });

            assert.equal(res.workflows.length, 1, "Active workflows should be preserved even if trash table fails");
            assert.equal(res.workflows[0].id, "wf-1");
            assert.deepEqual(res.trashedWorkflows, []);
        } finally {
            supabase.from = origSupabaseFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });

    it("Active workflows and elements are returned when workflow table does not have primary_media_id (ADR-0007)", async () => {
        const tables = {
            workflow: [
                {
                    id: "wf-1",
                    project_id: "proj-1",
                    display_name: "Workflow 1",
                    create_time: "2026-10-25T10:00:00.000Z",
                    workflow_type: "GENERATION",
                    folder_id: null,
                    favorited: false,
                },
            ],
            trash: [],
            media: [
                {
                    id: "media-1",
                    project_id: "proj-1",
                    url: "https://storage/1.png",
                    width: 1024,
                    height: 1024,
                    status: "completed",
                    create_time: "2026-10-25T10:01:00.000Z",
                },
            ],
            workflow_media: [
                {
                    workflow_id: "wf-1",
                    media_id: "media-1",
                    role: "output",
                    is_primary: true,
                    created_at: "2026-10-25T10:01:00.000Z",
                },
            ],
            element: [],
            characters: [],
        };

        const client = createTableClient(tables);
        const origFrom = client.from;
        client.from = (tableName) => {
            const builder = origFrom(tableName);
            const origSelect = builder.select;
            builder.select = (cols) => {
                if (tableName === "workflow" && typeof cols === "string" && cols.includes("primary_media_id")) {
                    const failBuilder = {
                        order() { return failBuilder; },
                        eq() { return Promise.reject(new Error("column workflow.primary_media_id does not exist")); },
                    };
                    return failBuilder;
                }
                return origSelect(cols);
            };
            return builder;
        };

        const origSupabaseFrom = supabase.from;
        const origAdminFrom = supabaseAdmin.from;
        supabase.from = client.from.bind(client);
        supabaseAdmin.from = client.from.bind(client);

        try {
            const workflowRepo = new WorkflowRepository("workflow");
            const dbMock = {
                workflows: workflowRepo,
                projects: {
                    findById: async () => ({ id: "proj-1", project_name: "Studio Proj", user_id: "user-1" }),
                },
                media: {
                    findByProjectAll: async () => tables.media,
                },
                elements: new ElementRepository("element"),
                characters: new CharacterRepository("characters"),
            };

            const service = new ProjectReadService({ db: dbMock });
            const res = await service.getProjectData({ projectId: "proj-1", userId: "user-1" });

            assert.equal(res.workflows.length, 1, "Workflows must be returned when primary_media_id is omitted/dropped from workflow table");
            assert.equal(res.workflows[0].id, "wf-1");
            assert.equal(res.workflows[0].primary_media_id, "media-1", "primary_media_id should be derived from workflow_media.is_primary");
        } finally {
            supabase.from = origSupabaseFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });
});
