import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import apiRouter from "../../src/api/routes.js";
import { db } from "../../src/container.js";
import { rateLimitRedisConnection, redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { supabase } from "../../lib/supabase.js";

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
        db.workflows.findByProject = async (projectId) => {
            const trashedIds = new Set(mockTrash.map((t) => t.workflow_id));
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
    });

    afterEach(() => {
        Object.assign(db.projects, originalDbProjects);
        Object.assign(db.workflows, originalDbWorkflows);
        Object.assign(db.elements, originalDbElements);
        Object.assign(db.characters, originalDbCharacters);
        Object.assign(db.trash, originalDbTrash);
    });

    it("1. Authentication guard: unauthenticated GET /api/trash and POST /api/trash/:workflowId/restore return 401", async () => {
        const listRes = await fetch(`${baseUrl}/api/trash`);
        assert.equal(listRes.status, 401);

        const restoreRes = await fetch(`${baseUrl}/api/trash/wf-A-1/restore`, {
            method: "POST",
        });
        assert.equal(restoreRes.status, 401);
    });

    it("2. GET /api/trash returns only the authenticated user's trashed workflows ordered by deleted_at DESC", async () => {
        mockTrash.push(
            {
                id: "trash-1",
                workflow_id: "wf-A-1",
                user_id: "user-A",
                deleted_at: "2026-10-25T15:00:00.000Z",
                deleted_by: "user-A",
            },
            {
                id: "trash-2",
                workflow_id: "wf-B-1",
                user_id: "user-B",
                deleted_at: "2026-10-25T16:00:00.000Z",
                deleted_by: "user-B",
            },
            {
                id: "trash-3",
                workflow_id: "wf-A-2",
                user_id: "user-A",
                deleted_at: "2026-10-25T17:00:00.000Z",
                deleted_by: "user-A",
            }
        );

        const resA = await fetch(`${baseUrl}/api/trash`, {
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(resA.status, 200);
        const bodyA = await resA.json();
        assert.deepEqual(bodyA, {
            ok: true,
            items: [
                {
                    workflow_id: "wf-A-2",
                    display_name: "Second WF A",
                    workflow_type: "VIDEO",
                    deleted_at: "2026-10-25T17:00:00.000Z",
                },
                {
                    workflow_id: "wf-A-1",
                    display_name: "First WF A",
                    workflow_type: "IMAGE",
                    deleted_at: "2026-10-25T15:00:00.000Z",
                },
            ],
        });

        const resB = await fetch(`${baseUrl}/api/trash`, {
            headers: { Authorization: "Bearer token-user-B" },
        });
        assert.equal(resB.status, 200);
        const bodyB = await resB.json();
        assert.deepEqual(bodyB, {
            ok: true,
            items: [
                {
                    workflow_id: "wf-B-1",
                    display_name: "Foreign WF B",
                    workflow_type: "IMAGE",
                    deleted_at: "2026-10-25T16:00:00.000Z",
                },
            ],
        });
    });

    it("3. End-to-end Trash -> List -> Restore -> Reader visibility lifecycle without deleting or recreating public.workflow", async () => {
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

        // 2. Appears in GET /api/trash and is hidden from active readers
        const listRes1 = await fetch(`${baseUrl}/api/trash`, {
            headers: { Authorization: "Bearer token-user-A" },
        });
        assert.equal(listRes1.status, 200);
        const listBody1 = await listRes1.json();
        assert.equal(listBody1.items.length, 2);
        assert.equal(listBody1.items.some((i) => i.workflow_id === "wf-elem-A"), true);
        assert.equal(listBody1.items.some((i) => i.workflow_id === "wf-char-A"), true);

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

        // 5. Disappears from GET /api/trash and reappears in active readers
        const listRes2 = await fetch(`${baseUrl}/api/trash`, {
            headers: { Authorization: "Bearer token-user-A" },
        });
        const listBody2 = await listRes2.json();
        assert.deepEqual(listBody2, { ok: true, items: [] });

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

    it("4. POST /api/trash/:workflowId/restore returns 404 when workflow is not in Trash, when called a second time after restore, or for a non-existent workflowId", async () => {
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
});
