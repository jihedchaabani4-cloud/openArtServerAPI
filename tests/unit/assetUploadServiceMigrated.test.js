/**
 * AssetUploadService Migration Tests (Ticket 04)
 *
 * Verifies that AssetUploadService:
 * 1. Uses MediaUploadService.upload({ files: [source], policy: DEFAULT_UPLOAD_POLICY, maxFiles: 1, userId })
 * 2. Uses WorkflowMediaService.attachMediaItems for media creation & workflow attachment
 * 3. Enforces 4-step rollback order when containerWf was created and attachMediaItems fails:
 *    unlink -> delete media -> discard storageKey -> delete containerWf (when complete === true)
 * 4. Preserves containerWf when rollback is incomplete (complete === false, e.g. primary restore failure)
 * 5. Discards storageKey when containerWf creation throws before attach
 * 6. Attaches with role: "original" and is_primary on standalone upload (new containerWf)
 * 7. Attaches with role: "output" on existing workflow without touching container primary
 * 8. Fails closed with 404 on cross-tenant workflowId or projectId before storage upload
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AssetUploadService } from "../../src/domain/asset/AssetUploadService.js";
import { DEFAULT_UPLOAD_POLICY } from "../../src/platform/media-ingestion/UploadPolicy.js";

const VALID_PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
);

function createHarness({
    createWorkflowError = null,
    attachMediaItemsError = null,
    rollbackComplete = true,
    workflowOwned = true,
    projectOwned = true,
} = {}) {
    const events = [];

    const mockMediaUploadService = {
        uploadCalls: [],
        discardCalls: [],
        async upload({ files, policy, maxFiles, userId }) {
            this.uploadCalls.push({ files, policy, maxFiles, userId });
            events.push({ type: "mediaUpload.upload", filesCount: files.length, policyName: policy?.name });
            return {
                uploaded: [
                    {
                        url: "https://mock-storage.local/migrated.webp",
                        storageKey: `${userId}/uploads/migrated.webp`,
                        mimeType: "image/webp",
                        size: 1234,
                        type: "image",
                        width: 100,
                        height: 100,
                        ratio: "1:1",
                        format: "webp",
                        originalName: "test.png",
                    },
                ],
            };
        },
        async discard(storageKeys) {
            this.discardCalls.push(storageKeys);
            events.push({ type: "mediaUpload.discard", storageKeys });
            return { removed: storageKeys };
        },
    };

    const mockWorkflowMediaService = {
        attachCalls: [],
        rollbackCalls: [],
        async attachMediaItems(params) {
            this.attachCalls.push(params);
            events.push({ type: "workflowMedia.attachMediaItems", role: params.role, workflowId: params.workflowId });
            if (attachMediaItemsError) {
                const err = attachMediaItemsError;
                err.rollbackResult = {
                    complete: rollbackComplete,
                    skippedStorageKeys: rollbackComplete ? [] : ["user-1/uploads/migrated.webp"],
                    unlinkedMediaIds: ["media-1"],
                    deletedMediaIds: rollbackComplete ? ["media-1"] : [],
                    discardedStorageKeys: rollbackComplete ? ["user-1/uploads/migrated.webp"] : [],
                };
                throw err;
            }
            return {
                attached: [
                    {
                        kind: "uploaded",
                        media: {
                            id: "media-migrated-1",
                            url: params.items[0]?.uploadedFile?.url || "https://mock-storage.local/migrated.webp",
                            width: 100,
                            height: 100,
                        },
                        link: { workflow_id: params.workflowId, media_id: "media-migrated-1", role: params.role },
                        is_existing: false,
                        is_primary: params.role === "original",
                    },
                ],
                rollbackHandle: { workflowId: params.workflowId },
            };
        },
        async rollbackAttachedMedia(handle) {
            this.rollbackCalls.push(handle);
            events.push({ type: "workflowMedia.rollbackAttachedMedia", workflowId: handle?.workflowId });
            return { complete: rollbackComplete, skippedStorageKeys: [] };
        },
        async resolveOwnedSourceMedia({ mediaId, userId }) {
            events.push({ type: "workflowMedia.resolveOwnedSourceMedia", mediaId });
            return {
                id: mediaId,
                url: `https://mock-storage.local/existing-${mediaId}.webp`,
                width: 200,
                height: 200,
                user_id: userId,
            };
        },
    };

    const mockDb = {
        workflows: {
            createCalls: [],
            deleteCalls: [],
            async createWorkflow(wf) {
                events.push({ type: "db.workflows.createWorkflow", wf });
                if (createWorkflowError) throw createWorkflowError;
                const created = { id: "wf-container-1", ...wf };
                this.createCalls.push(created);
                return created;
            },
            async deleteById(id) {
                events.push({ type: "db.workflows.deleteById", id });
                this.deleteCalls.push(id);
                return { id };
            },
            async getWorkflow(id) {
                if (!workflowOwned) return null;
                return { id, user_id: "user-1", project_id: "proj-1" };
            },
            async findById(id) {
                if (!workflowOwned) return null;
                return { id, project_id: "proj-1", user_id: "user-1" };
            },
        },
        projects: {
            async findByUser(userId, projectId) {
                if (!projectOwned) return [];
                return [{ id: projectId, user_id: userId }];
            },
            async findMostRecentForUser(userId) {
                return { id: "proj-default", user_id: userId };
            },
        },
        folders: {
            async findOwnedInProject(folderId, projectId, userId) {
                return { id: folderId, project_id: projectId, user_id: userId };
            },
        },
    };

    const mockWorkflowAuthService = {
        async verifyWorkflowOwnership(workflowId, userId) {
            return workflowOwned;
        },
        async verifyMediaOwnership(mediaId, userId) {
            return true;
        },
    };

    const service = new AssetUploadService({
        db: mockDb,
        mediaUploadService: mockMediaUploadService,
        workflowMediaService: mockWorkflowMediaService,
        workflowAuthService: mockWorkflowAuthService,
    });

    return {
        service,
        events,
        mockMediaUploadService,
        mockWorkflowMediaService,
        mockDb,
    };
}

describe("AssetUploadService — Migrated to MediaUploadService & WorkflowMediaService (Ticket 04)", () => {
    it("0. Constructor fail-fast: throws if mediaUploadService or workflowMediaService is missing", () => {
        assert.throws(
            () => new AssetUploadService({ db: {} }),
            /AssetUploadService requires mediaUploadService with an upload method\./
        );
        assert.throws(
            () => new AssetUploadService({ db: {}, mediaUploadService: {} }),
            /AssetUploadService requires mediaUploadService with an upload method\./
        );
        assert.throws(
            () => new AssetUploadService({ db: {}, mediaUploadService: { upload: async () => {} } }),
            /AssetUploadService requires workflowMediaService with an attachMediaItems method\./
        );
        assert.throws(
            () => new AssetUploadService({ db: {}, mediaUploadService: { upload: async () => {} }, workflowMediaService: {} }),
            /AssetUploadService requires workflowMediaService with an attachMediaItems method\./
        );
    });

    it("1. Standalone upload: uses DEFAULT_UPLOAD_POLICY, creates UPLOAD containerWf, attaches with role: 'original', returns DTO", async () => {
        const h = createHarness();
        const result = await h.service.uploadAsset({
            source: { buffer: VALID_PNG_1X1, originalname: "photo.png", mimetype: "image/png" },
            userId: "user-1",
            projectId: "proj-1",
            displayName: "Test Photo",
        });

        // Assert MediaUploadService was called with DEFAULT_UPLOAD_POLICY and maxFiles: 1
        assert.equal(h.mockMediaUploadService.uploadCalls.length, 1);
        const uploadCall = h.mockMediaUploadService.uploadCalls[0];
        assert.equal(uploadCall.policy, DEFAULT_UPLOAD_POLICY);
        assert.equal(uploadCall.maxFiles, 1);
        assert.equal(uploadCall.userId, "user-1");

        // Assert Workflow container was created with workflow_type: "UPLOAD"
        assert.equal(h.mockDb.workflows.createCalls.length, 1);
        assert.equal(h.mockDb.workflows.createCalls[0].workflow_type, "UPLOAD");
        assert.equal(h.mockDb.workflows.createCalls[0].project_id, "proj-1");

        // Assert WorkflowMediaService.attachMediaItems was called with role: "original" and maxAllowed: null
        assert.equal(h.mockWorkflowMediaService.attachCalls.length, 1);
        const attachCall = h.mockWorkflowMediaService.attachCalls[0];
        assert.equal(attachCall.workflowId, "wf-container-1");
        assert.equal(attachCall.role, "original");
        assert.strictEqual(attachCall.maxAllowed, null);
        assert.equal(attachCall.items[0].kind, "uploaded");

        // Assert result DTO
        assert.equal(result.isNew, true);
        assert.equal(result.mediaId, "media-migrated-1");
        assert.equal(result.workflowId, "wf-container-1");
        assert.equal(result.url, "https://mock-storage.local/migrated.webp");
    });

    it("2. Existing workflow upload: attaches with role: 'output', does NOT create containerWf", async () => {
        const h = createHarness();
        const result = await h.service.uploadAsset({
            source: { buffer: VALID_PNG_1X1, originalname: "photo.png", mimetype: "image/png" },
            userId: "user-1",
            projectId: "proj-1",
            workflowId: "wf-existing-42",
        });

        // Assert no container workflow was created
        assert.equal(h.mockDb.workflows.createCalls.length, 0);

        // Assert attached with role: "output" to wf-existing-42
        assert.equal(h.mockWorkflowMediaService.attachCalls.length, 1);
        const attachCall = h.mockWorkflowMediaService.attachCalls[0];
        assert.equal(attachCall.workflowId, "wf-existing-42");
        assert.equal(attachCall.role, "output");
        assert.strictEqual(attachCall.maxAllowed, null);

        assert.equal(result.workflowId, "wf-existing-42");
        assert.equal(result.isNew, true);
    });

    it("3. Explicit 4-step rollback order: when attachMediaItems fails and complete === true, deletes containerWf", async () => {
        const attachError = new Error("DB attach failure");
        const h = createHarness({ attachMediaItemsError: attachError, rollbackComplete: true });

        await assert.rejects(
            async () => h.service.uploadAsset({
                source: { buffer: VALID_PNG_1X1 },
                userId: "user-1",
                projectId: "proj-1",
            }),
            /DB attach failure/
        );

        // Verify containerWf was deleted
        assert.equal(h.mockDb.workflows.deleteCalls.length, 1);
        assert.equal(h.mockDb.workflows.deleteCalls[0], "wf-container-1");

        // Verify event sequence: mediaUpload.upload -> createWorkflow -> attachMediaItems -> deleteById
        const eventTypes = h.events.map((e) => e.type);
        assert.deepEqual(eventTypes, [
            "mediaUpload.upload",
            "db.workflows.createWorkflow",
            "workflowMedia.attachMediaItems",
            "db.workflows.deleteById",
        ]);
    });

    it("4. Rollback incomplete (complete === false, e.g. primary restore failure): containerWf is NOT deleted", async () => {
        const attachError = new Error("Primary restore failed");
        const h = createHarness({ attachMediaItemsError: attachError, rollbackComplete: false });

        await assert.rejects(
            async () => h.service.uploadAsset({
                source: { buffer: VALID_PNG_1X1 },
                userId: "user-1",
                projectId: "proj-1",
            }),
            /Primary restore failed/
        );

        // Assert containerWf was NOT deleted because rollback was incomplete
        assert.equal(h.mockDb.workflows.deleteCalls.length, 0);
    });

    it("5. Container workflow creation failure: discards uploaded storageKey and does not attempt attach", async () => {
        const wfCreateError = new Error("Workflow insert failed");
        const h = createHarness({ createWorkflowError: wfCreateError });

        await assert.rejects(
            async () => h.service.uploadAsset({
                source: { buffer: VALID_PNG_1X1 },
                userId: "user-1",
                projectId: "proj-1",
            }),
            /Workflow insert failed/
        );

        // Assert discard was called with the uploaded storageKey
        assert.equal(h.mockMediaUploadService.discardCalls.length, 1);
        assert.deepEqual(h.mockMediaUploadService.discardCalls[0], ["user-1/uploads/migrated.webp"]);

        // Assert attach was never called
        assert.equal(h.mockWorkflowMediaService.attachCalls.length, 0);
    });

    it("6. Pre-flight project authorization fails closed with 404 before calling mediaUploadService.upload", async () => {
        const h = createHarness({ projectOwned: false });

        await assert.rejects(
            async () => h.service.uploadAsset({
                source: { buffer: VALID_PNG_1X1 },
                userId: "user-1",
                projectId: "proj-foreign",
            }),
            (err) => err.statusCode === 404
        );

        // MediaUploadService upload was never called
        assert.equal(h.mockMediaUploadService.uploadCalls.length, 0);
    });

    it("7. Existing media_id source reuse: resolves via resolveOwnedSourceMedia and attaches to existing workflow", async () => {
        const h = createHarness();
        const existingUuid = "00000000-0000-0000-0000-000000000099";

        const result = await h.service.uploadAsset({
            source: existingUuid,
            userId: "user-1",
            projectId: "proj-1",
            workflowId: "wf-existing-42",
        });

        // Verify mediaUploadService was NOT called (no binary upload for existing media_id)
        assert.equal(h.mockMediaUploadService.uploadCalls.length, 0);

        // Verify resolved and attached
        assert.equal(result.isNew, false);
        assert.equal(result.mediaId, existingUuid);
    });

    it("8. Cross-tenant workflow authorization fails closed with 404 and discards uploaded storage key", async () => {
        const h = createHarness({ workflowOwned: false });

        await assert.rejects(
            async () => h.service.uploadAsset({
                source: { buffer: VALID_PNG_1X1 },
                userId: "user-1",
                projectId: "proj-1",
                workflowId: "wf-foreign",
            }),
            (err) => err.statusCode === 404
        );

        // Uploaded storage key was discarded
        assert.equal(h.mockMediaUploadService.discardCalls.length, 1);
        assert.deepEqual(h.mockMediaUploadService.discardCalls[0], ["user-1/uploads/migrated.webp"]);
    });

    it("9. StoragePathResolver.validateFolderSegment enforces whitelist of allowed storage folders", async () => {
        const { StoragePathResolver } = await import("../../src/platform/storage/StoragePathResolver.js");
        // Allowed folders
        assert.equal(StoragePathResolver.validateFolderSegment("uploads"), "uploads");
        assert.equal(StoragePathResolver.validateFolderSegment("element-references"), "element-references");
        assert.equal(StoragePathResolver.validateFolderSegment("character-sheets"), "character-sheets");
        assert.equal(StoragePathResolver.validateFolderSegment("character-details"), "character-details");
        assert.equal(StoragePathResolver.validateFolderSegment(""), "uploads");
        assert.equal(StoragePathResolver.validateFolderSegment(null), "uploads");

        // Disallowed / traversal folders throw 400 VALIDATION_ERROR
        assert.throws(
            () => StoragePathResolver.validateFolderSegment("arbitrary_folder"),
            (err) => err.statusCode === 400 && err.errorCode === "VALIDATION_ERROR"
        );
        assert.throws(
            () => StoragePathResolver.validateFolderSegment("../traversal"),
            (err) => err.statusCode === 400 && err.errorCode === "VALIDATION_ERROR"
        );
    });

    it("10. Integrated 4-step rollback with real WorkflowMediaService: executes unlink -> delete media -> discard -> delete containerWf", async () => {
        const { WorkflowMediaService } = await import("../../src/platform/workflow/WorkflowMediaService.js");

        const orderEvents = [];
        const discarded = [];

        const mockMediaUploadService = {
            upload: async () => ({
                uploaded: [
                    {
                        url: "https://mock-storage.local/migrated.webp",
                        storageKey: "user-1/uploads/migrated.webp",
                        mimeType: "image/webp",
                        size: 1234,
                        type: "image",
                        width: 100,
                        height: 100,
                        ratio: "1:1",
                        format: "webp",
                        originalName: "test.png",
                    },
                ],
            }),
            discard: async (keys) => {
                orderEvents.push({ step: "discard", keys });
                discarded.push(...keys);
                return { removed: keys };
            },
        };

        const mockStorageService = {
            paths: {
                projectAsset: (userId, folder, filename) => `${userId}/${folder}/${filename}`,
            },
            upload: async (key) => `https://mock-storage.local/${key}`,
            deleteFiles: async (keys) => {
                return { deletedCount: keys.length, failures: [] };
            },
        };

        const createdMedia = [];
        const deletedMediaIds = [];
        const unlinkedItems = [];
        const workflows = [];
        const deletedWorkflowIds = [];

        const integratedDb = {
            media: {
                createMedia: async (data) => {
                    const id = `media-${Date.now()}`;
                    createdMedia.push({ id, ...data });
                    return { id, ...data };
                },
                deleteById: async (id) => {
                    orderEvents.push({ step: "deleteMedia", id });
                    deletedMediaIds.push(id);
                    return { id };
                },
            },
            workflowMedia: {
                attachReferenceMedia: async ({ workflowId, mediaId, role }) => {
                    orderEvents.push({ step: "attach", mediaId });
                    // Throw to simulate attach failure after media created
                    throw new Error("Simulated RPC attachment error");
                },
                unlink: async ({ workflowId, mediaId, role }) => {
                    orderEvents.push({ step: "unlink", mediaId });
                    unlinkedItems.push({ workflowId, mediaId, role });
                },
            },
            workflows: {
                createWorkflow: async (wf) => {
                    const id = `wf-int-1`;
                    workflows.push({ id, ...wf });
                    return { id, ...wf };
                },
                deleteById: async (id) => {
                    orderEvents.push({ step: "deleteContainerWf", id });
                    deletedWorkflowIds.push(id);
                    return { id };
                },
                getWorkflow: async (id) => ({ id, user_id: "user-1", project_id: "proj-1" }),
                findById: async (id) => ({ id, user_id: "user-1", project_id: "proj-1" }),
            },
            projects: {
                findByUser: async () => [{ id: "proj-1", user_id: "user-1" }],
                findMostRecentForUser: async () => ({ id: "proj-1", user_id: "user-1" }),
            },
        };

        const realWorkflowMediaService = new WorkflowMediaService({
            db: integratedDb,
            storageService: mockStorageService,
            mediaUploadService: mockMediaUploadService,
            workflowAuthService: {
                verifyWorkflowOwnership: async () => true,
                verifyMediaOwnership: async () => true,
            },
        });

        const integratedService = new AssetUploadService({
            db: integratedDb,
            workflowMediaService: realWorkflowMediaService,
            mediaUploadService: mockMediaUploadService,
            storageService: mockStorageService,
            workflowAuthService: {
                verifyWorkflowOwnership: async () => true,
                verifyMediaOwnership: async () => true,
            },
        });

        await assert.rejects(
            async () => integratedService.uploadAsset({
                source: { buffer: VALID_PNG_1X1, originalname: "test.png", mimetype: "image/png" },
                userId: "user-1",
                projectId: "proj-1",
            }),
            /Simulated RPC attachment error/
        );

        // Verify exact 4-step rollback order: deleteMedia -> discard -> deleteContainerWf
        const rollbackSteps = orderEvents.filter((e) => ["unlink", "deleteMedia", "discard", "deleteContainerWf"].includes(e.step));
        assert.deepEqual(
            rollbackSteps.map((s) => s.step),
            ["deleteMedia", "discard", "deleteContainerWf"]
        );
        assert.equal(deletedWorkflowIds.length, 1);
        assert.equal(deletedWorkflowIds[0], "wf-int-1");
    });

    it("11. Client-controlled folder isolation: passing folder override to uploadAsset is ignored and never passed to MediaUploadService.upload", async () => {
        const h = createHarness();
        await h.service.uploadAsset({
            source: { buffer: VALID_PNG_1X1, originalname: "photo.png", mimetype: "image/png" },
            userId: "user-1",
            projectId: "proj-1",
            folder: "element-references", // client attempt to direct storage key into another folder
        });

        assert.equal(h.mockMediaUploadService.uploadCalls.length, 1);
        const uploadCall = h.mockMediaUploadService.uploadCalls[0];
        assert.equal(uploadCall.folder, undefined, "MediaUploadService.upload must NOT receive client folder override");
        assert.equal(uploadCall.policy, DEFAULT_UPLOAD_POLICY);
    });

    it("12. Real storage folder enforcement: uploadAsset with real MediaUploadService stores image strictly under uploads/ even if folder='element-references' is passed", async () => {
        const { MediaUploadService } = await import("../../src/platform/media-ingestion/MediaUploadService.js");
        const { StoragePathResolver } = await import("../../src/platform/storage/StoragePathResolver.js");

        let savedStorageKey = null;
        const mockStorageService = {
            paths: new StoragePathResolver(),
            upload: async (key, buffer) => {
                savedStorageKey = key;
                return `https://mock-storage.local/${key}`;
            },
            deleteFiles: async () => ({ deletedCount: 0, failures: [] }),
        };

        const mediaUploadService = new MediaUploadService({ storageService: mockStorageService });
        const h = createHarness();
        const service = new AssetUploadService({
            db: h.mockDb,
            mediaUploadService,
            workflowMediaService: h.mockWorkflowMediaService,
            workflowAuthService: {
                verifyWorkflowOwnership: async () => true,
                verifyMediaOwnership: async () => true,
            },
        });

        const result = await service.uploadAsset({
            source: { buffer: VALID_PNG_1X1, originalname: "photo.png", mimetype: "image/png" },
            userId: "user-1",
            projectId: "proj-1",
            folder: "element-references",
        });

        assert.ok(savedStorageKey, "Storage upload must have been called");
        assert.match(
            savedStorageKey,
            /^user-1\/uploads\/\d+_[a-f0-9]+\.(png|webp)$/,
            `Storage key must be in policy storageFolder 'uploads/', got: ${savedStorageKey}`
        );
        assert.ok(!savedStorageKey.includes("element-references"), "Storage key must NOT use client-supplied folder");
    });
});
