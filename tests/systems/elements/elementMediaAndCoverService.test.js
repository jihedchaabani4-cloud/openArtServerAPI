import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ElementMediaService, ElementService } from "#elements/tools";
import { ELEMENT_REFERENCE_UPLOAD_POLICY, ELEMENT_SHEET_UPLOAD_POLICY, WorkflowMediaRepository } from "#media/tools";
import { ELEMENT_SOURCES_UPLOAD_POLICY } from "../../../src/systems/media/internal/ingestion/UploadPolicy.js";
import { CrudServiceError } from "#shared";
import { createPreUploadElementCapacityGuard } from "../../../src/systems/elements/internal/middleware/elementUploadGuard.js";

// ─── Source: elementMediaServiceMigrated.test.js ───
{
process.env.NODE_ENV = "test";


describe("ElementMediaService — Migrated to MediaUploadService & WorkflowMediaService (Ticket 05)", () => {
    let mockDb;
    let elementsStore;
    let workflowsStore;
    let mockUploadService;
    let mockWorkflowMediaService;
    let mockAuthService;
    let uploadCalls;
    let attachCalls;
    let discardCalls;
    let service;

    const ELEMENT_ID = "00000000-0000-0000-0000-000000000001";
    const WORKFLOW_ID = "00000000-0000-0000-0000-000000000010";
    const PROJECT_ID = "00000000-0000-0000-0000-000000000100";
    const USER_ID = "00000000-0000-0000-0000-000000000002";

    beforeEach(() => {
        elementsStore = [
            {
                id: ELEMENT_ID,
                workflow_id: WORKFLOW_ID,
                project_id: PROJECT_ID,
                name: "Test Element",
            },
        ];
        workflowsStore = [
            {
                id: WORKFLOW_ID,
                project_id: PROJECT_ID,
                user_id: USER_ID,
                primary_media_id: null,
            },
        ];

        uploadCalls = [];
        attachCalls = [];
        discardCalls = [];

        mockDb = {
            elements: {
                resolveRecord: async (id) => elementsStore.find((e) => e.id === id || e.workflow_id === id) || null,
                findById: async (id) => elementsStore.find((e) => e.id === id) || null,
            },
            workflows: {
                findById: async (id) => workflowsStore.find((w) => w.id === id) || null,
                getWorkflow: async (id) => workflowsStore.find((w) => w.id === id) || null,
                updatePrimaryMedia: async (wfId, mediaId) => {
                    const wf = workflowsStore.find((w) => w.id === wfId);
                    if (wf) wf.primary_media_id = mediaId;
                    return wf;
                },
            },
            workflowMedia: {
                findByWorkflow: async (wfId) => [],
            },
        };

        mockUploadService = {
            upload: async ({ files, policy, maxFiles, userId, folder }) => {
                uploadCalls.push({ files, policy, maxFiles, userId, folder });
                const uploaded = files.map((f, idx) => ({
                    storageKey: `${userId}/${policy.storageFolder}/file-${idx + 1}.webp`,
                    url: `https://storage.test/${policy.storageFolder}/file-${idx + 1}.webp`,
                    width: 512,
                    height: 512,
                    format: "WEBP",
                }));
                return { uploaded, files: uploaded };
            },
            discard: async (keys) => {
                discardCalls.push(keys);
            },
        };

        mockWorkflowMediaService = {
            attachMediaItems: async ({ workflowId, projectId, userId, role, maxAllowed, items, setPrimary, autoPrimary }) => {
                attachCalls.push({ workflowId, projectId, userId, role, maxAllowed, items, setPrimary, autoPrimary });
                return {
                    attached: items.map((it, idx) => {
                        const mId = it.kind === "existing" ? (it.mediaId || it.media_id) : `m-new-${idx + 1}`;
                        const url = it.kind === "existing" ? `https://storage.test/existing/${mId}.png` : it.uploadedFile.url;
                        return {
                            kind: it.kind,
                            media: { id: mId, url, step_id: "upload" },
                            link: { workflow_id: workflowId, media_id: mId, role, is_primary: idx === 0 },
                            is_existing: it.kind === "existing",
                            is_primary: idx === 0,
                            storageKey: it.kind === "uploaded" ? it.uploadedFile.storageKey : null,
                        };
                    }),
                    rollbackHandle: { workflowId, role, entries: [] },
                };
            },
        };

        mockAuthService = {
            verifyWorkflowOwnership: async (wfId, uId) => {
                const wf = workflowsStore.find((w) => w.id === wfId);
                return Boolean(wf && wf.user_id === uId);
            },
        };

        service = new ElementMediaService({
            db: mockDb,
            storageService: {},
            mediaUploadService: mockUploadService,
            workflowMediaService: mockWorkflowMediaService,
            authService: mockAuthService,
        });
    });

    describe("0. Constructor & Dependency Validation", () => {
        it("throws if mediaUploadService is missing", () => {
            assert.throws(
                () => new ElementMediaService({
                    db: mockDb,
                    storageService: {},
                    workflowMediaService: mockWorkflowMediaService,
                    authService: mockAuthService,
                }),
                /ElementMediaService requires mediaUploadService with an upload method/
            );
        });

        it("throws if workflowMediaService is missing", () => {
            assert.throws(
                () => new ElementMediaService({
                    db: mockDb,
                    storageService: {},
                    mediaUploadService: mockUploadService,
                    authService: mockAuthService,
                }),
                /ElementMediaService requires workflowMediaService with an attachMediaItems method/
            );
        });

        it("throws if authService is missing", () => {
            assert.throws(
                () => new ElementMediaService({
                    db: mockDb,
                    storageService: {},
                    mediaUploadService: mockUploadService,
                    workflowMediaService: mockWorkflowMediaService,
                }),
                /ElementMediaService requires authService with a verifyWorkflowOwnership method/
            );
        });
    });

    describe("1. addReferenceMedia", () => {
        it("unauthenticated / 'anonymous' -> 401", async () => {
            for (const badUser of [null, undefined, "", "anonymous"]) {
                await assert.rejects(
                    () => service.addReferenceMedia({
                        elementId: ELEMENT_ID,
                        file: { buffer: Buffer.from("img") },
                        userId: badUser,
                        projectId: PROJECT_ID,
                    }),
                    (err) => err instanceof CrudServiceError && err.statusCode === 401
                );
            }
        });

        it("cross-tenant mediaId and workflowId -> 404", async () => {
            // Case A: foreign workflowId / elementId
            await assert.rejects(
                () => service.addReferenceMedia({
                    elementId: ELEMENT_ID,
                    file: { buffer: Buffer.from("img") },
                    userId: "foreign-user-999",
                    projectId: PROJECT_ID,
                }),
                (err) => err instanceof CrudServiceError && err.statusCode === 404
            );

            // Case B: foreign mediaId
            mockWorkflowMediaService.attachMediaItems = async () => {
                throw new CrudServiceError("Media not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                });
            };

            await assert.rejects(
                () => service.addReferenceMedia({
                    elementId: ELEMENT_ID,
                    mediaId: "00000000-0000-0000-0000-000000000999",
                    userId: USER_ID,
                    projectId: PROJECT_ID,
                }),
                (err) => err instanceof CrudServiceError && err.statusCode === 404
            );
        });

        it("new file upload: calls mediaUploadService.upload with ELEMENT_REFERENCE_UPLOAD_POLICY and attaches via workflowMediaService.attachMediaItems with maxAllowed=6", async () => {
            const res = await service.addReferenceMedia({
                elementId: ELEMENT_ID,
                file: { buffer: Buffer.from("ref-img"), mimetype: "image/png" },
                userId: USER_ID,
                projectId: PROJECT_ID,
            });

            assert.equal(res.ok, true);
            assert.equal(uploadCalls.length, 1);
            assert.equal(uploadCalls[0].policy, ELEMENT_REFERENCE_UPLOAD_POLICY);
            assert.equal(uploadCalls[0].policy.storageFolder, "element-references");

            assert.equal(attachCalls.length, 1);
            assert.equal(attachCalls[0].workflowId, WORKFLOW_ID);
            assert.equal(attachCalls[0].projectId, PROJECT_ID);
            assert.equal(attachCalls[0].userId, USER_ID);
            assert.equal(attachCalls[0].role, "detail");
            assert.equal(attachCalls[0].maxAllowed, 6);
            assert.equal(attachCalls[0].items[0].kind, "uploaded");
        });

        it("existing mediaId: attaches via workflowMediaService.attachMediaItems with kind: 'existing' and maxAllowed=6 (no storage upload)", async () => {
            const res = await service.addReferenceMedia({
                elementId: ELEMENT_ID,
                mediaId: "00000000-0000-0000-0000-000000000099",
                userId: USER_ID,
                projectId: PROJECT_ID,
            });

            assert.equal(res.ok, true);
            assert.equal(uploadCalls.length, 0, "No upload call for existing mediaId");
            assert.equal(attachCalls.length, 1);
            assert.equal(attachCalls[0].role, "detail");
            assert.equal(attachCalls[0].maxAllowed, 6);
            assert.equal(attachCalls[0].items[0].kind, "existing");
            assert.equal(attachCalls[0].items[0].mediaId, "00000000-0000-0000-0000-000000000099");
        });

        it("client sends folder=character-sheets -> still stored under element-references", async () => {
            await service.addReferenceMedia({
                elementId: ELEMENT_ID,
                file: { buffer: Buffer.from("hack") },
                userId: USER_ID,
                projectId: PROJECT_ID,
                folder: "character-sheets",
            });

            assert.equal(uploadCalls.length, 1);
            assert.equal(uploadCalls[0].policy.storageFolder, "element-references");
            assert.equal(uploadCalls[0].folder, undefined, "Client folder parameter must not be passed to upload");
        });
    });

    describe("2. setSheetMedia", () => {
        it("rejects missing or anonymous userId with 401", async () => {
            await assert.rejects(
                () => service.setSheetMedia({
                    elementId: ELEMENT_ID,
                    file: { buffer: Buffer.from("sheet") },
                    userId: "anonymous",
                    projectId: PROJECT_ID,
                }),
                (err) => err instanceof CrudServiceError && err.statusCode === 401
            );
        });

        it("calls mediaUploadService.upload with ELEMENT_SHEET_UPLOAD_POLICY and attaches with autoPrimary: false and no setPrimary", async () => {
            const res = await service.setSheetMedia({
                elementId: ELEMENT_ID,
                file: { buffer: Buffer.from("sheet-img"), mimetype: "image/png" },
                userId: USER_ID,
                projectId: PROJECT_ID,
            });

            assert.equal(res.ok, true);
            assert.equal(uploadCalls.length, 1);
            assert.equal(uploadCalls[0].policy, ELEMENT_SHEET_UPLOAD_POLICY);
            assert.equal(uploadCalls[0].policy.storageFolder, "element-sheets");

            assert.equal(attachCalls.length, 1);
            assert.equal(attachCalls[0].role, "sheet", "New sheet rows must use role 'sheet' per keep-old quota decision");
            assert.equal(attachCalls[0].autoPrimary, false);
            assert.equal(attachCalls[0].setPrimary, undefined);
        });

        it("Scenario A (keep-old): element with 1 sheet + 5 references allows adding a 6th reference", async () => {
            // Attach 1 sheet (role: "sheet")
            await service.setSheetMedia({
                elementId: ELEMENT_ID,
                file: { buffer: Buffer.from("sheet-img"), mimetype: "image/png" },
                userId: USER_ID,
                projectId: PROJECT_ID,
            });

            // Mock DB finding 1 sheet + 5 detail references
            mockDb.workflowMedia.findByWorkflow = async () => [
                { id: "s-1", media_id: "m-sheet", role: "sheet", is_primary: false },
                { id: "r-1", media_id: "m-ref-1", role: "detail", is_primary: false },
                { id: "r-2", media_id: "m-ref-2", role: "detail", is_primary: false },
                { id: "r-3", media_id: "m-ref-3", role: "detail", is_primary: false },
                { id: "r-4", media_id: "m-ref-4", role: "detail", is_primary: false },
                { id: "r-5", media_id: "m-ref-5", role: "detail", is_primary: false },
            ];

            // 6th reference upload must pass assertUploadAllowed
            const capacity = await service.assertUploadAllowed({
                elementId: ELEMENT_ID,
                userId: USER_ID,
            });
            assert.equal(capacity.allowed, true);
            assert.equal(capacity.currentCount, 5, "Sheet (role: sheet) must not be counted as a detail slot");
            assert.equal(capacity.remainingSlots, 1);

            // Adding 6th reference must succeed
            const addRes = await service.addReferenceMedia({
                elementId: ELEMENT_ID,
                file: { buffer: Buffer.from("ref-6"), mimetype: "image/png" },
                userId: USER_ID,
            });
            assert.equal(addRes.ok, true);
        });

        it("Scenario D2 (keep-old): replace sheet twice, sheets do not consume detail quota", async () => {
            // Replace sheet twice
            await service.setSheetMedia({
                elementId: ELEMENT_ID,
                file: { buffer: Buffer.from("sheet-1"), mimetype: "image/png" },
                userId: USER_ID,
                projectId: PROJECT_ID,
            });
            await service.setSheetMedia({
                elementId: ELEMENT_ID,
                file: { buffer: Buffer.from("sheet-2"), mimetype: "image/png" },
                userId: USER_ID,
                projectId: PROJECT_ID,
            });

            // 2 sheets exist in workflow_media, both role "sheet", plus 5 detail references
            mockDb.workflowMedia.findByWorkflow = async () => [
                { id: "s-1", media_id: "m-sheet-1", role: "sheet", is_primary: false },
                { id: "s-2", media_id: "m-sheet-2", role: "sheet", is_primary: false },
                { id: "r-1", media_id: "m-ref-1", role: "detail", is_primary: false },
                { id: "r-2", media_id: "m-ref-2", role: "detail", is_primary: false },
                { id: "r-3", media_id: "m-ref-3", role: "detail", is_primary: false },
                { id: "r-4", media_id: "m-ref-4", role: "detail", is_primary: false },
                { id: "r-5", media_id: "m-ref-5", role: "detail", is_primary: false },
            ];

            const capacity = await service.assertUploadAllowed({
                elementId: ELEMENT_ID,
                userId: USER_ID,
            });
            assert.equal(capacity.allowed, true);
            assert.equal(capacity.currentCount, 5, "Neither replaced sheet takes a detail slot");
            assert.equal(capacity.remainingSlots, 1);
        });

        it("an element with no primary must NOT auto-promote the sheet (is_primary remains false)", async () => {
            workflowsStore[0].primary_media_id = null;
            let capturedAttachParams = null;
            mockWorkflowMediaService.attachMediaItems = async (params) => {
                capturedAttachParams = params;
                return {
                    attached: [{
                        media: { id: "00000000-0000-0000-0000-000000000077", url: "https://storage.test/sheet.webp" },
                        link: { is_primary: false },
                    }],
                };
            };

            await service.setSheetMedia({
                elementId: ELEMENT_ID,
                file: { buffer: Buffer.from("sheet-img"), mimetype: "image/png" },
                userId: USER_ID,
                projectId: PROJECT_ID,
            });

            assert.equal(capturedAttachParams.autoPrimary, false, "autoPrimary must be false");
            assert.equal(capturedAttachParams.setPrimary, undefined, "setPrimary must not be set");
            assert.equal(workflowsStore[0].primary_media_id, "00000000-0000-0000-0000-000000000077", "workflows.primary_media_id updated explicitly");
        });

        it("sheet failure mid-way leaves primary NOT pointing to a deleted media (restored to previous)", async () => {
            const OLD_SHEET_MEDIA_ID = "00000000-0000-0000-0000-000000000088";
            workflowsStore[0].primary_media_id = OLD_SHEET_MEDIA_ID;
            mockDb.workflowMedia.getPrimaryMedia = async () => ({ media_id: OLD_SHEET_MEDIA_ID });

            let rollbackCalledWithHandle = null;
            mockWorkflowMediaService.rollbackAttachedMedia = async (handle) => {
                rollbackCalledWithHandle = handle;
                return { complete: true, deletedMediaIds: [handle.entries[0]?.mediaId] };
            };

            // Simulate post-attach failure
            mockDb.elements.updateElementFields = async () => {
                throw new Error("Post-attach element update failure");
            };

            await assert.rejects(
                () => service.setSheetMedia({
                    elementId: ELEMENT_ID,
                    file: { buffer: Buffer.from("new-sheet-payload"), mimetype: "image/png" },
                    userId: USER_ID,
                    projectId: PROJECT_ID,
                }),
                (err) => err.message === "Post-attach element update failure"
            );

            assert.equal(workflowsStore[0].primary_media_id, OLD_SHEET_MEDIA_ID, "Rollback must restore established primary_media_id");
            assert.ok(rollbackCalledWithHandle, "WorkflowMediaService.rollbackAttachedMedia must be called on post-attach error");
        });
    });

    describe("4. Quota Enforcement & Rollback Integration", () => {
        it("7th existing mediaId -> LIMIT_EXCEEDED", async () => {
            mockWorkflowMediaService.attachMediaItems = async () => {
                const err = new CrudServiceError("Maximum 6 reference images allowed per element", {
                    statusCode: 400,
                    errorCode: "LIMIT_EXCEEDED",
                });
                throw err;
            };

            await assert.rejects(
                () => service.addReferenceMedia({
                    elementId: ELEMENT_ID,
                    mediaId: "00000000-0000-0000-0000-000000000007",
                    userId: USER_ID,
                    projectId: PROJECT_ID,
                }),
                (err) => err.statusCode === 400 && (err.errorCode === "LIMIT_EXCEEDED" || err.code === "LIMIT_EXCEEDED")
            );
        });

        it("7th NEW file -> LIMIT_EXCEEDED and storage discarded", async () => {
            mockWorkflowMediaService.attachMediaItems = async () => {
                discardCalls.push(["00000000-0000-0000-0000-000000000002/element-references/file-1.webp"]);
                const err = new CrudServiceError("Maximum 6 reference images allowed per element", {
                    statusCode: 400,
                    errorCode: "LIMIT_EXCEEDED",
                });
                throw err;
            };

            await assert.rejects(
                () => service.addReferenceMedia({
                    elementId: ELEMENT_ID,
                    file: { buffer: Buffer.from("7th-file") },
                    userId: USER_ID,
                    projectId: PROJECT_ID,
                }),
                (err) => err.statusCode === 400 && (err.errorCode === "LIMIT_EXCEEDED" || err.code === "LIMIT_EXCEEDED")
            );

            assert.equal(discardCalls.length, 1);
        });

        it("pre-existing mediaId never deleted on failure", async () => {
            mockWorkflowMediaService.attachMediaItems = async () => {
                const err = new CrudServiceError("Media not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                });
                throw err;
            };

            await assert.rejects(
                () => service.addReferenceMedia({
                    elementId: ELEMENT_ID,
                    mediaId: "00000000-0000-0000-0000-000000000999",
                    userId: USER_ID,
                    projectId: PROJECT_ID,
                }),
                (err) => err.statusCode === 404
            );

            assert.equal(discardCalls.length, 0, "Pre-existing mediaId must never have storage discarded");
        });
    });

    describe("5. Ownership & Capacity Guard Hardening (STD-02, STD-03)", () => {
        it("assertUploadAllowed: unauthenticated / anonymous -> 401", async () => {
            await assert.rejects(
                () => service.assertUploadAllowed({ elementId: ELEMENT_ID, userId: null }),
                (err) => err.statusCode === 401 && err.errorCode === "UNAUTHORIZED"
            );
            await assert.rejects(
                () => service.assertUploadAllowed({ elementId: ELEMENT_ID, userId: "anonymous" }),
                (err) => err.statusCode === 401 && err.errorCode === "UNAUTHORIZED"
            );
        });

        it("assertUploadAllowed: cross-tenant access -> 404", async () => {
            await assert.rejects(
                () => service.assertUploadAllowed({ elementId: ELEMENT_ID, userId: "foreign-user" }),
                (err) => err.statusCode === 404 && err.errorCode === "NOT_FOUND"
            );
        });

        it("assertUploadAllowed counts strictly role === 'detail' matching RPC, ignoring non-detail roles (red-first)", async () => {
            // 5 detail links + 1 link with no role (e.g. role: null)
            mockDb.workflowMedia.findByWorkflow = async () => [
                { media_id: "m-1", role: "detail" },
                { media_id: "m-2", role: "detail" },
                { media_id: "m-3", role: "detail" },
                { media_id: "m-4", role: "detail" },
                { media_id: "m-5", role: "detail" },
                { media_id: "m-sheet", role: null },
            ];

            // Because role: null is not 'detail', current detail count is 5 (< 6), so assertUploadAllowed must pass
            const cap = await service.assertUploadAllowed({ elementId: ELEMENT_ID, userId: USER_ID });
            assert.equal(cap.allowed, true);
            assert.equal(cap.currentCount, 5, "Only role === 'detail' links must be counted");
            assert.equal(cap.remainingSlots, 1);
        });

        it("removeReferenceMedia: unauthenticated / anonymous -> 401", async () => {
            await assert.rejects(
                () => service.removeReferenceMedia({ elementId: ELEMENT_ID, mediaId: "m-1", userId: null }),
                (err) => err.statusCode === 401 && err.errorCode === "UNAUTHORIZED"
            );
            await assert.rejects(
                () => service.removeReferenceMedia({ elementId: ELEMENT_ID, mediaId: "m-1", userId: "anonymous" }),
                (err) => err.statusCode === 401 && err.errorCode === "UNAUTHORIZED"
            );
        });

        it("removeReferenceMedia: cross-tenant access -> 404", async () => {
            await assert.rejects(
                () => service.removeReferenceMedia({ elementId: ELEMENT_ID, mediaId: "m-1", userId: "foreign-user" }),
                (err) => err.statusCode === 404 && err.errorCode === "NOT_FOUND"
            );
        });
    });
});
}

// ─── Source: elementCoverConcurrencyAndLifecycleBoundary.test.js ───
{
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
}

// ─── Source: elementMaxMediaLimitBoundary.test.js ───
{
describe("Element Maximum 6 Reference Media Boundary & Enforcement", () => {
    let repo;
    let mediaStore;
    let elementsStore;
    let mockDb;
    let mediaService;
    let elementService;

    const ELEMENT_ID = "00000000-0000-0000-0000-000000000001";
    const WORKFLOW_ID = "wf-limit-test-1";
    const PROJECT_ID = "proj-limit-1";

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
                name: "Limited Relic",
                description: "An element that can hold at most 6 reference images",
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
                findById: async (id) => ({ id, name: id }),
                getPrimaryMediaUrl: async (workflowId) => {
                    const primary = await repo.getPrimaryMedia(workflowId);
                    if (!primary) return null;
                    const m = mediaStore.find((item) => item.id === primary.media_id);
                    return m?.url || null;
                },
            },
            media: {
                createMedia: async (payload) => {
                    const row = { id: `m-${mediaStore.length + 1}`, status: "completed", ...payload };
                    mediaStore.push(row);
                    return row;
                },
                findById: async (id) => mediaStore.find((item) => item.id === id) || null,
                findByWorkflow: async (workflowId) => {
                    const links = await repo.findByWorkflow(workflowId);
                    return links.map((link) => {
                        const m = mediaStore.find((item) => item.id === link.media_id);
                        return {
                            ...(m || {}),
                            id: link.media_id,
                            role: link.role,
                            is_primary: link.is_primary,
                        };
                    });
                },
            },
            workflowMedia: repo,
        };

        const mockUploadService = {
            upload: async ({ files, policy, userId }) => {
                const uploaded = files.map((f, idx) => {
                    const row = {
                        id: `m-${mediaStore.length + 1}`,
                        status: "completed",
                        url: typeof f === "string" ? f : `https://example.com/upload-${idx + 1}.png`,
                        storageKey: `${userId}/${policy?.storageFolder || "element-references"}/upload-${idx + 1}.png`,
                        step_id: "upload",
                    };
                    mediaStore.push(row);
                    return row;
                });
                return { uploaded, files: uploaded };
            },
            discard: async () => {},
        };

        let attachMutex = Promise.resolve();
        const mockWorkflowMediaService = {
            attachMediaItems: async ({ workflowId, projectId, userId, role = "detail", maxAllowed = 6, items = [] }) => {
                const release = attachMutex;
                let nextResolve;
                attachMutex = new Promise((resolve) => { nextResolve = resolve; });
                await release;
                try {
                    const currentCount = (await repo.findByWorkflow(workflowId)).filter((l) => !l.role || l.role === "detail").length;
                    if (maxAllowed !== null && currentCount + items.length > maxAllowed) {
                        throw new CrudServiceError(`Maximum ${maxAllowed} reference images allowed per element`, {
                            statusCode: 400,
                            errorCode: "LIMIT_EXCEEDED",
                        });
                    }
                    const attached = [];
                    for (const item of items) {
                        const mId = item.kind === "existing" ? item.mediaId : item.uploadedFile.id;
                        const mediaRow = mediaStore.find((m) => m.id === mId) || { id: mId, url: item.uploadedFile?.url };
                        const link = await repo.linkMedia({
                            workflowId,
                            mediaId: mId,
                            role,
                            stepId: "upload",
                            is_primary: false,
                        });
                        attached.push({
                            kind: item.kind,
                            media: mediaRow,
                            link,
                        });
                    }
                    return { attached };
                } finally {
                    nextResolve();
                }
            },
        };

        const mockAuthService = {
            verifyWorkflowOwnership: async (wfId, uId) => {
                const elem = elementsStore.find((e) => e.workflow_id === wfId || e.id === wfId);
                if (elem?.user_id && elem.user_id !== uId) return false;
                return true;
            },
        };

        mediaService = new ElementMediaService({
            db: mockDb,
            storageService: {},
            mediaUploadService: mockUploadService,
            workflowMediaService: mockWorkflowMediaService,
            authService: mockAuthService,
        });
        elementService = new ElementService({ db: mockDb, mediaService });
    });

    it("1. Allows adding up to 6 reference images, but rejects the 7th image with 400 LIMIT_EXCEEDED", async () => {
        // Add 6 reference images
        for (let i = 1; i <= 6; i++) {
            const res = await mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                imageUrl: `https://example.com/ref-${i}.png`,
                userId: "user-limit",
            });
            assert.equal(res.ok, true, `Image ${i} should be successfully added`);
        }

        const linkedBefore = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(linkedBefore.length, 6, "Element should have exactly 6 reference images");

        // Attempting to add the 7th image MUST fail with 400 LIMIT_EXCEEDED
        await assert.rejects(
            async () => {
                await mediaService.addReferenceMedia({
                    elementId: ELEMENT_ID,
                    imageUrl: "https://example.com/ref-7.png",
                    userId: "user-limit",
                });
            },
            (err) => {
                assert.equal(err.statusCode, 400, "Should return HTTP 400");
                assert.equal(err.errorCode, "LIMIT_EXCEEDED", "Error code should be LIMIT_EXCEEDED");
                assert.match(err.message, /Maximum 6 reference images allowed/i);
                return true;
            }
        );

        // Verify count remains strictly 6 in repository
        const linkedAfter = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(linkedAfter.length, 6, "Count must remain 6; 7th image must not be inserted");
    });

    it("1b. Quota default regression: the 7th existing mediaId attached to an Element is rejected (LIMIT_EXCEEDED / QuotaError)", async () => {
        const SOURCE_WF_ID = "wf-source-existing";
        elementsStore.push({
            id: SOURCE_WF_ID,
            workflow_id: SOURCE_WF_ID,
            project_id: PROJECT_ID,
            user_id: "user-limit",
        });

        // Pre-populate 6 existing media items linked to SOURCE_WF_ID, then attach them to ELEMENT_ID
        for (let i = 1; i <= 6; i++) {
            const m = {
                id: `m-existing-${i}`,
                status: "completed",
                url: `https://example.com/existing-${i}.png`,
                user_id: "user-limit",
                project_id: PROJECT_ID,
            };
            mediaStore.push(m);
            // Link media to source workflow first
            await repo.attachReferenceMedia({
                workflowId: SOURCE_WF_ID,
                mediaId: m.id,
                role: "output",
                maxAllowed: null,
            });

            // Attach existing media to Element
            const res = await mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                mediaId: m.id,
                userId: "user-limit",
                projectId: PROJECT_ID,
            });
            assert.equal(res.ok, true, `Existing media ${i} should attach successfully`);
        }

        const linkedBefore = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(linkedBefore.length, 6, "Element should have exactly 6 reference media links");

        // Prepare the 7th existing media item
        const m7 = {
            id: "m-existing-7",
            status: "completed",
            url: "https://example.com/existing-7.png",
            user_id: "user-limit",
            project_id: PROJECT_ID,
        };
        mediaStore.push(m7);
        await repo.attachReferenceMedia({
            workflowId: SOURCE_WF_ID,
            mediaId: m7.id,
            role: "output",
            maxAllowed: null,
        });

        // Attempting to attach the 7th existing mediaId MUST fail through the real ElementMediaService path
        await assert.rejects(
            async () => {
                await mediaService.addReferenceMedia({
                    elementId: ELEMENT_ID,
                    mediaId: m7.id,
                    userId: "user-limit",
                    projectId: PROJECT_ID,
                });
            },
            (err) => {
                assert.equal(err.statusCode, 400, "Should return HTTP 400");
                assert.equal(err.errorCode, "LIMIT_EXCEEDED", "Error code should be LIMIT_EXCEEDED");
                assert.match(err.message, /Maximum 6 reference images allowed/i);
                return true;
            }
        );

        // Verify count remains strictly 6 in repository; 7th existing media was NOT linked
        const linkedAfter = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(linkedAfter.length, 6, "Count must remain strictly 6; 7th existing mediaId must not be linked");
    });

    it("2. Removing an image when at 6 allows adding a new 6th image again", async () => {
        const addedIds = [];
        for (let i = 1; i <= 6; i++) {
            const res = await mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                imageUrl: `https://example.com/ref-${i}.png`,
                userId: "user-limit",
            });
            addedIds.push(res.media.id);
        }

        // Delete one reference image (e.g. the 2nd one)
        await mediaService.removeReferenceMedia({
            elementId: ELEMENT_ID,
            mediaId: addedIds[1],
            userId: "user-limit",
        });

        const afterDelete = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(afterDelete.length, 5, "Count should be 5 after removing one");

        // Now adding another image should succeed
        const res = await mediaService.addReferenceMedia({
            elementId: ELEMENT_ID,
            imageUrl: "https://example.com/ref-replacement.png",
            userId: "user-limit",
        });
        assert.equal(res.ok, true);

        const afterReAdd = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(afterReAdd.length, 6, "Count should be back to 6");
    });

    it("4. assertUploadAllowed passes when slots remain, providing accurate capacity metrics", async () => {
        // Initially 0 images attached
        const capacity = await mediaService.assertUploadAllowed({
            elementId: ELEMENT_ID,
            userId: "user-limit",
        });

        assert.equal(capacity.allowed, true);
        assert.equal(capacity.currentCount, 0);
        assert.equal(capacity.maxAllowed, 6);
        assert.equal(capacity.remainingSlots, 6);
        assert.equal(capacity.workflowId, WORKFLOW_ID);
    });

    it("5. assertUploadAllowed rejects with 400 LIMIT_EXCEEDED before upload when element is full", async () => {
        for (let i = 1; i <= 6; i++) {
            await mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                imageUrl: `https://example.com/img-${i}.png`,
                userId: "user-limit",
            });
        }

        await assert.rejects(
            async () => {
                await mediaService.assertUploadAllowed({
                    elementId: ELEMENT_ID,
                    userId: "user-limit",
                });
            },
            (err) => {
                assert.equal(err.statusCode, 400);
                assert.equal(err.errorCode, "LIMIT_EXCEEDED");
                assert.match(err.message, /Maximum 6 reference images allowed/i);
                assert.equal(err.details?.currentCount, 6);
                assert.equal(err.details?.remainingSlots, 0);
                return true;
            }
        );
    });

    it("6. assertUploadAllowed returns 404 for cross-tenant access to prevent enumeration", async () => {
        // Element belongs to user-limit; another user tries to upload
        elementsStore[0].user_id = "user-limit";

        await assert.rejects(
            async () => {
                await mediaService.assertUploadAllowed({
                    elementId: ELEMENT_ID,
                    userId: "attacker-user-id",
                });
            },
            (err) => {
                assert.equal(err.statusCode, 404, "Cross-tenant access must return 404");
                assert.equal(err.errorCode, "NOT_FOUND");
                return true;
            }
        );
    });

    it("7. Respects dynamic ELEMENT_MAX_MEDIA from process.env", async () => {
        const origEnv = process.env.ELEMENT_MAX_MEDIA;
        process.env.ELEMENT_MAX_MEDIA = "3";

        try {
            // Add 3 images
            for (let i = 1; i <= 3; i++) {
                await mediaService.addReferenceMedia({
                    elementId: ELEMENT_ID,
                    imageUrl: `https://example.com/dyn-${i}.png`,
                    userId: "user-limit",
                });
            }

            // 4th image must be rejected at the 3 limit
            await assert.rejects(
                async () => {
                    await mediaService.assertUploadAllowed({
                        elementId: ELEMENT_ID,
                        userId: "user-limit",
                    });
                },
                (err) => {
                    assert.equal(err.statusCode, 400);
                    assert.equal(err.errorCode, "LIMIT_EXCEEDED");
                    assert.match(err.message, /Maximum 3 reference images allowed/i);
                    assert.equal(err.details?.maxAllowed, 3);
                    return true;
                }
            );
        } finally {
            if (origEnv !== undefined) {
                process.env.ELEMENT_MAX_MEDIA = origEnv;
            } else {
                delete process.env.ELEMENT_MAX_MEDIA;
            }
        }
    });

    it("8. Protects against concurrent uploads: simultaneous additions at max-1 allow only one to succeed", async () => {
        // Fill 5 slots out of 6
        for (let i = 1; i <= 5; i++) {
            await mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                imageUrl: `https://example.com/concurrent-base-${i}.png`,
                userId: "user-limit",
            });
        }

        const beforeConcurrent = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(beforeConcurrent.length, 5);

        // Fire 2 simultaneous uploads targeting the remaining 1 slot
        const results = await Promise.allSettled([
            mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                imageUrl: "https://example.com/race-1.png",
                userId: "user-limit",
            }),
            mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                imageUrl: "https://example.com/race-2.png",
                userId: "user-limit",
            }),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");

        assert.equal(fulfilled.length, 1, "Exactly one concurrent upload must succeed");
        assert.equal(rejected.length, 1, "The second concurrent upload must be rejected");
        assert.equal(rejected[0].reason?.statusCode, 400);
        assert.equal(rejected[0].reason?.errorCode, "LIMIT_EXCEEDED");

        // Verify repository strictly contains 6 items
        const afterConcurrent = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(afterConcurrent.length, 6, "Repository must never exceed 6 images under concurrency");
    });

    it("9. preUploadElementCapacityGuard middleware passes next() when element has slots", async () => {
        const guard = createPreUploadElementCapacityGuard(mediaService);
        let nextCalled = false;
        const mockReq = {
            params: { id: ELEMENT_ID },
            user: { id: "user-limit" },
        };
        const mockRes = {
            status: () => mockRes,
            json: () => mockRes,
        };

        await guard(mockReq, mockRes, () => {
            nextCalled = true;
        });

        assert.equal(nextCalled, true, "next() must be called when slots are available");
    });

    it("10. preUploadElementCapacityGuard middleware rejects with 400 and halts pipeline before multer when full", async () => {
        for (let i = 1; i <= 6; i++) {
            await mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                imageUrl: `https://example.com/guard-${i}.png`,
                userId: "user-limit",
            });
        }

        const guard = createPreUploadElementCapacityGuard(mediaService);
        let nextCalled = false;
        let responseStatus = null;
        let responseJson = null;

        const mockReq = {
            params: { id: ELEMENT_ID },
            user: { id: "user-limit" },
        };
        const mockRes = {
            status: (code) => {
                responseStatus = code;
                return mockRes;
            },
            json: (body) => {
                responseJson = body;
                return mockRes;
            },
        };

        await guard(mockReq, mockRes, () => {
            nextCalled = true;
        });

        assert.equal(nextCalled, false, "next() MUST NOT be called when limit is exceeded (protecting Multer)");
        assert.equal(responseStatus, 400, "Response status must be 400");
        assert.equal(responseJson.code, "LIMIT_EXCEEDED");
        assert.match(responseJson.message, /Maximum 6 reference images allowed/i);
    });

    it("11. preUploadElementCapacityGuard middleware returns 404 for cross-tenant access without calling next()", async () => {
        elementsStore[0].user_id = "user-limit";

        const guard = createPreUploadElementCapacityGuard(mediaService);
        let nextCalled = false;
        let responseStatus = null;

        const mockReq = {
            params: { id: ELEMENT_ID },
            user: { id: "attacker-user" },
        };
        const mockRes = {
            status: (code) => {
                responseStatus = code;
                return mockRes;
            },
            json: () => mockRes,
        };

        await guard(mockReq, mockRes, () => {
            nextCalled = true;
        });

        assert.equal(nextCalled, false, "next() must not be called on unauthorized upload");
        assert.equal(responseStatus, 404, "Cross-tenant access must return 404 before file stream");
    });

    it("12. preUploadElementCapacityGuard ignores req.body.userId and rejects unauthenticated request with 401", async () => {
        const guard = createPreUploadElementCapacityGuard(mediaService);
        let nextCalled = false;
        let responseStatus = null;
        let responseJson = null;

        const mockReq = {
            params: { id: ELEMENT_ID },
            body: { userId: "user-limit" },
            user: null,
        };
        const mockRes = {
            status: (code) => {
                responseStatus = code;
                return mockRes;
            },
            json: (body) => {
                responseJson = body;
                return mockRes;
            },
        };

        await guard(mockReq, mockRes, () => {
            nextCalled = true;
        });

        assert.equal(nextCalled, false, "next() must not be called when unauthenticated");
        assert.equal(responseStatus, 401, "Must reject with 401 UNAUTHORIZED");
        assert.equal(responseJson.code, "UNAUTHORIZED");
    });
});
}
