import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getElementPromptContext, validateElementsExist, elementRepository, ElementRepository, ElementService, ElementMediaService, ElementAnalysisService, extractElementTokens, stripElementTokens, PromptBuilderProService, getElementContextForPrompt, ElementsError, ElementsValidationError, ElementsNotFoundError, ElementsConflictError, ElementsUnauthorizedError } from "#elements/tools";
import elementsRouter from "#elements/api";

// ─── Source: elementsSystem.test.js ───
{
describe("System 7: Elements (#elements/tools & #elements/api)", () => {
    describe("1. Exported Error Hierarchy", () => {
        it("ElementsError inherits from AppError with 500 status", () => {
            const err = new ElementsError("ELEM_ERR", "Elements system failure");
            assert.equal(err.statusCode, 500);
            assert.equal(err.code, "ELEM_ERR");
        });

        it("ElementsValidationError sets 400 status and field context", () => {
            const err = new ElementsValidationError("Invalid elementId", { field: "elementId" });
            assert.equal(err.statusCode, 400);
            assert.equal(err.field, "elementId");
        });

        it("ElementsNotFoundError sets 404 status and elementId context", () => {
            const err = new ElementsNotFoundError("Element not found", { elementId: "elem-123" });
            assert.equal(err.statusCode, 404);
            assert.equal(err.elementId, "elem-123");
        });

        it("ElementsConflictError sets 409 status", () => {
            const err = new ElementsConflictError("Element quota exceeded");
            assert.equal(err.statusCode, 409);
        });

        it("ElementsUnauthorizedError sets 403 status", () => {
            const err = new ElementsUnauthorizedError("Access denied", { elementId: "elem-123", userId: "user-456" });
            assert.equal(err.statusCode, 403);
        });
    });

    describe("2. Tools Interface (#elements/tools)", () => {
        it("getElementPromptContext returns empty context when elementIds is empty", async () => {
            const res = await getElementPromptContext({ elementIds: [] });
            assert.deepEqual(res, {
                elements: [],
                referenceMediaUrls: [],
            });
        });

        it("getElementPromptContext throws ElementsNotFoundError when an element is missing", async () => {
            const origResolve = elementRepository.resolveRecord;
            elementRepository.resolveRecord = async () => null;

            try {
                await assert.rejects(
                    async () => getElementPromptContext({ elementIds: ["missing-elem-uuid"] }),
                    (err) => err instanceof ElementsNotFoundError && err.statusCode === 404
                );
            } finally {
                elementRepository.resolveRecord = origResolve;
            }
        });

        it("getElementPromptContext returns aggregated traits and reference URLs", async () => {
            const mockRecord1 = {
                id: "elem-1",
                workflow_id: "wf-1",
                name: "Cyber Katana",
                description: "A neon blade emitting high-frequency plasma.",
                guidelines: "Keep blade blue and hilt carbon fiber.",
            };

            const origResolve = elementRepository.resolveRecord;
            elementRepository.resolveRecord = async (id) => (id === "elem-1" ? mockRecord1 : null);

            const mockWorkflowMediaRepo = {
                findByWorkflow: async () => [
                    { id: "m-blade-1", url: "https://cdn.art/blade1.png", status: "success", role: "sheet", is_primary: true },
                    { id: "m-blade-2", url: "https://cdn.art/blade2.png", status: "success", role: "detail", is_primary: false },
                ],
            };

            try {
                const res = await getElementPromptContext({
                    elementIds: ["elem-1"],
                    workflowMediaRepository: mockWorkflowMediaRepo,
                });
                assert.equal(res.elements.length, 1);
                assert.equal(res.elements[0].name, "Cyber Katana");
                assert.equal(res.elements[0].guidelines, "Keep blade blue and hilt carbon fiber.");
                assert.deepEqual(res.referenceMediaUrls, [
                    "https://cdn.art/blade1.png",
                    "https://cdn.art/blade2.png",
                ]);
            } finally {
                elementRepository.resolveRecord = origResolve;
            }
        });

        it("getElementPromptContext resolves real visual URLs from workflow_media prioritizing primary cover and filtering non-success rows", async () => {
            const mockRecord = {
                id: "elem-wm-1",
                workflow_id: "wf-elem-wm-1",
                name: "Obsidian Crown",
                description: "Volcanic glass crown with gold filigree",
                guidelines: "Preserve jagged silhouette and warm gold veins",
                // Legacy dropped columns absent in production Postgres:
            };

            const mockWorkflowMediaRepo = {
                findByWorkflow: async (wfId) => {
                    assert.equal(wfId, "wf-elem-wm-1");
                    return [
                        { id: "m-failed", url: "https://cdn.art/crown-failed.png", status: "failed", role: "detail", is_primary: false },
                        { id: "m-saved", url: null, status: "saved", role: "detail", is_primary: false },
                        { id: "m-ref", url: "https://cdn.art/crown-ref.png", status: "success", role: "reference", is_primary: false },
                        { id: "m-detail", url: "https://cdn.art/crown-detail.png", status: "success", role: "detail", is_primary: false },
                        { id: "m-cover", url: "https://cdn.art/crown-cover.png", status: "success", role: "detail", is_primary: true },
                        { id: "m-cover-dup", url: "https://cdn.art/crown-cover.png", status: "success", role: "reference", is_primary: false },
                    ];
                },
            };

            const origResolve = elementRepository.resolveRecord;
            elementRepository.resolveRecord = async (id) => (id === "elem-wm-1" ? mockRecord : null);

            try {
                const res = await getElementPromptContext({
                    elementIds: ["elem-wm-1"],
                    workflowMediaRepository: mockWorkflowMediaRepo,
                });
                assert.equal(res.elements.length, 1);
                assert.equal(res.elements[0].id, "elem-wm-1");
                assert.equal(res.elements[0].workflowId, "wf-elem-wm-1");
                assert.deepEqual(res.elements[0].referenceMediaUrls, [
                    "https://cdn.art/crown-cover.png",
                    "https://cdn.art/crown-detail.png",
                    "https://cdn.art/crown-ref.png",
                ]);
                assert.deepEqual(res.referenceMediaUrls, [
                    "https://cdn.art/crown-cover.png",
                    "https://cdn.art/crown-detail.png",
                    "https://cdn.art/crown-ref.png",
                ]);
            } finally {
                elementRepository.resolveRecord = origResolve;
            }
        });

        it("validateElementsExist throws ElementsValidationError if elementIds is empty", async () => {
            await assert.rejects(
                async () => validateElementsExist({ elementIds: [] }),
                (err) => err instanceof ElementsValidationError && err.statusCode === 400
            );
        });

        it("validateElementsExist returns true when all elements exist", async () => {
            const origResolve = elementRepository.resolveRecord;
            elementRepository.resolveRecord = async (id) => ({ id });

            try {
                const valid = await validateElementsExist({ elementIds: ["elem-1", "elem-2"] });
                assert.equal(valid, true);
            } finally {
                elementRepository.resolveRecord = origResolve;
            }
        });

        it("exports element services, token extractors, and repository", () => {
            assert.ok(ElementService);
            assert.ok(ElementMediaService);
            assert.ok(ElementAnalysisService);
            assert.ok(ElementRepository);
            assert.ok(elementRepository);
            assert.equal(typeof extractElementTokens, "function");
            assert.equal(typeof stripElementTokens, "function");
            assert.ok(PromptBuilderProService);
            assert.equal(typeof getElementContextForPrompt, "function");
        });
    });

    describe("3. HTTP API Gateway (#elements/api)", () => {
        it("exports an Express router with all element endpoints", () => {
            assert.ok(elementsRouter);
            assert.ok(Array.isArray(elementsRouter.stack));

            const routes = elementsRouter.stack
                .filter((layer) => layer.route)
                .map((layer) => ({
                    path: layer.route.path,
                    methods: Object.keys(layer.route.methods),
                }));

            const paths = routes.map((r) => r.path);
            assert.ok(paths.includes("/"));
            assert.ok(paths.includes("/analyze"));
            assert.ok(paths.includes("/project/:projectId"));
            assert.ok(paths.includes("/build-prompt"));
            assert.ok(paths.includes("/:id/images"));
            assert.ok(paths.includes("/:id/images/:mediaId"));
            assert.ok(paths.includes("/:id"));
        });
    });
});
}

