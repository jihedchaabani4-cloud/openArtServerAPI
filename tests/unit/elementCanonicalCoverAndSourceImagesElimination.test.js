import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ElementService } from "../../src/domain/element/ElementService.js";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";

describe("Element Canonical Cover via workflow_media.is_primary & sourceImages Elimination", () => {
    function createMockDb() {
        const workflows = [];
        const elements = [];
        const media = [];
        const workflowMedia = [];

        return {
            workflows: {
                createWorkflow: async (payload) => {
                    const row = { id: `wf-${workflows.length + 1}`, ...payload };
                    workflows.push(row);
                    return row;
                },
                getPrimaryMediaUrl: async (workflowId) => {
                    const link = workflowMedia.find((wm) => wm.workflow_id === workflowId && wm.is_primary === true);
                    if (!link) return null;
                    const m = media.find((med) => med.id === link.media_id);
                    return m?.url || null;
                },
                getPrimaryMedia: async (workflowId) => {
                    const link = workflowMedia.find((wm) => wm.workflow_id === workflowId && wm.is_primary === true);
                    if (!link) return null;
                    const m = media.find((med) => med.id === link.media_id);
                    return m ? { ...m, is_primary: true } : null;
                },
                updatePrimaryMedia: async (workflowId, mediaId) => {
                    for (const wm of workflowMedia) {
                        if (wm.workflow_id === workflowId) {
                            wm.is_primary = (wm.media_id === mediaId);
                        }
                    }
                    return { workflow_id: workflowId, media_id: mediaId, is_primary: true };
                },
            },
            elements: {
                create: async (payload) => {
                    const row = { id: `00000000-0000-0000-0000-00000000000${elements.length + 1}`, ...payload };
                    elements.push(row);
                    return row;
                },
                resolveRecord: async (id) => {
                    return elements.find((e) => e.id === id || e.workflow_id === id) || null;
                },
                findById: async (id) => elements.find((e) => e.id === id) || null,
                list: async ({ projectId }) => elements.filter((e) => !projectId || e.project_id === projectId),
            },
            media: {
                createMedia: async (payload) => {
                    const row = { id: `media-${media.length + 1}`, ...payload };
                    media.push(row);
                    return row;
                },
                findByWorkflow: async (workflowId) => {
                    const links = workflowMedia.filter((wm) => wm.workflow_id === workflowId);
                    return links.map((l) => {
                        const m = media.find((med) => med.id === l.media_id);
                        return { ...(m || {}), role: l.role, is_primary: l.is_primary };
                    });
                },
                findById: async (id) => media.find((m) => m.id === id) || null,
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
                findByWorkflowIds: async (workflowIds) => {
                    return workflowMedia.filter((wm) => workflowIds.includes(wm.workflow_id));
                },
                setPrimaryMedia: async ({ workflowId, mediaId }) => {
                    let found = false;
                    for (const wm of workflowMedia) {
                        if (wm.workflow_id === workflowId) {
                            if (wm.media_id === mediaId) {
                                wm.is_primary = true;
                                found = true;
                            } else {
                                wm.is_primary = false;
                            }
                        }
                    }
                    if (!found) {
                        workflowMedia.push({ workflow_id: workflowId, media_id: mediaId, role: "detail", is_primary: true });
                    }
                    return { workflow_id: workflowId, media_id: mediaId, is_primary: true };
                },
                unlink: async ({ workflowId, mediaId }) => {
                    const idx = workflowMedia.findIndex((wm) => (!workflowId || wm.workflow_id === workflowId) && wm.media_id === mediaId);
                    if (idx >= 0) workflowMedia.splice(idx, 1);
                    return true;
                },
                unlinkMedia: async ({ workflowId, mediaId }) => {
                    const idx = workflowMedia.findIndex((wm) => wm.workflow_id === workflowId && wm.media_id === mediaId);
                    if (idx >= 0) workflowMedia.splice(idx, 1);
                    return true;
                },
                countLinksForMedia: async (mediaId) => {
                    return workflowMedia.filter((wm) => wm.media_id === mediaId).length;
                },
            },
            _store: { workflows, elements, media, workflowMedia },
        };
    }

    it("1. Element creation creates container without reading or writing sourceImages / source_images", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestElementMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const result = await elementService.createElement({
            name: "Cyberpunk Visor",
            description: "High-tech optical gear",
            projectId: "proj-1",
            tags: ["prop", "scifi"],
            userId: "user-1",
        });

        assert.ok(result.element.id, "Element record must be created");
        assert.equal(result.element.name, "Cyberpunk Visor");
        assert.equal(result.element.source_images, undefined, "Must NOT store source_images column");
        assert.equal(result.element.primary_media_url, null, "Initially no cover URL");
        assert.equal(result.element.reference_images_count, 0, "Initially 0 reference images");
        assert.equal(result.element.source_images_count, 0, "Compatibility alias is 0");
    });

    it("2 & 3. Initial Element image attachment sets is_primary: true; second image receives is_primary: false", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestElementMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Potion Bottle",
            projectId: "proj-1",
            userId: "user-1",
        });

        // Add first image -> must become Cover (is_primary: true)
        const first = await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/potion_front.png",
            userId: "user-1",
        });

        const relationsAfterFirst = mockDb._store.workflowMedia;
        assert.equal(relationsAfterFirst.length, 1);
        assert.equal(relationsAfterFirst[0].role, "detail");
        assert.equal(relationsAfterFirst[0].is_primary, true, "First image must be set as Cover (is_primary: true)");

        // Add second image -> must NOT replace Cover (is_primary: false)
        const second = await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/potion_side.png",
            userId: "user-1",
        });

        const relationsAfterSecond = mockDb._store.workflowMedia;
        assert.equal(relationsAfterSecond.length, 2);
        assert.equal(relationsAfterSecond[1].role, "detail");
        assert.equal(relationsAfterSecond[1].is_primary, false, "Second image must have is_primary: false");
        assert.equal(relationsAfterSecond.filter((r) => r.is_primary).length, 1, "Exactly one image may be primary");
    });

    it("4 & 5. Explicit Cover replacement switches is_primary atomically", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestElementMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Magic Shield",
            projectId: "proj-1",
            userId: "user-1",
        });

        await mediaService.addReferenceMedia({ elementId: element.id, imageUrl: "https://example.com/shield_front.png", userId: "user-1" });
        await mediaService.addReferenceMedia({ elementId: element.id, imageUrl: "https://example.com/shield_back.png", userId: "user-1" });

        const mediaRows = mockDb._store.media;
        const secondMediaId = mediaRows[1].id;

        // Switch cover to second image
        await elementService.setElementCover({
            elementId: element.id,
            mediaId: secondMediaId,
            userId: "user-1",
        });

        const primaryLink = mockDb._store.workflowMedia.find((wm) => wm.is_primary === true);
        assert.ok(primaryLink);
        assert.equal(primaryLink.media_id, secondMediaId, "Second media must now be the Cover");
        assert.equal(mockDb._store.workflowMedia.filter((wm) => wm.is_primary).length, 1, "Still strictly one primary");
    });

    it("6. Removing the Cover leaves no primary relation and does NOT auto-promote another image", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestElementMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Dragon Helm",
            projectId: "proj-1",
            userId: "user-1",
        });

        await mediaService.addReferenceMedia({ elementId: element.id, imageUrl: "https://example.com/helm_front.png", userId: "user-1" });
        await mediaService.addReferenceMedia({ elementId: element.id, imageUrl: "https://example.com/helm_side.png", userId: "user-1" });

        const firstMediaId = mockDb._store.media[0].id;

        // Remove the Cover image
        await mediaService.removeReferenceMedia({
            elementId: element.id,
            mediaId: firstMediaId,
            userId: "user-1",
        });

        const remainingRelations = mockDb._store.workflowMedia;
        assert.equal(remainingRelations.length, 1, "Only one relation remains");
        assert.equal(remainingRelations[0].is_primary, false, "Remaining image must NOT be auto-promoted to primary");

        // getElementById must return null for primary_media_url
        const fetched = await elementService.getElementById(element.id);
        assert.equal(fetched.primary_media_url, null, "primary_media_url must be null when cover was deleted");
        assert.equal(fetched.reference_images_count, 1);
        assert.equal(fetched.source_images_count, 1);
    });

    it("7 & 8. Reads resolve Cover from is_primary relation, not array index [0]", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestElementMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Crystal Orb",
            projectId: "proj-1",
            userId: "user-1",
        });

        await mediaService.addReferenceMedia({ elementId: element.id, imageUrl: "https://example.com/orb_1.png", userId: "user-1" });
        await mediaService.addReferenceMedia({ elementId: element.id, imageUrl: "https://example.com/orb_2.png", userId: "user-1" });

        // Switch cover to orb_2
        const secondMediaId = mockDb._store.media[1].id;
        await elementService.setElementCover({ elementId: element.id, mediaId: secondMediaId, userId: "user-1" });

        const fetched = await elementService.getElementById(element.id);
        assert.equal(fetched.primary_media_url, "https://example.com/orb_2.png", "Must resolve from is_primary, not index 0");
        assert.equal(fetched.reference_images_count, 2);
    });

    it("9. setElementCover rejects mediaId that does not belong to the Element workflow", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestElementMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Spellbook",
            projectId: "proj-1",
            userId: "user-1",
        });

        await assert.rejects(
            async () => {
                await elementService.setElementCover({
                    elementId: element.id,
                    mediaId: "foreign-media-id-999",
                    userId: "user-1",
                });
            },
            /does not belong to element workflow|INVALID_MEDIA/
        );
    });

    it("10. Controller createElement succeeds with 201 without sourceImages in req.body", async () => {
        const { createElement } = await import("../../controllers/elementController.js");
        const { db, elementService } = await import("../../src/container.js");

        const originalCreate = elementService.createElement;
        const originalFindByUser = db.projects?.findByUser;
        db.projects = {
            ...db.projects,
            findByUser: async (userId, id) => [{ id, user_id: userId }],
        };
        elementService.createElement = async (params) => {
            assert.equal(params.sourceImages, undefined);
            return {
                element: { id: "elem-ctrl-1", name: params.name },
                workflow: { id: "wf-ctrl-1" },
            };
        };

        try {
            const req = {
                user: { id: "user-ctrl-1" },
                body: { name: "No SourceImages Element", projectId: "proj-1" },
            };
            let resCode = null;
            let resBody = null;
            const res = {
                status(code) { resCode = code; return this; },
                json(data) { resBody = data; return this; },
            };

            await createElement(req, res);
            assert.equal(resCode, 201);
            assert.equal(resBody.status, "created");
            assert.equal(resBody.element.id, "elem-ctrl-1");
        } finally {
            elementService.createElement = originalCreate;
            if (originalFindByUser) db.projects.findByUser = originalFindByUser;
        }
    });

    it("11. Controller updateElement updates cover and enforces validation via PATCH /api/v2/elements/:id", async () => {
        const { updateElement } = await import("../../controllers/elementController.js");
        const { elementService, db } = await import("../../src/container.js");

        const originalUpdate = elementService.updateElement;
        const origResolve = db.elements?.resolveRecord;
        const origProjects = db.projects?.findByUser;
        const origGetWf = db.workflows?.getWorkflow;

        if (db.elements) db.elements.resolveRecord = async (id) => ({ id, workflow_id: "wf-1" });
        if (db.workflows) db.workflows.getWorkflow = async (id) => ({ id, project_id: "proj-1" });
        if (db.projects) db.projects.findByUser = async (u, p) => [{ id: p, user_id: u }];

        elementService.updateElement = async (id, patch, userId) => {
            return {
                id,
                coverMediaId: patch.coverMediaId,
                primary_media_url: patch.coverMediaId ? `https://example.com/${patch.coverMediaId}.png` : null,
            };
        };

        try {
            let okCode = null;
            let okBody = null;
            const okRes = {
                status(c) { okCode = c; return this; },
                json(d) { okBody = d; return this; },
            };
            await updateElement({ params: { id: "elem-1" }, body: { coverMediaId: "media-valid-1" }, user: { id: "user-1" } }, okRes);
            assert.equal(okBody.status, "success");
            assert.equal(okBody.element.coverMediaId, "media-valid-1");
            assert.equal(okBody.element.primary_media_url, "https://example.com/media-valid-1.png");
        } finally {
            elementService.updateElement = originalUpdate;
            if (db.elements && origResolve) db.elements.resolveRecord = origResolve;
            if (db.workflows && origGetWf) db.workflows.getWorkflow = origGetWf;
            if (db.projects && origProjects) db.projects.findByUser = origProjects;
        }
    });
});
function createTestElementMediaService(mockDb) {
    return new ElementMediaService({
        db: mockDb,
        storageService: {},
        mediaUploadService: {
            upload: async ({ files }) => ({
                uploaded: files.map((f, idx) => ({ id: "media-" + (mockDb._store.media.length + idx + 1), url: typeof f === "string" ? f : f?.url || "https://example.com/m.png", step_id: "upload" })),
            }),
            discard: async () => ({}),
        },
        workflowMediaService: {
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
        },
        authService: {
            verifyWorkflowOwnership: async () => true,
        },
    });
}


