import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkflowMediaService } from "../../src/platform/workflow/WorkflowMediaService.js";
import { WorkflowMediaRepository } from "../../src/db/WorkflowMediaRepository.js";
import { ElementService } from "../../src/domain/element/ElementService.js";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";

describe("Generic Workflow Primary Media — Centralize and Reuse Canonical Contract", () => {
    function createMockDb() {
        const workflows = [];
        const elements = [];
        const media = [];
        const workflowMedia = [];
        let writtenWorkflowPrimaryMediaId = false;

        return {
            workflows: {
                createWorkflow: async (payload) => {
                    const row = { id: `wf-${workflows.length + 1}`, ...payload };
                    workflows.push(row);
                    return row;
                },
                findById: async (id) => workflows.find((w) => w.id === id) || null,
                getPrimaryMediaUrl: async (workflowId) => {
                    const link = workflowMedia.find((wm) => wm.workflow_id === workflowId && wm.is_primary === true);
                    if (!link) return null;
                    const m = media.find((med) => med.id === link.media_id);
                    return m?.url || null;
                },
                updateFields: async (workflowId, fields) => {
                    if ("primary_media_id" in fields) {
                        writtenWorkflowPrimaryMediaId = true;
                    }
                    const wf = workflows.find((w) => w.id === workflowId);
                    if (wf) Object.assign(wf, fields);
                    return wf || { id: workflowId, ...fields };
                },
                wasPrimaryMediaIdColumnWritten: () => writtenWorkflowPrimaryMediaId,
            },
            elements: {
                create: async (payload) => {
                    const row = { id: `00000000-0000-0000-0000-00000000000${elements.length + 1}`, ...payload };
                    elements.push(row);
                    return row;
                },
                resolveRecord: async (id) => elements.find((e) => e.id === id || e.workflow_id === id) || null,
                findById: async (id) => elements.find((e) => e.id === id) || null,
                update: async (id, patch) => {
                    const el = elements.find((e) => e.id === id || e.workflow_id === id);
                    if (!el) return null;
                    Object.assign(el, patch);
                    return el;
                },
            },
            media: {
                createMedia: async (payload) => {
                    const row = { id: `media-${media.length + 1}`, status: "completed", url: "https://example.com/m.png", ...payload };
                    media.push(row);
                    return row;
                },
                findById: async (id) => media.find((m) => m.id === id) || null,
                findWithContext: async (id) => {
                    const m = media.find((item) => item.id === id);
                    if (!m) return null;
                    return { ...m, workflow: { session_id: "s-1" } };
                },
                findByWorkflow: async (workflowId) => {
                    const links = workflowMedia.filter((wm) => wm.workflow_id === workflowId);
                    return links.map((l) => {
                        const m = media.find((med) => med.id === l.media_id);
                        return { ...(m || {}), role: l.role, is_primary: l.is_primary };
                    });
                },
            },
            workflowMedia: {
                linkMedia: async ({ workflowId, mediaId, role, is_primary, isPrimary }) => {
                    const resolvedPrimary = Boolean(is_primary ?? isPrimary ?? false);
                    if (resolvedPrimary) {
                        for (const wm of workflowMedia) {
                            if (wm.workflow_id === workflowId) wm.is_primary = false;
                        }
                    }
                    const row = { workflow_id: workflowId, media_id: mediaId, role: role || "detail", is_primary: resolvedPrimary };
                    workflowMedia.push(row);
                    return row;
                },
                getPrimaryMedia: async (workflowId) => {
                    return workflowMedia.find((wm) => wm.workflow_id === workflowId && wm.is_primary === true) || null;
                },
                findByWorkflow: async (workflowId) => {
                    return workflowMedia.filter((wm) => wm.workflow_id === workflowId);
                },
                findByMedia: async (mediaId) => {
                    return workflowMedia.filter((wm) => wm.media_id === mediaId);
                },
                isMediaLinkedToWorkflow: async ({ workflowId, mediaId }) => {
                    return workflowMedia.some((wm) => wm.workflow_id === workflowId && wm.media_id === mediaId);
                },
                setPrimaryMedia: async ({ workflowId, mediaId }) => {
                    for (const wm of workflowMedia) {
                        if (wm.workflow_id === workflowId) {
                            wm.is_primary = (wm.media_id === mediaId);
                        }
                    }
                    return { workflow_id: workflowId, media_id: mediaId, is_primary: true };
                },
                clearPrimaryMedia: async ({ workflowId }) => {
                    for (const wm of workflowMedia) {
                        if (wm.workflow_id === workflowId) {
                            wm.is_primary = false;
                        }
                    }
                    return { workflow_id: workflowId, cleared: true };
                },
                setPrimaryMediaIfNone: async ({ workflowId, mediaId }) => {
                    const hasPrimary = workflowMedia.some((wm) => wm.workflow_id === workflowId && wm.is_primary === true);
                    if (hasPrimary) return false;
                    for (const wm of workflowMedia) {
                        if (wm.workflow_id === workflowId && wm.media_id === mediaId) {
                            wm.is_primary = true;
                            return true;
                        }
                    }
                    return false;
                },
            },
            _store: { workflows, elements, media, workflowMedia },
        };
    }

    function createMockAuthService(ownedWorkflows = new Set(), ownedMedia = new Set()) {
        return {
            verifyWorkflowOwnership: async (workflowId, userId) => {
                if (!userId) return true;
                return ownedWorkflows.has(`${userId}:${workflowId}`);
            },
            verifyMediaOwnership: async (mediaId, userId) => {
                if (!userId) return true;
                return ownedMedia.has(`${userId}:${mediaId}`);
            },
        };
    }

    it("1. WorkflowMediaService.setPrimaryMedia atomically switches primary and never writes to workflow.primary_media_id", async () => {
        const mockDb = createMockDb();
        const authService = createMockAuthService(new Set(["u1:wf-1"]), new Set(["u1:m1", "u1:m2"]));
        const service = new WorkflowMediaService({ db: mockDb, authService, mediaUploadService: { discard: async () => ({}) } });

        // Setup workflow and two linked media items
        mockDb._store.workflows.push({ id: "wf-1", user_id: "u1" });
        mockDb._store.media.push({ id: "m1", status: "completed", url: "https://example.com/1.png" });
        mockDb._store.media.push({ id: "m2", status: "completed", url: "https://example.com/2.png" });
        mockDb._store.workflowMedia.push({ workflow_id: "wf-1", media_id: "m1", is_primary: true, role: "detail" });
        mockDb._store.workflowMedia.push({ workflow_id: "wf-1", media_id: "m2", is_primary: false, role: "detail" });

        // Explicit primary switch to m2
        const result = await service.setPrimaryMedia({ workflowId: "wf-1", mediaId: "m2", userId: "u1" });

        assert.equal(result.is_primary, true);
        assert.equal(result.primaryMediaId, "m2");
        assert.equal(result.primary_media_id, "m2");

        const wm1 = mockDb._store.workflowMedia.find((wm) => wm.media_id === "m1");
        const wm2 = mockDb._store.workflowMedia.find((wm) => wm.media_id === "m2");
        assert.equal(wm1.is_primary, false, "Previous primary must be demoted");
        assert.equal(wm2.is_primary, true, "New primary must be promoted");

        // Verify no write to removed workflow.primary_media_id column
        assert.equal(mockDb.workflows.wasPrimaryMediaIdColumnWritten(), false, "Never write to workflow.primary_media_id");
    });

    it("2. WorkflowMediaService: mediaId: null explicitly clears primary media", async () => {
        const mockDb = createMockDb();
        const authService = createMockAuthService(new Set(["u1:wf-1"]), new Set());
        const service = new WorkflowMediaService({ db: mockDb, authService, mediaUploadService: { discard: async () => ({}) } });

        mockDb._store.workflows.push({ id: "wf-1", user_id: "u1" });
        mockDb._store.workflowMedia.push({ workflow_id: "wf-1", media_id: "m1", is_primary: true, role: "detail" });

        // Set with explicit null
        const result = await service.setPrimaryMedia({ workflowId: "wf-1", mediaId: null, userId: "u1" });
        assert.equal(result.is_primary, false);
        assert.equal(result.primaryMediaId, null);

        const wm1 = mockDb._store.workflowMedia.find((wm) => wm.media_id === "m1");
        assert.equal(wm1.is_primary, false, "Primary media must be cleared");

        // Direct clearPrimaryMedia method also works
        const clearRes = await service.clearPrimaryMedia({ workflowId: "wf-1", userId: "u1" });
        assert.equal(clearRes.is_primary, false);
        assert.equal(clearRes.primaryMediaId, null);
    });

    it("3. WorkflowMediaService rejects cross-tenant access with 404 per project rules", async () => {
        const mockDb = createMockDb();
        // user "attacker" does not own wf-1
        const authService = createMockAuthService(new Set(["legit-user:wf-1"]), new Set(["attacker:m1"]));
        const service = new WorkflowMediaService({ db: mockDb, authService, mediaUploadService: { discard: async () => ({}) } });

        mockDb._store.workflows.push({ id: "wf-1", user_id: "legit-user" });
        mockDb._store.media.push({ id: "m1", status: "completed", url: "https://example.com/1.png" });

        await assert.rejects(
            async () => {
                await service.setPrimaryMedia({ workflowId: "wf-1", mediaId: "m1", userId: "attacker" });
            },
            (err) => {
                assert.equal(err.statusCode, 404, "Cross-tenant access must return 404, never 403");
                return true;
            }
        );
    });

    it("4. WorkflowMediaService rejects media that does not belong to the workflow with 400 or 403", async () => {
        const mockDb = createMockDb();
        const authService = createMockAuthService(new Set(["u1:wf-1"]), new Set(["u1:m-foreign"]));
        const service = new WorkflowMediaService({ db: mockDb, authService, mediaUploadService: { discard: async () => ({}) } });

        mockDb._store.workflows.push({ id: "wf-1", user_id: "u1" });
        mockDb._store.media.push({ id: "m-foreign", status: "completed", url: "https://example.com/foreign.png" });
        // Notice m-foreign is NOT linked to wf-1 in workflowMedia

        await assert.rejects(
            async () => {
                await service.setPrimaryMedia({ workflowId: "wf-1", mediaId: "m-foreign", userId: "u1" });
            },
            (err) => {
                assert.ok(err.statusCode === 400 || err.statusCode === 403, "Foreign media must be rejected");
                return true;
            }
        );
    });

    it("5. WorkflowMediaRepository.setPrimaryMedia propagates genuine database failures", async () => {
        const repo = new WorkflowMediaRepository();
        repo._isMemoryMode = () => false;

        const fakeError = new Error("connection to database lost");
        fakeError.code = "08006"; // PostgreSQL connection failure

        repo._getClientOrThrow = () => ({
            rpc: async () => ({ data: null, error: fakeError }),
            from: () => {
                throw new Error("Should not reach fallback on genuine DB failure");
            },
        });

        await assert.rejects(
            async () => {
                await repo.setPrimaryMedia({ workflowId: "wf-1", mediaId: "m-1" });
            },
            (err) => {
                assert.equal(err.message, "connection to database lost");
                assert.equal(err.code, "08006");
                return true;
            }
        );
    });

    it("6. Element PATCH /api/v2/elements/:id with primaryMediaId switches Cover atomically", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestElementMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Dragon Statue",
            projectId: "proj-1",
            userId: "user-1",
        });

        // Add 2 reference images
        const img1 = await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/cover1.png",
            userId: "user-1",
        });
        const img2 = await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/detail2.png",
            userId: "user-1",
        });

        // Initially img1 is Cover
        assert.equal(img1.media.is_primary, true);

        // Explicit switch to img2 using generic primaryMediaId
        const updated = await elementService.updateElement(
            element.id,
            { primaryMediaId: img2.media.id },
            "user-1"
        );

        assert.equal(updated.primaryMediaId, img2.media.id);
        assert.equal(updated.primary_media_url, "https://example.com/detail2.png");

        const primaryRelations = mockDb._store.workflowMedia.filter((wm) => wm.is_primary === true);
        assert.equal(primaryRelations.length, 1, "Exactly one primary relation allowed");
        assert.equal(primaryRelations[0].media_id, img2.media.id);
    });

    it("7. Element PATCH without primaryMediaId strictly preserves current Cover", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestElementMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Ancient Shield",
            description: "Old shield description",
            projectId: "proj-1",
            userId: "user-1",
        });

        await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/shield.png",
            userId: "user-1",
        });

        // PATCH description only (primaryMediaId omitted)
        const updated = await elementService.updateElement(
            element.id,
            { description: "New shield description" },
            "user-1"
        );

        assert.equal(updated.description, "New shield description");
        assert.equal(updated.primary_media_url, "https://example.com/shield.png", "Cover must remain unchanged when primaryMediaId is omitted");
    });

    it("8. Element PATCH with primaryMediaId: null explicitly clears the Cover", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestElementMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Mystic Ring",
            projectId: "proj-1",
            userId: "user-1",
        });

        await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/ring.png",
            userId: "user-1",
        });

        // Explicit clear via primaryMediaId: null
        const cleared = await elementService.updateElement(
            element.id,
            { primaryMediaId: null },
            "user-1"
        );

        assert.equal(cleared.primary_media_url, null);
        assert.equal(cleared.primaryMediaId, null);

        const primaries = mockDb._store.workflowMedia.filter((wm) => wm.is_primary === true);
        assert.equal(primaries.length, 0, "No primary media after explicit null");
    });

    it("9. Initial assignment (first upload) does NOT overwrite an established primary", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestElementMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Crystal Bow",
            projectId: "proj-1",
            userId: "user-1",
        });

        // First upload becomes Cover
        const first = await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/bow1.png",
            userId: "user-1",
        });
        assert.equal(first.media.is_primary, true);

        // Second upload must NOT overwrite Cover
        const second = await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/bow2.png",
            userId: "user-1",
        });
        assert.equal(second.media.is_primary, false, "Subsequent upload must not become primary");

        const primaryLinks = mockDb._store.workflowMedia.filter((wm) => wm.is_primary === true);
        assert.equal(primaryLinks.length, 1);
        assert.equal(primaryLinks[0].media_id, first.media.id);
    });

    it("10. Deleting primary media does NOT auto-promote another media; primary_media_url becomes null", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestElementMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Staff of Ages",
            projectId: "proj-1",
            userId: "user-1",
        });

        const cover = await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/staff_cover.png",
            userId: "user-1",
        });
        await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/staff_detail.png",
            userId: "user-1",
        });

        // Delete the Cover
        await mediaService.removeReferenceMedia({
            elementId: element.id,
            mediaId: cover.media.id,
            userId: "user-1",
        });

        const refreshed = await elementService.getElementById(element.id);
        assert.equal(refreshed.primary_media_url, null, "Deleting Cover must leave primary_media_url: null");

        const primaryLinks = mockDb._store.workflowMedia.filter((wm) => wm.is_primary === true);
        assert.equal(primaryLinks.length, 0, "Zero auto-promotion; no media is marked primary");
    });

    it("11. Controller PATCH /api/workflows/:id/primary-media supports primaryMediaId in req.body", async () => {
        const { setPrimaryMedia } = await import("../../controllers/workflowsController.js");
        const { workflowService } = await import("../../src/container.js");

        let invokedParams = null;
        const originalSetPrimary = workflowService.setPrimaryMedia;
        workflowService.setPrimaryMedia = async (params) => {
            invokedParams = params;
            return { primary_media_id: params.mediaId, primaryMediaId: params.mediaId };
        };

        try {
            let jsonResponse = null;
            let statusCode = 200;
            const req = {
                params: { id: "wf-ctrl-test" },
                body: { primaryMediaId: "media-uuid-999" },
                user: { id: "user-test" },
            };
            const res = {
                status: (code) => { statusCode = code; return res; },
                json: (payload) => { jsonResponse = payload; return res; },
            };

            await setPrimaryMedia(req, res);

            assert.equal(statusCode, 200);
            assert.equal(invokedParams?.mediaId, "media-uuid-999");
            assert.equal(jsonResponse?.ok, true);
            assert.equal(jsonResponse?.primaryMediaId, "media-uuid-999");
            assert.equal(jsonResponse?.primary_media_id, "media-uuid-999");
        } finally {
            workflowService.setPrimaryMedia = originalSetPrimary;
        }
    });
});
function createTestElementMediaService(mockDb) {
    const mockUploadService = {
        upload: async ({ files }) => ({
            uploaded: files.map((f, idx) => {
                const url = typeof f === "string" ? f : (f?.url || "https://example.com/uploaded.png");
                return { id: "media-upload-" + Date.now() + "-" + (idx + 1), url, step_id: "upload" };
            }),
        }),
        discard: async () => ({}),
    };
    const mockWorkflowMediaService = {
        attachMediaItems: async ({ workflowId, items, role = "detail", autoPrimary = true }) => {
            const attached = [];
            for (const item of items) {
                const existing = await mockDb.workflowMedia.findByWorkflow(workflowId);
                const isFirst = existing.length === 0;
                const isPrimary = isFirst && autoPrimary;
                const m = await mockDb.media.createMedia({
                    url: item.uploadedFile?.url || "https://example.com/m.png",
                    step_id: "upload",
                });
                const link = await mockDb.workflowMedia.linkMedia({
                    workflowId,
                    mediaId: m.id,
                    role,
                    is_primary: isPrimary,
                });
                attached.push({ media: m, link, is_primary: isPrimary });
            }
            return { attached };
        },
    };
    const mockAuthService = {
        verifyWorkflowOwnership: async () => true,
    };
    return new ElementMediaService({
        db: mockDb,
        storageService: {},
        mediaUploadService: mockUploadService,
        workflowMediaService: mockWorkflowMediaService,
        authService: mockAuthService,
    });
}