// ─── Source: elementPartialUpdateContract.test.js ───
{
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

    const allowAllOwnership = async () => true;

    it("1. Single-field update (name only): changes name and workflow display_name, preserves omitted description and Cover", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService, assertOwns: allowAllOwnership });

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
        const elementService = new ElementService({ db: mockDb, mediaService, assertOwns: allowAllOwnership });

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
        const elementService = new ElementService({ db: mockDb, mediaService, assertOwns: allowAllOwnership });

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
        const elementService = new ElementService({ db: mockDb, mediaService, assertOwns: allowAllOwnership });

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
        const elementService = new ElementService({ db: mockDb, mediaService, assertOwns: allowAllOwnership });

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
        const elementService = new ElementService({ db: mockDb, mediaService, assertOwns: allowAllOwnership });

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
        const elementService = new ElementService({ db: mockDb, mediaService, assertOwns: allowAllOwnership });

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
        const { updateElement } = await import("#elements/api");
        const { elementService, db } = await import("../../../src/container.js");

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
}

// ─── Source: elementPromptPayloadTokens.test.js ───
{
describe("Ticket 0.2 Unit Test: promptBuilderProService purity and ElementService token resolution", () => {
  it("exports token extraction and stripping helpers", async () => {
    const { extractElementTokens, stripElementTokens } = await import(
      "#elements/tools"
    );

    assert.equal(typeof extractElementTokens, "function");
    assert.equal(typeof stripElementTokens, "function");

    const prompt = 'A futuristic scene with @CyberSuit and @"Neon Helmet" in a rainy city';
    const tokens = extractElementTokens(prompt);
    assert.deepEqual(tokens, ["CyberSuit", "Neon Helmet"]);

    const stripped = stripElementTokens(prompt);
    assert.equal(stripped, "A futuristic scene with and in a rainy city");
  });

  it("buildMultiElementPayload builds prompt payload correctly with plain element DTOs", async () => {
    const { promptBuilderProService: promptBuilder } = await import(
      "#elements/tools"
    );

    const payload = await promptBuilder.buildMultiElementPayload({
      userPrompt: "A hero standing on a rooftop @HeroCape",
      elements: [
        {
          name: "HeroCape",
          description: "A dark red flowing cape",
          reference_images: ["https://cdn.example.com/cape.png"],
          _contextNote: "Element Context (HeroCape): A dark red flowing cape",
        },
      ],
    });

    assert.ok(payload);
    assert.ok(payload.compiled_prompt.includes("HeroCape"));
    assert.ok(payload.compiled_prompt.includes("A dark red flowing cape"));
    assert.deepEqual(payload.reference_sheets, ["https://cdn.example.com/cape.png"]);
    assert.deepEqual(payload.referenceImages, ["https://cdn.example.com/cape.png"]);
    assert.equal(payload.contextNote, "Element Context (HeroCape): A dark red flowing cape");
    assert.equal(payload.scenePrompt, "A hero standing on a rooftop");
  });

  it("ElementService.buildPromptPayload resolves @tokens using instance db and getElementContextForPrompt", async () => {
    const { ElementService } = await import("#elements/tools");

    const mockElement = {
      id: "elem-123",
      name: "SuperArmor",
      description: "Golden protective plate armor",
      workflow_id: "wf-123",
    };

    const mockMedia = [
      { id: "m-1", url: "https://cdn.example.com/armor-front.jpg" },
      { id: "m-2", url: "https://cdn.example.com/armor-back.jpg" },
    ];

    const fakeDb = {
      elements: {
        findById: async (id) => (id === mockElement.id ? mockElement : null),
        findByName: async (name) => (name.toLowerCase() === mockElement.name.toLowerCase() ? mockElement : null),
        resolveRecord: async () => mockElement,
      },
      workflows: {},
      media: {
        findByWorkflow: async (wfId) => (wfId === mockElement.workflow_id ? mockMedia : []),
      },
      workflowMedia: {},
    };

    const service = new ElementService({
      db: fakeDb,
      mediaService: {},
    });

    // Test getElementContextForPrompt directly
    const ctx = await service.getElementContextForPrompt({
      nameOrId: "SuperArmor",
      projectId: "proj-abc",
    });
    assert.ok(ctx);
    assert.equal(ctx.name, "SuperArmor");
    assert.equal(ctx.description, "Golden protective plate armor");
    assert.deepEqual(ctx.referenceImageUrls, [
      "https://cdn.example.com/armor-front.jpg",
      "https://cdn.example.com/armor-back.jpg",
    ]);

    // Test buildPromptPayload which resolves @SuperArmor token
    const result = await service.buildPromptPayload({
      userPrompt: "Warrior wearing @SuperArmor ready for battle",
      projectId: "proj-abc",
    });

    assert.ok(result);
    assert.ok(result.compiled_prompt.includes("SuperArmor"));
    assert.ok(result.compiled_prompt.includes("Golden protective plate armor"));
    assert.deepEqual(result.reference_sheets, [
      "https://cdn.example.com/armor-front.jpg",
      "https://cdn.example.com/armor-back.jpg",
    ]);
    assert.equal(result.scenePrompt, "Warrior wearing ready for battle");
  });
});
}

