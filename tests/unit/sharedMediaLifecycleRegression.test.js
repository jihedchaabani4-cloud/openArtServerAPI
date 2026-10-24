/**
 * Regression test: shared-media lifecycle correctness
 *
 * Requirements:
 * 1. Remove association first; delete media asset ONLY when zero associations remain anywhere.
 * 2. Delete only the specific workflow_media association identified by both workflow_id and media_id.
 *    Never globally unlink every relation matching only media_id.
 * 3. One media linked to workflows A and B; unlinking it from A leaves B and the binary intact.
 * 4. Unlinking the last remaining association deletes the media row and binary.
 * 5. Primary-media behavior:
 *    - Removing a non-primary association must not change another workflow's primary.
 *    - Removing the primary association must not auto-promote another image.
 *    - Removing a primary from A does not affect B's primary state.
 * 6. Database errors must propagate explicitly without swallowing failures or deleting media prematurely.
 * 7. Unauthorized / cross-tenant / missing entity removal returns 404.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CharacterMediaService } from "../../src/domain/character/CharacterMediaService.js";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";
import { WorkflowMediaService } from "../../src/platform/workflow/WorkflowMediaService.js";
import { WorkflowMediaRepository } from "../../src/db/WorkflowMediaRepository.js";
import { assertOwns, setDb } from "../../src/platform/security/ownership.js";

describe("Shared-Media Lifecycle Regression & Hardening", () => {

    beforeEach(() => {
        WorkflowMediaRepository.enableTestMemoryFallback();
        WorkflowMediaRepository.clearMemory();
    });

    afterEach(() => {
        WorkflowMediaRepository.clearMemory();
        WorkflowMediaRepository.disableTestMemoryFallback();
    });

    // ─── Real WorkflowMediaRepository Integration ─────────────────────────────

    it("Real WorkflowMediaRepository: Media linked to workflows A and B; unlinking from A leaves B and media intact", async () => {
        const repo = new WorkflowMediaRepository();
        const deletedMediaIds = [];
        const storageDeletes = [];

        const mediaId = "11111111-2222-3333-4444-555555555555";
        const wfA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        const wfB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

        // Link mediaId to both workflow A (primary) and workflow B (non-primary)
        await repo.linkMedia({ workflowId: wfA, mediaId, role: "detail", is_primary: true });
        await repo.linkMedia({ workflowId: wfB, mediaId, role: "detail", is_primary: false });

        assert.equal(await repo.countLinksForMedia(mediaId), 2);
        assert.equal((await repo.getPrimaryMedia(wfA))?.media_id, mediaId);

        const mockDb = {
            elements: {
                resolveRecord: async (id) => (id === "elem-A" ? { id: "elem-A", workflow_id: wfA } : null),
            },
            workflows: {
                findById: async (id) => ({ id }),
            },
            media: {
                findById: async (id) => ({ id, url: `https://storage.cdn/${id}.png` }),
                deleteById: async (id) => { deletedMediaIds.push(id); },
            },
            workflowMedia: repo,
        };

        const storageService = {
            deleteByUrl: async (url) => { storageDeletes.push(url); },
        };

        const elementMediaService = new ElementMediaService({
            db: mockDb,
            storageService,
            mediaUploadService: { upload: async () => ({ files: [], uploaded: [] }), discard: async () => ({}) },
            workflowMediaService: { attachMediaItems: async () => ({ attached: [] }) },
            authService: { verifyWorkflowOwnership: async () => true },
        });

        // Unlink from Element A
        const result = await elementMediaService.removeReferenceMedia({
            elementId: "elem-A",
            mediaId,
            userId: "user-1",
        });

        assert.equal(result.ok, true);

        // Workflow A should no longer have the relation or primary
        assert.equal(await repo.isMediaLinkedToWorkflow({ workflowId: wfA, mediaId }), false);
        assert.equal(await repo.getPrimaryMedia(wfA), null);

        // Workflow B MUST still have the relation!
        assert.equal(await repo.isMediaLinkedToWorkflow({ workflowId: wfB, mediaId }), true);
        assert.equal(await repo.countLinksForMedia(mediaId), 1);

        // Media row and storage MUST NOT be deleted
        assert.deepEqual(deletedMediaIds, [], "Media row must remain intact while linked to workflow B");
        assert.deepEqual(storageDeletes, [], "Storage file must remain intact while linked to workflow B");

        // Now unlink from workflow B (last remaining link)
        mockDb.elements.resolveRecord = async (id) => (id === "elem-B" ? { id: "elem-B", workflow_id: wfB } : null);

        const result2 = await elementMediaService.removeReferenceMedia({
            elementId: "elem-B",
            mediaId,
            userId: "user-1",
        });

        assert.equal(result2.ok, true);
        assert.equal(await repo.countLinksForMedia(mediaId), 0);

        // Media row and storage MUST now be deleted
        assert.deepEqual(deletedMediaIds, [mediaId], "Media row must be deleted when count is 0");
        assert.deepEqual(storageDeletes, [`https://storage.cdn/${mediaId}.png`], "Storage file must be deleted when count is 0");
    });

    it("Real WorkflowMediaRepository: Removing primary from workflow A preserves workflow B primary state", async () => {
        const repo = new WorkflowMediaRepository();
        const mediaA = "11111111-0000-0000-0000-000000000001";
        const mediaB = "22222222-0000-0000-0000-000000000002";
        const wfA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        const wfB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

        // wfA has mediaA as primary
        await repo.linkMedia({ workflowId: wfA, mediaId: mediaA, role: "detail", is_primary: true });
        // wfB has mediaB as primary
        await repo.linkMedia({ workflowId: wfB, mediaId: mediaB, role: "detail", is_primary: true });

        const mockDb = {
            elements: {
                resolveRecord: async (id) => (id === "elem-A" ? { id: "elem-A", workflow_id: wfA } : null),
            },
            workflows: {
                findById: async (id) => ({ id }),
            },
            media: {
                findById: async (id) => ({ id, url: `https://storage.cdn/${id}.png` }),
                deleteById: async () => {},
            },
            workflowMedia: repo,
        };

        const elementMediaService = new ElementMediaService({ db: mockDb, storageService: { deleteByUrl: async () => {} }, mediaUploadService: { upload: async () => ({ files: [], uploaded: [] }), discard: async () => ({}) }, workflowMediaService: { attachMediaItems: async () => ({ attached: [] }) }, authService: { verifyWorkflowOwnership: async () => true } });

        await elementMediaService.removeReferenceMedia({
            elementId: "elem-A",
            mediaId: mediaA,
            userId: "user-1",
        });

        // wfA primary is cleared
        assert.equal(await repo.getPrimaryMedia(wfA), null);

        // wfB primary is COMPLETELY UNTOUCHED
        const primaryB = await repo.getPrimaryMedia(wfB);
        assert.equal(primaryB?.media_id, mediaB, "Workflow B primary must not be modified when unlinking from workflow A");
    });

    // ─── CharacterMediaService Primary Preservation ───────────────────────────

    it("CharacterMediaService.removeDetailMedia: does NOT clear primary when removed media is non-primary", async () => {
        const clearCalls = [];
        const service = new CharacterMediaService({
            mediaUploadService: { upload: async () => ({}) },
            workflowMediaService: { attachMediaItems: async () => ({}) },
            authService: { verifyWorkflowOwnership: async () => true },
            db: {
                workflows: {
                    getWorkflow: async (id) => ({ id, user_id: "u1" }),
                },
                media: {
                    findById: async (id) => ({ id, url: "https://cdn/img.png", role: "detail", mediaRole: "detail" }),
                    deleteById: async () => {},
                },
                workflowMedia: {
                    findByMedia: async () => [{ workflow_id: "wf-1", media_id: "m-detail", role: "detail" }],
                    unlink: async () => {},
                    countLinksForMedia: async () => 0,
                    getPrimaryMedia: async () => ({ media_id: "m-OTHER-PRIMARY" }),
                    clearPrimaryMedia: async (args) => { clearCalls.push(args); },
                },
            },
            storageService: { deleteByUrl: async () => {} },
        });

        await service.removeDetailMedia({
            characterId: "wf-1",
            mediaId: "m-detail",
            userId: "u1",
        });

        assert.equal(clearCalls.length, 0, "clearPrimaryMedia must NOT be called for non-primary media");
    });

    it("CharacterMediaService.removeDetailMedia: clears primary only when removed media IS primary", async () => {
        const clearCalls = [];
        const service = new CharacterMediaService({
            mediaUploadService: { upload: async () => ({}) },
            workflowMediaService: { attachMediaItems: async () => ({}) },
            authService: { verifyWorkflowOwnership: async () => true },
            db: {
                workflows: {
                    getWorkflow: async (id) => ({ id, user_id: "u1" }),
                },
                media: {
                    findById: async (id) => ({ id, url: "https://cdn/img.png", role: "detail", mediaRole: "detail" }),
                    deleteById: async () => {},
                },
                workflowMedia: {
                    findByMedia: async () => [{ workflow_id: "wf-1", media_id: "m-primary", role: "detail" }],
                    unlink: async () => {},
                    countLinksForMedia: async () => 0,
                    getPrimaryMedia: async () => ({ media_id: "m-primary" }),
                    clearPrimaryMedia: async (args) => { clearCalls.push(args); },
                },
            },
            storageService: { deleteByUrl: async () => {} },
        });

        await service.removeDetailMedia({
            characterId: "wf-1",
            mediaId: "m-primary",
            userId: "u1",
        });

        assert.equal(clearCalls.length, 1, "clearPrimaryMedia must be called when removed media is primary");
        assert.deepEqual(clearCalls[0], { workflowId: "wf-1" });
    });

    // ─── Database Error Handling & No Swallowing ──────────────────────────────

    it("ElementMediaService.removeReferenceMedia: DB error in unlink propagates and does NOT delete media", async () => {
        let mediaDeleted = false;
        let storageDeleted = false;

        const service = new ElementMediaService({
            mediaUploadService: { upload: async () => ({ files: [], uploaded: [] }), discard: async () => ({}) },
            workflowMediaService: { attachMediaItems: async () => ({ attached: [] }) },
            authService: { verifyWorkflowOwnership: async () => true },
            storageService: {},
            db: {
                elements: {
                    resolveRecord: async () => ({ id: "elem-1", workflow_id: "wf-1" }),
                },
                workflows: {
                    findById: async () => ({ id: "wf-1" }),
                },
                media: {
                    findById: async () => ({ id: "m-1", url: "https://cdn/1.png" }),
                    deleteById: async () => { mediaDeleted = true; },
                },
                workflowMedia: {
                    unlinkAndReapOrphan: async () => {
                        throw new Error("PostgreSQL connection terminated unexpectedly");
                    },
                },
            },
            storageService: {
                deleteByUrl: async () => { storageDeleted = true; },
            },
        });

        await assert.rejects(
            () => service.removeReferenceMedia({ elementId: "elem-1", mediaId: "m-1", userId: "u1" }),
            (err) => err.message.includes("PostgreSQL connection terminated"),
            "Database error in unlink must propagate to caller"
        );

        assert.equal(mediaDeleted, false, "Media must NOT be deleted if unlink throws");
        assert.equal(storageDeleted, false, "Storage must NOT be deleted if unlink throws");
    });

    it("ElementMediaService.removeReferenceMedia: DB error in unlinkAndReapOrphan propagates and does NOT delete media", async () => {
        let mediaDeleted = false;
        let storageDeleted = false;

        const service = new ElementMediaService({
            mediaUploadService: { upload: async () => ({ files: [], uploaded: [] }), discard: async () => ({}) },
            workflowMediaService: { attachMediaItems: async () => ({ attached: [] }) },
            authService: { verifyWorkflowOwnership: async () => true },
            storageService: {},
            db: {
                elements: {
                    resolveRecord: async () => ({ id: "elem-1", workflow_id: "wf-1" }),
                },
                workflows: {
                    findById: async () => ({ id: "wf-1" }),
                },
                media: {
                    findById: async () => ({ id: "m-1", url: "https://cdn/1.png" }),
                    deleteById: async () => { mediaDeleted = true; },
                },
                workflowMedia: {
                    unlinkAndReapOrphan: async () => {
                        throw new Error("Database timeout executing unlink_and_reap_orphan");
                    },
                },
            },
            storageService: {
                deleteByUrl: async () => { storageDeleted = true; },
            },
        });

        await assert.rejects(
            () => service.removeReferenceMedia({ elementId: "elem-1", mediaId: "m-1", userId: "u1" }),
            (err) => err.message.includes("Database timeout executing unlink_and_reap_orphan"),
            "Database error in unlinkAndReapOrphan must propagate to caller"
        );

        assert.equal(mediaDeleted, false, "Media must NOT be deleted if link count query fails");
        assert.equal(storageDeleted, false, "Storage must NOT be deleted if link count query fails");
    });

    // ─── Scope & Tenant Isolation ─────────────────────────────────────────────

    it("ElementMediaService.removeReferenceMedia: returns 404 when element not found", async () => {
        let unlinkCalled = false;

        const service = new ElementMediaService({
            mediaUploadService: { upload: async () => ({ files: [], uploaded: [] }), discard: async () => ({}) },
            workflowMediaService: { attachMediaItems: async () => ({ attached: [] }) },
            authService: { verifyWorkflowOwnership: async () => true },
            storageService: {},
            db: {
                elements: {
                    resolveRecord: async () => null,
                },
                workflowMedia: {
                    unlink: async () => { unlinkCalled = true; },
                },
            },
        });

        await assert.rejects(
            () => service.removeReferenceMedia({ elementId: "nonexistent-elem", mediaId: "m-1", userId: "u1" }),
            (err) => {
                assert.equal(err.statusCode, 404);
                assert.equal(err.errorCode, "NOT_FOUND");
                return true;
            }
        );

        assert.equal(unlinkCalled, false, "Must NEVER call unlink when element is not found");
    });

    // ─── WorkflowMediaService.deleteMedia Shared Lifecycle ───────────────────

    it("WorkflowMediaService.deleteMedia: when workflowId provided for shared media, unlinks ONLY from that workflow and preserves media and storage", async () => {
        const repo = new WorkflowMediaRepository();
        const mediaId = "11111111-2222-3333-4444-555555555555";
        const wfA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        const wfB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

        // Link media to wfA and wfB
        await repo.linkMedia({ workflowId: wfA, mediaId, role: "detail", is_primary: false });
        await repo.linkMedia({ workflowId: wfB, mediaId, role: "detail", is_primary: true });

        assert.equal(await repo.countLinksForMedia(mediaId), 2);

        const deletedMediaIds = [];
        const deletedStorageUrls = [];

        const mockDb = {
            media: {
                findById: async (id) => ({ id, url: `https://storage.cdn/${id}.png` }),
                deleteById: async (id) => { deletedMediaIds.push(id); return true; },
                findByWorkflow: async (wid) => (wid === wfA ? [] : [{ id: mediaId }]),
            },
            workflows: {
                findById: async (wid) => ({ id: wid, user_id: "user-1" }),
            },
            workflowMedia: repo,
        };

        const storageService = {
            deleteByUrl: async (url) => { deletedStorageUrls.push(url); },
        };
        const authService = {
            verifyMediaOwnership: async () => true,
            verifyWorkflowOwnership: async () => true,
        };

        const service = new WorkflowMediaService({ db: mockDb, storageService, authService, mediaUploadService: { discard: async () => ({}) } });

        const result = await service.deleteMedia({
            mediaId,
            workflowId: wfA,
            userId: "user-1",
        });

        // Relation to wfA unlinked
        assert.equal(await repo.isMediaLinkedToWorkflow({ workflowId: wfA, mediaId }), false);

        // Relation to wfB STILL INTACT
        assert.equal(await repo.isMediaLinkedToWorkflow({ workflowId: wfB, mediaId }), true);
        assert.equal(await repo.countLinksForMedia(mediaId), 1);

        // Media row and storage MUST NOT be deleted
        assert.deepEqual(deletedMediaIds, [], "Media row must remain intact while linked to workflow B");
        assert.deepEqual(deletedStorageUrls, [], "Storage must remain intact while linked to workflow B");
        assert.equal(result.deleted, false, "result.deleted should be false when media is preserved");
    });

    // ─── assertOwns('element') Hardening ─────────────────────────────────────

    it("assertOwns('element'): resolves ownership when db.workflows only provides findById and user_id matches", async () => {
        const mockDb = {
            elements: {
                resolveRecord: async (id) => (id === "elem-123" ? { id: "elem-123", workflow_id: "wf-123" } : null),
            },
            workflows: {
                // ONLY findById is defined, NOT getWorkflow — ensures our new fallback works
                findById: async (id) => (id === "wf-123" ? { id: "wf-123", user_id: "owner-user" } : null),
            },
            projects: {
                findByUser: async () => [],
            },
        };

        // Inject mock db into the ownership module so the test stays hermetic
        setDb(mockDb);
        try {
            const resource = await assertOwns("element", "elem-123", "owner-user");
            assert.equal(resource.id, "elem-123");
        } finally {
            // Always restore so other tests are unaffected
            setDb(null);
        }
    });
});
