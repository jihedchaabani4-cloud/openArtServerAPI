import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import workflowsRouter from "../../routes/workflows.js";
import elementRoutes from "../../routes/elementRoutes.js";
import charactersRouter from "../../routes/characters.js";
import { db, workflowService } from "../../src/container.js";
import { rateLimitRedisConnection, redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { supabase } from "../../lib/supabase.js";

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
