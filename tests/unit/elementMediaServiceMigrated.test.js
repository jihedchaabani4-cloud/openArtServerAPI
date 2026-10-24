process.env.NODE_ENV = "test";

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";
import { ELEMENT_REFERENCE_UPLOAD_POLICY, ELEMENT_SHEET_UPLOAD_POLICY } from "../../src/platform/media-ingestion/UploadPolicy.js";
import { CrudServiceError } from "../../src/utils/crudOperationLog.js";

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

        it("calls mediaUploadService.upload with ELEMENT_SHEET_UPLOAD_POLICY and attaches with setPrimary: true", async () => {
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
            assert.equal(attachCalls[0].role, "detail");
            assert.equal(attachCalls[0].setPrimary, true);
        });

        it("an old sheet exists, attach of the new sheet fails mid-way -> old sheet/primary restored, new media row deleted, storage discarded, complete === true", async () => {
            const OLD_SHEET_MEDIA_ID = "00000000-0000-0000-0000-000000000088";
            let primaryMediaId = OLD_SHEET_MEDIA_ID;
            let newMediaDeleted = false;
            let discardedKeys = [];
            let rollbackSummary = null;

            mockWorkflowMediaService.attachMediaItems = async ({ workflowId, items }) => {
                const uploadedFile = items[0]?.uploadedFile;
                const newMediaId = "00000000-0000-0000-0000-000000000099";

                const previousPrimaryMediaId = primaryMediaId;
                primaryMediaId = newMediaId;

                const rollbackHandle = {
                    workflowId,
                    role: "detail",
                    previousPrimaryMediaId,
                    primaryModified: true,
                    newPrimaryMediaId: newMediaId,
                    entries: [
                        {
                            kind: "uploaded",
                            mediaId: newMediaId,
                            storageKey: uploadedFile.storageKey,
                            mediaCreatedInCall: true,
                            linkCreatedInCall: true,
                        },
                    ],
                };

                rollbackSummary = await mockWorkflowMediaService.rollbackAttachedMedia(rollbackHandle);

                throw new CrudServiceError("Database constraint error during sheet attachment", {
                    statusCode: 500,
                    errorCode: "ATTACH_FAILED",
                });
            };

            mockWorkflowMediaService.rollbackAttachedMedia = async (handle) => {
                primaryMediaId = handle.previousPrimaryMediaId;
                newMediaDeleted = true;
                const keys = handle.entries.map((e) => e.storageKey).filter(Boolean);
                discardedKeys.push(...keys);

                return {
                    complete: true,
                    unlinkedMediaIds: [handle.newPrimaryMediaId],
                    deletedMediaIds: [handle.newPrimaryMediaId],
                    discardedStorageKeys: keys,
                    skippedStorageKeys: [],
                    discardFailedKeys: [],
                    restoredPrimaryMediaId: handle.previousPrimaryMediaId,
                };
            };

            await assert.rejects(
                () => service.setSheetMedia({
                    elementId: ELEMENT_ID,
                    file: { buffer: Buffer.from("new-sheet-payload"), mimetype: "image/png" },
                    userId: USER_ID,
                    projectId: PROJECT_ID,
                }),
                (err) => err instanceof CrudServiceError && err.statusCode === 500
            );

            assert.equal(primaryMediaId, OLD_SHEET_MEDIA_ID, "Old sheet primary must be restored");
            assert.equal(rollbackSummary.restoredPrimaryMediaId, OLD_SHEET_MEDIA_ID);
            assert.equal(newMediaDeleted, true, "New media row must be deleted");
            assert.deepEqual(rollbackSummary.deletedMediaIds, ["00000000-0000-0000-0000-000000000099"]);
            assert.ok(discardedKeys.length > 0, "Uploaded storage file must be discarded");
            assert.equal(rollbackSummary.complete, true, "Rollback must report complete === true");
        });
    });

    describe("3. ingestElementSources (@deprecated)", () => {
        it("delegates multiple files upload and attach to mediaUploadService and workflowMediaService", async () => {
            const res = await service.ingestElementSources({
                workflowId: WORKFLOW_ID,
                sourceImages: ["https://example.com/1.png", "https://example.com/2.png"],
                projectId: PROJECT_ID,
                userId: USER_ID,
            });

            assert.equal(uploadCalls.length, 1);
            assert.equal(uploadCalls[0].policy, ELEMENT_REFERENCE_UPLOAD_POLICY);
            assert.equal(attachCalls.length, 1);
            assert.equal(attachCalls[0].role, "detail");
            assert.equal(attachCalls[0].maxAllowed, 6);
            assert.equal(attachCalls[0].setPrimary, true);
            assert.equal(res.mediaRecords.length, 2);
        });

        it("batch failure mid-way rolls back everything created in the call", async () => {
            let rollbackInvoked = false;
            let discardedStorage = [];

            mockWorkflowMediaService.attachMediaItems = async ({ items, workflowId }) => {
                const handle = {
                    workflowId,
                    role: "detail",
                    entries: items.map((it, idx) => ({
                        kind: "uploaded",
                        mediaId: `new-media-${idx}`,
                        storageKey: it.uploadedFile?.storageKey,
                        mediaCreatedInCall: true,
                        linkCreatedInCall: idx === 0,
                    })),
                };

                const res = await mockWorkflowMediaService.rollbackAttachedMedia(handle);
                rollbackInvoked = res.complete;
                throw new CrudServiceError("Mid-way failure in batch attachment", {
                    statusCode: 500,
                    errorCode: "ATTACH_BATCH_FAILED",
                });
            };

            mockWorkflowMediaService.rollbackAttachedMedia = async (handle) => {
                const keys = handle.entries.map((e) => e.storageKey).filter(Boolean);
                discardedStorage.push(...keys);
                return {
                    complete: true,
                    unlinkedMediaIds: handle.entries.filter((e) => e.linkCreatedInCall).map((e) => e.mediaId),
                    deletedMediaIds: handle.entries.filter((e) => e.mediaCreatedInCall).map((e) => e.mediaId),
                    discardedStorageKeys: keys,
                    skippedStorageKeys: [],
                    discardFailedKeys: [],
                };
            };

            await assert.rejects(
                () => service.ingestElementSources({
                    workflowId: WORKFLOW_ID,
                    sourceImages: ["https://example.com/1.png", "https://example.com/2.png"],
                    projectId: PROJECT_ID,
                    userId: USER_ID,
                }),
                (err) => err instanceof CrudServiceError && err.statusCode === 500
            );

            assert.equal(rollbackInvoked, true, "Rollback must execute with complete === true");
            assert.ok(discardedStorage.length > 0, "Uploaded storage keys must be discarded on mid-way failure");
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
