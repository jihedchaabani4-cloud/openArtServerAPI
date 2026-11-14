import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WorkflowMediaRepository } from "#media/tools";
import { ElementMediaService } from "#elements/tools";
import { ElementService } from "#elements/tools";

describe("Element Cover Concurrency and Lifecycle Boundary Contract", () => {
    let repo;
    let mediaStore;
    let elementsStore;
    let mockDb;
    let mediaService;
    let elementService;

    const ELEMENT_ID = "00000000-0000-0000-0000-000000000001";
    const WORKFLOW_ID = "wf-concurrency-test-1";
    const PROJECT_ID = "proj-1";

    beforeEach(() => {
        WorkflowMediaRepository.enableTestMemoryFallback();
        WorkflowMediaRepository.clearMemory();

        repo = new WorkflowMediaRepository();
        mediaStore = [];
        elementsStore = [
            {
                id: ELEMENT_ID,
                workflow_id: WORKFLOW_ID,
                project_id: PROJECT_ID,
                name: "Relic of Eternity",
                description: "An ancient elemental artifact",
                create_time: new Date().toISOString(),
            },
        ];

        mockDb = {
            elements: {
                resolveRecord: async (id) => elementsStore.find((e) => e.id === id || e.workflow_id === id) || null,
                findById: async (id) => elementsStore.find((e) => e.id === id) || null,
                list: async ({ projectId }) => elementsStore.filter((e) => !projectId || e.project_id === projectId),
            },
            workflows: {
                getPrimaryMediaUrl: async (wfId) => {
                    const relations = await repo.findByWorkflow(wfId);
                    const primary = relations.find((r) => r.is_primary);
                    if (!primary) return null;
                    const m = mediaStore.find((med) => med.id === (primary.media_id || primary.id));
                    return m?.url || null;
                },
                getPrimaryMedia: async (wfId) => {
                    return repo.getPrimaryMedia(wfId);
                },
            },
            media: {
                createMedia: async ({ url, project_id }) => {
                    // Small jitter simulates network/storage latency
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    const row = { id: `m-${mediaStore.length + 1}`, url, project_id };
                    mediaStore.push(row);
                    return row;
                },
                findByWorkflow: async (wfId) => {
                    const relations = await repo.findByWorkflow(wfId);
                    return relations.map((r) => {
                        const m = mediaStore.find((med) => med.id === (r.media_id || r.id));
                        return { ...(m || {}), role: r.role, is_primary: r.is_primary };
                    });
                },
                findById: async (id) => mediaStore.find((m) => m.id === id) || null,
                deleteById: async (id) => {
                    const idx = mediaStore.findIndex((m) => m.id === id);
                    if (idx >= 0) mediaStore.splice(idx, 1);
                },
            },
            workflowMedia: repo,
        };

        mediaService = new ElementMediaService({
            db: mockDb,
            storageService: {},
            mediaUploadService: {
                upload: async ({ files }) => ({
                    uploaded: files.map((f, idx) => ({ id: "media-" + (mediaStore.length + idx + 1), url: typeof f === "string" ? f : f?.url || "https://example.com/m.png", step_id: "upload" })),
                }),
                discard: async () => ({}),
            },
            workflowMediaService: {
                attachMediaItems: async ({ workflowId, items, role = "detail", autoPrimary = true }) => {
                    const attached = [];
                    for (const item of items) {
                        const existing = await repo.findByWorkflow(workflowId);
                        const isFirst = existing.length === 0;
                        const isPrimary = isFirst && autoPrimary;
                        const m = await mockDb.media.createMedia({
                            url: item.uploadedFile?.url || "https://example.com/m.png",
                            step_id: "upload",
                        });
                        const link = await repo.linkMedia({
                            workflowId,
                            mediaId: m.id,
                            role,
                            is_primary: isPrimary,
                        });
                        attached.push({ media: m, link, is_primary: isPrimary });
                    }
                    return { attached };
                },
            },
            authService: {
                verifyWorkflowOwnership: async () => true,
            },
        });
        elementService = new ElementService({ db: mockDb, mediaService });
    });

    afterEach(() => {
        WorkflowMediaRepository.disableTestMemoryFallback();
    });

    it("1 & 2. Simultaneous initial uploads cannot create >1 primary relation or replace established Cover ('first attachment wins')", async () => {
        // Execute two uploads concurrently against an Element with NO initial media
        const [uploadA, uploadB] = await Promise.all([
            mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                imageUrl: "https://example.com/asset_first.png",
                userId: "user-1",
            }),
            mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                imageUrl: "https://example.com/asset_second.png",
                userId: "user-1",
            }),
        ]);

        // Both uploads must succeed without errors
        assert.equal(uploadA.ok, true, "Upload A must succeed");
        assert.equal(uploadB.ok, true, "Upload B must succeed");

        // Inspect persisted relations in real WorkflowMediaRepository
        const relations = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(relations.length, 2, "Both images must be linked to workflow_media");

        // Exactly one primary relation exists
        const primaryRelations = relations.filter((r) => r.is_primary);
        assert.equal(primaryRelations.length, 1, "Must contain EXACTLY one primary relation");

        // The first attached image is the established Cover; the second image is a detail reference
        const firstMediaId = uploadA.media.id;
        const secondMediaId = uploadB.media.id;

        const firstRel = relations.find((r) => (r.media_id || r.id) === firstMediaId);
        const secondRel = relations.find((r) => (r.media_id || r.id) === secondMediaId);

        assert.equal(firstRel.is_primary, true, "First attachment must be primary Cover");
        assert.equal(secondRel.is_primary, false, "Second attachment must NOT replace established Cover");
    });

    it("3. Subsequent upload after established Cover preserves Cover untouched", async () => {
        // Initial upload establishes Cover
        await mediaService.addReferenceMedia({
            elementId: ELEMENT_ID,
            imageUrl: "https://example.com/cover_initial.png",
            userId: "user-1",
        });

        // Later upload
        const later = await mediaService.addReferenceMedia({
            elementId: ELEMENT_ID,
            imageUrl: "https://example.com/reference_later.png",
            userId: "user-1",
        });

        assert.equal(later.ok, true);
        assert.equal(later.media.is_primary, false, "Later upload must have is_primary: false");

        const relations = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(relations.length, 2);
        assert.equal(relations[0].is_primary, true, "Initial Cover preserved");
        assert.equal(relations[1].is_primary, false, "New image is detail reference");
    });

    it("4. Deleting a non-cover reference image does NOT clear or change the existing Cover", async () => {
        const coverUpload = await mediaService.addReferenceMedia({
            elementId: ELEMENT_ID,
            imageUrl: "https://example.com/cover.png",
            userId: "user-1",
        });
        const detailUpload = await mediaService.addReferenceMedia({
            elementId: ELEMENT_ID,
            imageUrl: "https://example.com/detail.png",
            userId: "user-1",
        });

        // Delete the non-cover image
        await mediaService.removeReferenceMedia({
            elementId: ELEMENT_ID,
            mediaId: detailUpload.media.id,
            userId: "user-1",
        });

        // Verify Cover is untouched
        const relations = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(relations.length, 1);
        assert.equal(relations[0].is_primary, true, "Cover must remain is_primary = true");

        const detail = await elementService.getElementById(ELEMENT_ID);
        assert.equal(detail.primary_media_url, "https://example.com/cover.png");
        assert.equal(detail.reference_images_count, 1);
    });

    it("5. Deleting the Cover image leaves primary_media_url: null and does NOT auto-promote remaining images", async () => {
        const coverUpload = await mediaService.addReferenceMedia({
            elementId: ELEMENT_ID,
            imageUrl: "https://example.com/cover.png",
            userId: "user-1",
        });
        const detailUpload = await mediaService.addReferenceMedia({
            elementId: ELEMENT_ID,
            imageUrl: "https://example.com/detail.png",
            userId: "user-1",
        });

        // Delete the Cover image
        await mediaService.removeReferenceMedia({
            elementId: ELEMENT_ID,
            mediaId: coverUpload.media.id,
            userId: "user-1",
        });

        // Inspect workflow_media relations
        const relations = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(relations.length, 1);
        assert.equal(relations[0].media_id, detailUpload.media.id);
        assert.equal(relations[0].is_primary, false, "Remaining image must NOT be auto-promoted to Cover");

        // Detail and list reads must show primary_media_url = null
        const detail = await elementService.getElementById(ELEMENT_ID);
        assert.equal(detail.primary_media_url, null, "primary_media_url must be null");
        assert.equal(detail.reference_images_count, 1, "Remaining count is 1");

        const list = await elementService.listProjectElements(PROJECT_ID);
        assert.equal(list[0].primary_media_url, null, "List primary_media_url must be null");
        assert.equal(list[0].reference_images_count, 1, "List count is 1");
    });

    it("6. Detail and list reads resolve Cover and counts strictly from canonical workflow_media", async () => {
        await mediaService.addReferenceMedia({
            elementId: ELEMENT_ID,
            imageUrl: "https://example.com/img1.png",
            userId: "user-1",
        });
        await mediaService.addReferenceMedia({
            elementId: ELEMENT_ID,
            imageUrl: "https://example.com/img2.png",
            userId: "user-1",
        });
        await mediaService.addReferenceMedia({
            elementId: ELEMENT_ID,
            imageUrl: "https://example.com/img3.png",
            userId: "user-1",
        });

        const detail = await elementService.getElementById(ELEMENT_ID);
        assert.equal(detail.primary_media_url, "https://example.com/img1.png");
        assert.equal(detail.reference_images_count, 3);
        assert.equal(detail.source_images_count, 3);
        assert.deepEqual(detail.reference_images, [
            "https://example.com/img1.png",
            "https://example.com/img2.png",
            "https://example.com/img3.png",
        ]);

        const list = await elementService.listProjectElements(PROJECT_ID);
        assert.equal(list.length, 1);
        assert.equal(list[0].primary_media_url, "https://example.com/img1.png");
        assert.equal(list[0].reference_images_count, 3);
        assert.equal(list[0].source_images_count, 3);
    });

    it("7. Gracefully handles database 23505 unique constraint race without failing the upload", async () => {
        // Mock a database client where client.rpc throws or is absent, and update returns unique violation error 23505
        const clientMock = {
            rpc: async () => ({ error: { message: "function not found" } }),
            from: () => ({
                select: () => ({
                    eq: () => ({
                        eq: () => ({
                            limit: () => ({
                                maybeSingle: async () => ({ data: null, error: null }),
                            }),
                        }),
                    }),
                }),
                update: () => ({
                    eq: () => ({
                        eq: () => ({
                            select: () => ({
                                maybeSingle: async () => {
                                    const err = new Error("duplicate key value violates unique constraint idx_workflow_media_single_primary");
                                    err.code = "23505";
                                    throw err;
                                },
                            }),
                        }),
                    }),
                }),
            }),
        };

        const customRepo = new WorkflowMediaRepository();
        customRepo.client = () => clientMock;

        // setPrimaryMediaIfNone must catch 23505 and return false cleanly
        const claimed = await customRepo.setPrimaryMediaIfNone({
            workflowId: WORKFLOW_ID,
            mediaId: "m-concurrent-loser",
        });
        assert.equal(claimed, false, "Must return false without throwing 23505 error");
    });
});