// ─── Phase 2a: Thin Controller, Single-Pass Ownership & Safe Error Formatting ───
{
describe("Phase 2a: Elements Thin Controller & Single-Pass Service Ownership", () => {
    function createMockRes() {
        const state = { statusCode: 200, body: null };
        const res = {
            status(code) {
                state.statusCode = code;
                return this;
            },
            json(payload) {
                state.body = payload;
                return this;
            },
        };
        return { res, state };
    }

    it("ElementService enforces ownership exactly once across create, list, get, update, and analyze", async () => {
        const ownershipCalls = [];
        const trackedAssertOwns = async (resourceType, id, userId) => {
            ownershipCalls.push({ resourceType, id, userId });
            if (userId === "attacker") {
                const err = new Error(`${resourceType} not found`);
                err.statusCode = 404;
                throw err;
            }
            return { id };
        };

        const mockDb = {
            workflows: {
                createWorkflow: async (p) => ({ id: "wf-own-1", ...p }),
                getPrimaryMediaUrl: async () => null,
                updateFields: async () => ({}),
            },
            elements: {
                create: async (p) => ({ id: "00000000-0000-0000-0000-000000000055", ...p }),
                list: async () => [{ id: "00000000-0000-0000-0000-000000000055", name: "Crown", workflow_id: "wf-own-1" }],
                resolveRecord: async (id) => ({ id, name: "Crown", workflow_id: "wf-own-1" }),
                update: async (id, patch) => ({ id, workflow_id: "wf-own-1", ...patch }),
            },
            media: { findByWorkflow: async () => [] },
            workflowMedia: { findByWorkflowIds: async () => [] },
        };

        let analysisCalls = 0;
        const service = new ElementService({
            db: mockDb,
            mediaService: {},
            analysisService: {
                analyzeElement: async () => {
                    analysisCalls++;
                    return { success: true, description: "Analyzed", keywords: [] };
                },
            },
            assertOwns: trackedAssertOwns,
        });

        await service.createElement({ name: "Crown", projectId: "proj-own", userId: "owner-1" });
        await service.listProjectElements("proj-own", { userId: "owner-1" });
        await service.getElementById("00000000-0000-0000-0000-000000000055", { userId: "owner-1" });
        await service.updateElement("00000000-0000-0000-0000-000000000055", { name: "Gold Crown" }, "owner-1");
        await service.analyzeElement({ projectId: "proj-own", workflowId: "wf-own-1", imageUrls: ["https://cdn.art/1.png"], userId: "owner-1" });

        assert.deepEqual(ownershipCalls, [
            { resourceType: "project", id: "proj-own", userId: "owner-1" },
            { resourceType: "project", id: "proj-own", userId: "owner-1" },
            { resourceType: "element", id: "00000000-0000-0000-0000-000000000055", userId: "owner-1" },
            { resourceType: "element", id: "00000000-0000-0000-0000-000000000055", userId: "owner-1" },
            { resourceType: "project", id: "proj-own", userId: "owner-1" },
            { resourceType: "workflow", id: "wf-own-1", userId: "owner-1" },
        ]);
        assert.equal(analysisCalls, 1);

        // Foreign user rejected fail-closed with 404 before analysis runs
        await assert.rejects(
            () => service.createElement({ name: "Stolen", projectId: "proj-own", userId: "attacker" }),
            (err) => err.statusCode === 404
        );
        await assert.rejects(
            () => service.listProjectElements("proj-own", { userId: "attacker" }),
            (err) => err.statusCode === 404
        );
        await assert.rejects(
            () => service.getElementById("00000000-0000-0000-0000-000000000055", { userId: "attacker" }),
            (err) => err.statusCode === 404
        );
        await assert.rejects(
            () => service.updateElement("00000000-0000-0000-0000-000000000055", { name: "Hacked" }, "attacker"),
            (err) => err.statusCode === 404
        );
        await assert.rejects(
            () => service.analyzeElement({ projectId: "proj-own", workflowId: "wf-own-1", userId: "attacker" }),
            (err) => err.statusCode === 404
        );
        assert.equal(analysisCalls, 1, "analysisService must not run when ownership check fails");

        // Unauthenticated createElement rejected with 401
        await assert.rejects(
            () => service.createElement({ name: "NoAuth", projectId: "proj-own", userId: null }),
            (err) => err.statusCode === 401
        );
    });

    it("Controllers ignore spoofed req.body.userId and mask 5xx errors via safePublicRouteError helper", async () => {
        const { createElement, addImageToElement, listProjectElements } = await import("#elements/api");
        const { elementService } = await import("../../../src/container.js");

        // 1. createElement ignores req.body.userId when req.user is missing -> 401 fail-closed
        {
            const { res, state } = createMockRes();
            await createElement(
                { user: null, body: { name: "Spoofed", projectId: "proj-1", userId: "victim-user" } },
                res
            );
            assert.equal(state.statusCode, 401);
            assert.equal(state.body.error, true);
            assert.equal(state.body.code, "UNAUTHORIZED");
        }

        // 2. addImageToElement ignores req.body.userId when req.user is missing -> 401 fail-closed
        {
            const { res, state } = createMockRes();
            await addImageToElement(
                {
                    user: null,
                    params: { id: "00000000-0000-0000-0000-000000000055" },
                    body: { imageUrl: "https://example.com/a.png", userId: "victim-user" },
                },
                res
            );
            assert.equal(state.statusCode, 401);
            assert.equal(state.body.error, true);
            assert.equal(state.body.code, "UNAUTHORIZED");
        }

        // 3. 5xx errors in listProjectElements are safely masked (no internal leak)
        const origList = elementService.listProjectElements;
        elementService.listProjectElements = async () => {
            throw new Error("raw postgres connection string secret://db");
        };
        try {
            const { res, state } = createMockRes();
            await listProjectElements({ user: { id: "user-1" }, params: { projectId: "proj-1" } }, res);
            assert.equal(state.statusCode, 500);
            assert.equal(state.body.error, true);
            assert.equal(state.body.code, "INTERNAL_ERROR");
            assert.equal(state.body.category, "SERVER_FAULT");
            assert.equal(state.body.message, "An unexpected error occurred. Please try again later.");
            assert.ok(state.body.traceId);
            assert.doesNotMatch(state.body.message, /secret:\/\/db/);
        } finally {
            elementService.listProjectElements = origList;
        }
    });

    it("addImageToElement & removeImageFromElement verify ownership ONCE (via ElementMediaService) and fail closed on unowned/unauthenticated", async () => {
        const { addImageToElement, removeImageFromElement } = await import("#elements/api");
        const { elementMediaService, db } = await import("../../../src/container.js");

        const origAdd = elementMediaService.addReferenceMedia;
        const origRemove = elementMediaService.removeReferenceMedia;
        const origResolve = db.elements.resolveRecord;
        let resolveCount = 0;
        db.elements.resolveRecord = async () => {
            resolveCount++;
            return null;
        };

        let capturedAddArgs = null;
        let capturedRemoveArgs = null;
        elementMediaService.addReferenceMedia = async (args) => {
            capturedAddArgs = args;
            return { ok: true, media: { id: "m-1", url: "https://cdn.art/1.png" } };
        };
        elementMediaService.removeReferenceMedia = async (args) => {
            capturedRemoveArgs = args;
            return { ok: true, deletedMediaId: args.mediaId };
        };

        try {
            const addRes = createMockRes();
            await addImageToElement(
                {
                    user: { id: "auth-user-1" },
                    params: { id: "00000000-0000-0000-0000-000000000055" },
                    body: { imageUrl: "https://cdn.art/1.png", userId: "spoofed-body-user" },
                },
                addRes.res
            );
            assert.equal(addRes.state.statusCode, 201);
            assert.equal(capturedAddArgs.userId, "auth-user-1", "Must pass req.user.id, never req.body.userId");

            const remRes = createMockRes();
            await removeImageFromElement(
                {
                    user: { id: "auth-user-1" },
                    params: { id: "00000000-0000-0000-0000-000000000055", mediaId: "m-1" },
                },
                remRes.res
            );
            assert.equal(remRes.state.statusCode, 200);
            assert.equal(capturedRemoveArgs.userId, "auth-user-1");
            assert.equal("req" in capturedRemoveArgs, false, "Must not pass Express req into service");
            assert.equal(resolveCount, 0, "Controller must not run duplicate assertOwns before ElementMediaService");
        } finally {
            elementMediaService.addReferenceMedia = origAdd;
            elementMediaService.removeReferenceMedia = origRemove;
            db.elements.resolveRecord = origResolve;
        }
    });
});
}
