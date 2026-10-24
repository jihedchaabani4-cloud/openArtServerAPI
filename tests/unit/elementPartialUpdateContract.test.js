import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ElementService } from "../../src/domain/element/ElementService.js";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";

describe("Element PATCH /api/v2/elements/:id Partial Update Contract", () => {
    function createMockDb() {
        const workflows = [];
        const elements = [];
        const media = [];
        const workflowMedia = [];

        return {
            workflows: {
                findById: async (id) => workflows.find((w) => w.id === id) || { id },
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
                updatePrimaryMedia: async (workflowId, mediaId) => {
                    for (const wm of workflowMedia) {
                        if (wm.workflow_id === workflowId) {
                            wm.is_primary = (wm.media_id === mediaId);
                        }
                    }
                    return { workflow_id: workflowId, media_id: mediaId, is_primary: true };
                },
                updateFields: async (workflowId, fields) => {
                    const wf = workflows.find((w) => w.id === workflowId);
                    if (wf) Object.assign(wf, fields);
                    return wf || { id: workflowId, ...fields };
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
                update: async (id, patch) => {
                    const el = elements.find((e) => e.id === id || e.workflow_id === id);
                    if (!el) return null;
                    Object.assign(el, patch);
                    return el;
                },
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
            },
            _store: { workflows, elements, media, workflowMedia },
        };
    }

    function createTestMediaService(mockDb) {
        return new ElementMediaService({
            db: mockDb,
            storageService: {
                deleteByUrl: async () => {},
            },
            mediaUploadService: {
                upload: async ({ files }) => {
                    const uploaded = (files || []).map((f, i) => {
                        const url = typeof f === "string" ? f : f?.url || "https://example.com/cover.png";
                        return {
                            storageKey: `key-${Date.now()}-${i}`,
                            url,
                            mimeType: "image/png",
                            size: 1024,
                            type: "image",
                            width: 512,
                            height: 512,
                            ratio: "1:1",
                            format: "png",
                            durationSec: null,
                            originalName: "test.png",
                        };
                    });
                    return { uploaded, files: uploaded };
                },
                discard: async () => ({}),
            },
            workflowMediaService: {
                attachMediaItems: async ({ workflowId, projectId, userId, role, items }) => {
                    const attached = [];
                    for (const item of items) {
                        let mediaRecord = item.media;
                        if (!mediaRecord) {
                            const url = item.uploadedFile?.url || "https://example.com/cover.png";
                            mediaRecord = await mockDb.media.createMedia({
                                url,
                                user_id: userId,
                                project_id: projectId,
                            });
                        }
                        const existing = await mockDb.workflowMedia.findByWorkflow(workflowId);
                        const isPrimary = existing.length === 0;
                        const link = await mockDb.workflowMedia.linkMedia({
                            workflowId,
                            mediaId: mediaRecord.id,
                            role: role || "detail",
                            is_primary: isPrimary,
                        });
                        attached.push({ link, media: mediaRecord, is_primary: isPrimary });
                    }
                    return { attached };
                },
                rollbackAttachedMedia: async () => ({ complete: true }),
            },
            authService: {
                verifyWorkflowOwnership: async () => true,
            },
        });
    }

    it("1. Single-field update (name only): changes name and workflow display_name, preserves omitted description and Cover", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Initial Name",
            description: "Keep this untouched",
            projectId: "proj-1",
            userId: "user-1",
        });

        // Add initial image which becomes Cover
        await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/cover.png",
            userId: "user-1",
        });

        // PATCH name only
        const updated = await elementService.updateElement(element.id, { name: "Updated Name" }, "user-1");

        assert.equal(updated.name, "Updated Name");
        assert.equal(updated.description, "Keep this untouched", "Omitted description must not be overwritten or set to null");
        assert.equal(updated.primary_media_url, "https://example.com/cover.png", "Omitted coverMediaId must preserve existing Cover");

        // Workflow display_name kept in sync
        const wf = mockDb._store.workflows.find((w) => w.id === element.workflow_id);
        assert.equal(wf.display_name, "Updated Name");
    });

    it("2. Single-field update (description only): changes description, preserves omitted name and Cover", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Steady Name",
            description: "Old description",
            projectId: "proj-1",
            userId: "user-1",
        });

        await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/cover.png",
            userId: "user-1",
        });

        // PATCH description only
        const updated = await elementService.updateElement(element.id, { description: "Brand new description" }, "user-1");

        assert.equal(updated.name, "Steady Name", "Omitted name must remain unchanged");
        assert.equal(updated.description, "Brand new description");
        assert.equal(updated.primary_media_url, "https://example.com/cover.png", "Cover must remain unchanged");
    });

    it("3. Multi-field update: updates name, description, and guidelines together; preserves omitted coverMediaId", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Original Name",
            description: "Original Description",
            projectId: "proj-1",
            userId: "user-1",
        });

        await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/cover.png",
            userId: "user-1",
        });

        const updated = await elementService.updateElement(element.id, {
            name: "Multi-Updated Name",
            description: "Multi-Updated Description",
            guidelines: "Strict guidelines",
        }, "user-1");

        assert.equal(updated.name, "Multi-Updated Name");
        assert.equal(updated.description, "Multi-Updated Description");
        assert.equal(updated.guidelines, "Strict guidelines");
        assert.equal(updated.primary_media_url, "https://example.com/cover.png", "Cover preserved");
    });

    it("4. Atomic Cover change via coverMediaId: switches primary media when mediaId belongs to workflow", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Vehicle",
            description: "Cyberpunk Bike",
            projectId: "proj-1",
            userId: "user-1",
        });

        // Add 2 reference images
        await mediaService.addReferenceMedia({ elementId: element.id, imageUrl: "https://example.com/front.png", userId: "user-1" });
        await mediaService.addReferenceMedia({ elementId: element.id, imageUrl: "https://example.com/side.png", userId: "user-1" });

        const sideMediaId = mockDb._store.media[1].id;

        // PATCH with coverMediaId pointing to side.png
        const updated = await elementService.updateElement(element.id, {
            coverMediaId: sideMediaId,
        }, "user-1");

        assert.equal(updated.name, "Vehicle", "Name untouched");
        assert.equal(updated.description, "Cyberpunk Bike", "Description untouched");
        assert.equal(updated.primary_media_url, "https://example.com/side.png", "Primary media URL updated to side image");

        const primaryLinks = mockDb._store.workflowMedia.filter((wm) => wm.is_primary === true);
        assert.equal(primaryLinks.length, 1, "Exactly one primary link");
        assert.equal(primaryLinks[0].media_id, sideMediaId);
    });

    it("5. coverMediaId validation: rejects mediaId that does NOT belong to the Element workflow with 400", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Artifact",
            projectId: "proj-1",
            userId: "user-1",
        });

        await assert.rejects(
            async () => {
                await elementService.updateElement(element.id, { coverMediaId: "unrelated-foreign-media-99" }, "user-1");
            },
            (err) => {
                assert.equal(err.statusCode, 400);
                assert.match(err.message, /does not belong to element workflow/);
                return true;
            }
        );
    });

    it("6. Explicit coverMediaId: null clears the Cover relation; returns primary_media_url: null", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Relic",
            projectId: "proj-1",
            userId: "user-1",
        });

        await mediaService.addReferenceMedia({ elementId: element.id, imageUrl: "https://example.com/relic.png", userId: "user-1" });

        // Explicitly clear cover by passing coverMediaId: null
        const updated = await elementService.updateElement(element.id, {
            coverMediaId: null,
        }, "user-1");

        assert.equal(updated.primary_media_url, null, "primary_media_url must be null when coverMediaId is null");

        const primaryLinks = mockDb._store.workflowMedia.filter((wm) => wm.is_primary === true);
        assert.equal(primaryLinks.length, 0, "No media should have is_primary = true after explicit clear");
    });

    it("7. Never confuse omitted coverMediaId (undefined) with explicit coverMediaId: null", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService });

        const { element } = await elementService.createElement({
            name: "Gauntlet",
            description: "Armored glove",
            projectId: "proj-1",
            userId: "user-1",
        });

        await mediaService.addReferenceMedia({ elementId: element.id, imageUrl: "https://example.com/gauntlet.png", userId: "user-1" });

        // Step A: Update description only (coverMediaId is omitted/undefined)
        const resA = await elementService.updateElement(element.id, { description: "Updated glove" }, "user-1");
        assert.equal(resA.primary_media_url, "https://example.com/gauntlet.png", "Omitted coverMediaId MUST preserve the cover");

        // Step B: Explicitly pass coverMediaId: null
        const resB = await elementService.updateElement(element.id, { coverMediaId: null }, "user-1");
        assert.equal(resB.primary_media_url, null, "Explicit coverMediaId: null MUST clear the cover");

        // Step C: Update name with coverMediaId omitted again -> Cover remains cleared (null), not restored
        const resC = await elementService.updateElement(element.id, { name: "Gauntlet V2" }, "user-1");
        assert.equal(resC.primary_media_url, null, "Omitted coverMediaId preserves previous state (null)");
        assert.equal(resC.name, "Gauntlet V2");
    });

    it("8. Controller PATCH /api/v2/elements/:id maps req.body with coverMediaId and returns 200 with updated element", async () => {
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
                name: patch.name || "Original",
                coverMediaId: patch.coverMediaId,
                primary_media_url: patch.coverMediaId ? `https://example.com/${patch.coverMediaId}.png` : null,
            };
        };

        try {
            const req = {
                params: { id: "00000000-0000-0000-0000-000000000001" },
                body: { name: "Patched Element", coverMediaId: "media-99" },
                user: { id: "user-1" },
            };
            let resCode = null;
            let resBody = null;
            const res = {
                status(c) { resCode = c; return this; },
                json(d) { resBody = d; return this; },
            };

            await updateElement(req, res);
            assert.equal(resBody.status, "success");
            assert.equal(resBody.element.name, "Patched Element");
            assert.equal(resBody.element.primary_media_url, "https://example.com/media-99.png");
        } finally {
            elementService.updateElement = originalUpdate;
            if (db.elements && origResolve) db.elements.resolveRecord = origResolve;
            if (db.workflows && origGetWf) db.workflows.getWorkflow = origGetWf;
            if (db.projects && origProjects) db.projects.findByUser = origProjects;
        }
    });
});
