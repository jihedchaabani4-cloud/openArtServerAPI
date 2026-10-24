process.env.NODE_ENV = "test";

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    CharacterMediaService,
    CHARACTER_MAX_DETAIL_MEDIA,
} from "../../src/domain/character/CharacterMediaService.js";
import { CrudServiceError } from "../../src/utils/crudOperationLog.js";
import {
    CHARACTER_SHEET_UPLOAD_POLICY,
    CHARACTER_DETAIL_UPLOAD_POLICY,
} from "../../src/platform/media-ingestion/UploadPolicy.js";
import { WorkflowMediaService } from "../../src/platform/workflow/WorkflowMediaService.js";

describe("CharacterMediaService — Migrated to MediaUploadService & WorkflowMediaService (Ticket 06)", () => {
    let mockDb;
    let mockStorageService;
    let mockUploadService;
    let mockWorkflowMediaService;
    let mockAuthService;
    let workflowsStore;
    let charactersStore;
    let mediaStore;
    let workflowMediaStore;
    let uploadCalls;
    let discardCalls;
    let service;

    const CHARACTER_ID = "00000000-0000-0000-0000-000000000001";
    const WORKFLOW_ID = CHARACTER_ID;
    const PROJECT_ID = "00000000-0000-0000-0000-000000000100";
    const USER_ID = "user-char-1";

    beforeEach(() => {
        workflowsStore = [
            {
                id: WORKFLOW_ID,
                project_id: PROJECT_ID,
                user_id: USER_ID,
                workflow_type: "CHARACTER",
                primary_media_id: null,
            },
        ];
        charactersStore = [
            {
                id: CHARACTER_ID,
                workflow_id: WORKFLOW_ID,
                status: "draft",
            },
        ];
        mediaStore = [];
        workflowMediaStore = [];
        uploadCalls = [];
        discardCalls = [];

        mockDb = {
            workflows: {
                getWorkflow: async (id) => workflowsStore.find((w) => w.id === id) || null,
                findById: async (id) => workflowsStore.find((w) => w.id === id) || null,
                updatePrimaryMedia: async (wfId, mediaId) => {
                    const wf = workflowsStore.find((w) => w.id === wfId);
                    if (wf) wf.primary_media_id = mediaId;
                    return wf;
                },
                updateFields: async (wfId, fields) => {
                    const wf = workflowsStore.find((w) => w.id === wfId);
                    if (wf) Object.assign(wf, fields);
                    return wf;
                },
            },
            characters: {
                updateCharacterFields: async (id, fields) => {
                    const c = charactersStore.find((char) => char.id === id || char.workflow_id === id);
                    if (c) Object.assign(c, fields);
                    return c;
                },
            },
            media: {
                findById: async (id) => mediaStore.find((m) => m.id === id) || null,
                createMedia: async (payload) => {
                    const row = {
                        id: `media-${mediaStore.length + 1}`,
                        status: "completed",
                        ...payload,
                    };
                    mediaStore.push(row);
                    return row;
                },
                findByWorkflow: async (wfId) => {
                    const links = workflowMediaStore.filter((wm) => wm.workflow_id === wfId);
                    return links.map((l) => {
                        const m = mediaStore.find((item) => item.id === l.media_id) || {};
                        return { ...m, ...l };
                    });
                },
                deleteById: async (mediaId) => {
                    const idx = mediaStore.findIndex((m) => m.id === mediaId);
                    if (idx !== -1) mediaStore.splice(idx, 1);
                    return true;
                },
            },
            workflowMedia: {
                findByMedia: async (mediaId) => workflowMediaStore.filter((wm) => wm.media_id === mediaId),
                findByWorkflow: async (wfId) => workflowMediaStore.filter((wm) => wm.workflow_id === wfId),
                getPrimaryMedia: async (wfId) => workflowMediaStore.find((wm) => wm.workflow_id === wfId && wm.is_primary === true) || null,
                unlinkAndReapOrphan: async ({ workflowId, mediaId }) => {
                    const idx = workflowMediaStore.findIndex((wm) => wm.workflow_id === workflowId && wm.media_id === mediaId);
                    if (idx === -1) return { unlinked: false, is_orphan: false };
                    const [removed] = workflowMediaStore.splice(idx, 1);
                    const remaining = workflowMediaStore.filter((wm) => wm.media_id === mediaId).length;
                    return {
                        unlinked: true,
                        is_orphan: remaining === 0,
                        was_primary: Boolean(removed.is_primary),
                    };
                },
            },
        };

        mockStorageService = {
            deleteByUrl: async () => true,
        };

        mockUploadService = {
            upload: async ({ files, policy, maxFiles, userId, folder }) => {
                uploadCalls.push({ files, policy, maxFiles, userId, folder });
                const uploaded = files.map((f, idx) => {
                    const targetFolder = policy.storageFolder || "character-details";
                    return {
                        url: `https://storage.example.com/${userId}/${targetFolder}/file-${Date.now()}-${idx + 1}.webp`,
                        storageKey: `${userId}/${targetFolder}/file-${Date.now()}-${idx + 1}.webp`,
                        mimeType: "image/webp",
                        size: 1024,
                        type: "image",
                        width: 1344,
                        height: 768,
                        ratio: "16:9",
                        format: "webp",
                        durationSec: 0,
                        originalName: typeof f === "object" ? f.originalname || f.name : "file.png",
                    };
                });
                return { uploaded };
            },
            discard: async (keys) => {
                discardCalls.push(keys);
                return { discardedCount: keys.length, failures: [] };
            },
        };

        mockWorkflowMediaService = {
            attachMediaItems: async ({ workflowId, projectId, userId, role = "detail", maxAllowed = null, setPrimary = false, autoPrimary = false, items = [] }) => {
                const existing = workflowMediaStore.filter((wm) => wm.workflow_id === workflowId && wm.role === role);
                if (maxAllowed !== null && existing.length + items.length > maxAllowed) {
                    const err = new CrudServiceError(`Maximum ${maxAllowed} ${role} media allowed`, {
                        statusCode: 400,
                        errorCode: "LIMIT_EXCEEDED",
                    });
                    throw err;
                }

                const currentWf = workflowsStore.find((w) => w.id === workflowId);
                const previousPrimaryMediaId = currentWf?.primary_media_id || null;

                const attached = [];
                for (const item of items) {
                    let mediaRecord;
                    let linkCreatedInCall = false;
                    let mediaCreatedInCall = false;

                    if (item.kind === "existing") {
                        if (!item.mediaId) throw new Error("mediaId is required for kind: 'existing'");
                        mediaRecord = mediaStore.find((m) => m.id === item.mediaId);
                        if (!mediaRecord || (mediaRecord.user_id && mediaRecord.user_id !== userId)) {
                            throw new CrudServiceError("Media not found", { statusCode: 404, errorCode: "NOT_FOUND" });
                        }
                    } else if (item.kind === "uploaded") {
                        if (!item.uploadedFile) throw new Error("uploadedFile is required for kind: 'uploaded'");
                        mediaRecord = {
                            id: `00000000-0000-0000-0000-00000000009${mediaStore.length + 1}`,
                            url: item.uploadedFile.url,
                            project_id: projectId,
                            user_id: userId,
                            step_id: "upload",
                            status: "completed",
                        };
                        mediaStore.push(mediaRecord);
                        mediaCreatedInCall = true;
                    } else {
                        throw new Error(`Item must specify kind ('uploaded' | 'existing')`);
                    }

                    const isPrimary = Boolean(setPrimary || (autoPrimary && existing.length === 0));
                    const linkRecord = {
                        workflow_id: workflowId,
                        media_id: mediaRecord.id,
                        role,
                        is_primary: isPrimary,
                    };
                    workflowMediaStore.push(linkRecord);
                    linkCreatedInCall = true;

                    attached.push({
                        kind: item.kind,
                        media: mediaRecord,
                        link: linkRecord,
                        is_primary: isPrimary,
                        storageKey: item.uploadedFile?.storageKey || null,
                        linkCreatedInCall,
                        mediaCreatedInCall,
                    });
                }

                let primaryModified = false;
                if (setPrimary && attached.length > 0) {
                    const targetMediaId = attached[attached.length - 1].media.id;
                    primaryModified = true;
                    if (currentWf) currentWf.primary_media_id = targetMediaId;
                }

                return {
                    attached,
                    rollbackHandle: {
                        workflowId,
                        previousPrimaryMediaId,
                        primaryModified,
                        entries: attached,
                    },
                };
            },
            rollbackAttachedMedia: async (handle) => {
                const unlinked = [];
                const deleted = [];
                const discarded = [];

                if (handle?.primaryModified && handle?.workflowId) {
                    const currentWf = workflowsStore.find((w) => w.id === handle.workflowId);
                    if (currentWf) currentWf.primary_media_id = handle.previousPrimaryMediaId || null;
                }

                if (handle?.entries) {
                    for (const entry of handle.entries) {
                        if (entry.linkCreatedInCall) {
                            const lIdx = workflowMediaStore.findIndex((wm) => wm.workflow_id === handle.workflowId && wm.media_id === entry.media.id);
                            if (lIdx !== -1) workflowMediaStore.splice(lIdx, 1);
                            unlinked.push(entry.media.id);
                        }
                        if (entry.mediaCreatedInCall) {
                            const mIdx = mediaStore.findIndex((m) => m.id === entry.media.id);
                            if (mIdx !== -1) mediaStore.splice(mIdx, 1);
                            deleted.push(entry.media.id);
                        }
                        if (entry.storageKey) {
                            await mockUploadService.discard([entry.storageKey]);
                            discarded.push(entry.storageKey);
                        }
                    }
                }
                return {
                    complete: true,
                    unlinkedMediaIds: unlinked,
                    deletedMediaIds: deleted,
                    discardedStorageKeys: discarded,
                    skippedStorageKeys: [],
                    discardFailedKeys: [],
                };
            },
        };

        mockAuthService = {
            verifyWorkflowOwnership: async (wfId, uId) => {
                if (!uId || uId === "anonymous") return false;
                const wf = workflowsStore.find((w) => w.id === wfId);
                return wf && wf.user_id === uId;
            },
        };

        service = new CharacterMediaService({
            db: mockDb,
            storageService: mockStorageService,
            mediaUploadService: mockUploadService,
            workflowMediaService: mockWorkflowMediaService,
            authService: mockAuthService,
        });
    });

    describe("1. Detail Media Quota & Attachment (CHARACTER_MAX_DETAIL_MEDIA = 5)", () => {
        it("6th NEW detail -> LIMIT_EXCEEDED (storage not touched)", async () => {
            for (let i = 1; i <= 5; i++) {
                workflowMediaStore.push({
                    workflow_id: WORKFLOW_ID,
                    media_id: `m-detail-${i}`,
                    role: "detail",
                });
            }

            await assert.rejects(
                () => service.uploadDetailMedia({
                    characterId: CHARACTER_ID,
                    file: { buffer: Buffer.from("new-detail-6"), originalname: "6.png", mimetype: "image/png" },
                    userId: USER_ID,
                    projectId: PROJECT_ID,
                }),
                (err) => err instanceof CrudServiceError && err.statusCode === 400 && err.errorCode === "LIMIT_EXCEEDED"
            );

            assert.equal(uploadCalls.length, 0, "Storage upload must not be touched when capacity is full");
            assert.equal(discardCalls.length, 0, "No storage to discard");
        });

        it("6th existing mediaId -> LIMIT_EXCEEDED", async () => {
            for (let i = 1; i <= 5; i++) {
                workflowMediaStore.push({
                    workflow_id: WORKFLOW_ID,
                    media_id: `m-detail-${i}`,
                    role: "detail",
                });
            }

            const existingMedia = {
                id: "00000000-0000-0000-0000-000000000006",
                url: "https://storage.example.com/existing-6.png",
                user_id: USER_ID,
                project_id: PROJECT_ID,
            };
            mediaStore.push(existingMedia);

            await assert.rejects(
                () => service.uploadDetailMedia({
                    characterId: CHARACTER_ID,
                    mediaId: existingMedia.id,
                    userId: USER_ID,
                    projectId: PROJECT_ID,
                }),
                (err) => err instanceof CrudServiceError && err.statusCode === 400 && err.errorCode === "LIMIT_EXCEEDED"
            );
        });

        it("character with 7 existing details: existing kept, new attach rejected", async () => {
            for (let i = 1; i <= 7; i++) {
                const m = {
                    id: `m-existing-${i}`,
                    url: `https://storage.example.com/detail-${i}.png`,
                    user_id: USER_ID,
                    project_id: PROJECT_ID,
                };
                mediaStore.push(m);
                workflowMediaStore.push({
                    workflow_id: WORKFLOW_ID,
                    media_id: m.id,
                    role: "detail",
                });
            }

            const current = workflowMediaStore.filter((wm) => wm.workflow_id === WORKFLOW_ID && wm.role === "detail");
            assert.equal(current.length, 7, "Existing 7 details must be kept without truncation");

            await assert.rejects(
                () => service.uploadDetailMedia({
                    characterId: CHARACTER_ID,
                    file: { buffer: Buffer.from("new-detail-8"), originalname: "8.png", mimetype: "image/png" },
                    userId: USER_ID,
                    projectId: PROJECT_ID,
                }),
                (err) => err instanceof CrudServiceError && err.statusCode === 400 && err.errorCode === "LIMIT_EXCEEDED"
            );

            assert.equal(uploadCalls.length, 0, "Upload must not be called");
            assert.equal(workflowMediaStore.filter((wm) => wm.workflow_id === WORKFLOW_ID && wm.role === "detail").length, 7);
        });

        it("atomic maxAllowed = 5 enforced by WorkflowMediaService.attachMediaItems (even if pre-check sees fewer)", async () => {
            for (let i = 1; i <= 5; i++) {
                workflowMediaStore.push({
                    workflow_id: WORKFLOW_ID,
                    media_id: `m-detail-${i}`,
                    role: "detail",
                });
            }
            mockDb.workflowMedia.findByWorkflow = async () => workflowMediaStore.slice(0, 4);

            await assert.rejects(
                () => service.uploadDetailMedia({
                    characterId: CHARACTER_ID,
                    file: { buffer: Buffer.from("race-detail"), originalname: "race.png" },
                    userId: USER_ID,
                    projectId: PROJECT_ID,
                }),
                (err) => err instanceof CrudServiceError && err.statusCode === 400 && err.errorCode === "LIMIT_EXCEEDED"
            );
        });
    });

    describe("2. Rollback Integrity & Mid-Way Failures", () => {
        it("batch failure mid-way rolls back everything created in the call", async () => {
            mockWorkflowMediaService.attachMediaItems = async ({ items, userId, projectId }) => {
                const attached = [];
                for (const item of items) {
                    const row = {
                        id: "00000000-0000-0000-0000-000000000077",
                        url: item.uploadedFile.url,
                        project_id: projectId,
                        user_id: userId,
                    };
                    mediaStore.push(row);
                    workflowMediaStore.push({
                        workflow_id: WORKFLOW_ID,
                        media_id: row.id,
                        role: "detail",
                        is_primary: false,
                    });
                    attached.push({
                        media: row,
                        link: { workflow_id: WORKFLOW_ID, media_id: row.id, role: "detail" },
                        storageKey: item.uploadedFile.storageKey,
                        linkCreatedInCall: true,
                        mediaCreatedInCall: true,
                    });
                }
                const err = new CrudServiceError("Simulated DB attachment failure", { statusCode: 500 });
                await mockWorkflowMediaService.rollbackAttachedMedia({ workflowId: WORKFLOW_ID, entries: attached });
                throw err;
            };

            await assert.rejects(
                () => service.uploadDetailMedia({
                    characterId: CHARACTER_ID,
                    file: { buffer: Buffer.from("payload") },
                    userId: USER_ID,
                    projectId: PROJECT_ID,
                }),
                (err) => err.statusCode === 500
            );

            assert.equal(mediaStore.length, 0, "Created media row must be rolled back");
            assert.equal(workflowMediaStore.length, 0, "Created link must be rolled back");
            assert.ok(discardCalls.length > 0, "Uploaded storage must be discarded on rollback");
        });

        it("pre-existing mediaId never deleted on failure", async () => {
            const preExistingMedia = {
                id: "00000000-0000-0000-0000-000000000055",
                url: "https://storage.example.com/pre-existing.png",
                user_id: USER_ID,
                project_id: PROJECT_ID,
            };
            mediaStore.push(preExistingMedia);

            mockWorkflowMediaService.attachMediaItems = async ({ items }) => {
                const attached = [{
                    media: preExistingMedia,
                    link: { workflow_id: WORKFLOW_ID, media_id: preExistingMedia.id, role: "detail" },
                    storageKey: null,
                    linkCreatedInCall: true,
                    mediaCreatedInCall: false, // pre-existing!
                }];
                workflowMediaStore.push(attached[0].link);
                const err = new CrudServiceError("Simulated mid-way failure", { statusCode: 500 });
                await mockWorkflowMediaService.rollbackAttachedMedia({ workflowId: WORKFLOW_ID, entries: attached });
                throw err;
            };

            await assert.rejects(
                () => service.uploadDetailMedia({
                    characterId: CHARACTER_ID,
                    mediaId: preExistingMedia.id,
                    userId: USER_ID,
                    projectId: PROJECT_ID,
                }),
                (err) => err.statusCode === 500
            );

            assert.ok(mediaStore.find((m) => m.id === preExistingMedia.id), "Pre-existing media row must NEVER be deleted");
            assert.equal(discardCalls.length, 0, "Pre-existing media storage must NEVER be discarded");
        });
    });

    describe("3. Security & Tenant Isolation", () => {
        it("cross-tenant mediaId and workflowId -> 404", async () => {
            // Foreign workflow
            await assert.rejects(
                () => service.uploadDetailMedia({
                    characterId: CHARACTER_ID,
                    file: { buffer: Buffer.from("data") },
                    userId: "attacker-user",
                    projectId: PROJECT_ID,
                }),
                (err) => err.statusCode === 404 && err.errorCode === "NOT_FOUND"
            );

            // Foreign mediaId
            const foreignMedia = {
                id: "00000000-0000-0000-0000-000000000404",
                url: "https://storage.example.com/foreign.png",
                user_id: "other-user",
                project_id: PROJECT_ID,
            };
            mediaStore.push(foreignMedia);

            await assert.rejects(
                () => service.uploadDetailMedia({
                    characterId: CHARACTER_ID,
                    mediaId: foreignMedia.id,
                    userId: USER_ID,
                    projectId: PROJECT_ID,
                }),
                (err) => err.statusCode === 404
            );
        });

        it("unauthenticated / 'anonymous' -> 401", async () => {
            for (const badUser of [null, undefined, "", "anonymous"]) {
                await assert.rejects(
                    () => service.uploadDetailMedia({
                        characterId: CHARACTER_ID,
                        file: { buffer: Buffer.from("data") },
                        userId: badUser,
                        projectId: PROJECT_ID,
                    }),
                    (err) => err.statusCode === 401 && err.errorCode === "UNAUTHORIZED"
                );

                await assert.rejects(
                    () => service.uploadSheetMedia({
                        characterId: CHARACTER_ID,
                        file: { buffer: Buffer.from("data") },
                        userId: badUser,
                        projectId: PROJECT_ID,
                    }),
                    (err) => err.statusCode === 401 && err.errorCode === "UNAUTHORIZED"
                );
            }
        });

        it("cross-project projectId mismatch -> 404 on uploadSheetMedia and uploadDetailMedia", async () => {
            await assert.rejects(
                () => service.uploadSheetMedia({
                    characterId: CHARACTER_ID,
                    file: { buffer: Buffer.from("data") },
                    userId: USER_ID,
                    projectId: "foreign-project-id",
                }),
                (err) => err.statusCode === 404 && err.errorCode === "NOT_FOUND"
            );

            await assert.rejects(
                () => service.uploadDetailMedia({
                    characterId: CHARACTER_ID,
                    file: { buffer: Buffer.from("data") },
                    userId: USER_ID,
                    projectId: "foreign-project-id",
                }),
                (err) => err.statusCode === 404 && err.errorCode === "NOT_FOUND"
            );
        });
    });

    describe("4. Storage Policy & Primary Media Canonical Behavior", () => {
        it("client folder override ignored (stays character-sheets / character-details)", async () => {
            await service.uploadDetailMedia({
                characterId: CHARACTER_ID,
                file: { buffer: Buffer.from("detail-data"), originalname: "detail.png" },
                folder: "malicious-folder-override",
                userId: USER_ID,
                projectId: PROJECT_ID,
            });

            assert.equal(uploadCalls[0].policy.storageFolder, "character-details");
            assert.ok(uploadCalls[0].policy === CHARACTER_DETAIL_UPLOAD_POLICY);

            await service.uploadSheetMedia({
                characterId: CHARACTER_ID,
                file: { buffer: Buffer.from("sheet-data"), originalname: "sheet.png" },
                folder: "another-bad-folder",
                userId: USER_ID,
                projectId: PROJECT_ID,
            });

            assert.equal(uploadCalls[1].policy.storageFolder, "character-sheets");
            assert.ok(uploadCalls[1].policy === CHARACTER_SHEET_UPLOAD_POLICY);
        });

        it("detail upload/attach never writes primary_media_id", async () => {
            const wf = workflowsStore.find((w) => w.id === WORKFLOW_ID);
            assert.equal(wf.primary_media_id, null);

            // 1. Detail upload: never writes primary_media_id, workflow_media.is_primary is false
            const detailRes = await service.uploadDetailMedia({
                characterId: CHARACTER_ID,
                file: { buffer: Buffer.from("detail-bytes"), originalname: "detail.png" },
                userId: USER_ID,
                projectId: PROJECT_ID,
            });
            assert.equal(wf.primary_media_id, null, "Detail upload must NEVER write workflows.primary_media_id");
            const detailLink = workflowMediaStore.find((wm) => wm.media_id === detailRes.media.id);
            assert.equal(detailLink.is_primary, false, "Detail link must have is_primary: false");

            // Detail mid-way failure: rollback must not touch primary_media_id
            mockWorkflowMediaService.attachMediaItems = async () => {
                throw new Error("Simulated mid-way detail attach failure");
            };

            await assert.rejects(
                () => service.uploadDetailMedia({
                    characterId: CHARACTER_ID,
                    file: { buffer: Buffer.from("failing-detail"), originalname: "detail-fail.png" },
                    userId: USER_ID,
                    projectId: PROJECT_ID,
                }),
                (err) => err.message === "Simulated mid-way detail attach failure"
            );

            assert.equal(wf.primary_media_id, null, "Detail mid-way failure must never change primary_media_id");
        });

        it("sheet failure mid-way leaves workflows.primary_media_id NOT pointing to a deleted media (restored to previous)", async () => {
            const wf = workflowsStore.find((w) => w.id === WORKFLOW_ID);

            // 1. Sheet upload: writes workflows.primary_media_id, workflow_media.is_primary is true
            const sheetRes = await service.uploadSheetMedia({
                characterId: CHARACTER_ID,
                file: { buffer: Buffer.from("sheet-bytes"), originalname: "sheet.png" },
                userId: USER_ID,
                projectId: PROJECT_ID,
            });
            assert.equal(wf.primary_media_id, sheetRes.media.id, "Sheet upload MUST write workflows.primary_media_id");
            const sheetLink = workflowMediaStore.find((wm) => wm.media_id === sheetRes.media.id);
            assert.equal(sheetLink.is_primary, true, "Sheet link must have is_primary: true");

            // 2. Mid-way failure rollback restores prior primary_media_id
            const establishedPrimary = sheetRes.media.id;
            mockDb.characters.updateCharacterFields = async () => {
                throw new Error("Post-attach character status failure");
            };

            await assert.rejects(
                () => service.uploadSheetMedia({
                    characterId: CHARACTER_ID,
                    file: { buffer: Buffer.from("failing-sheet"), originalname: "sheet2.png" },
                    userId: USER_ID,
                    projectId: PROJECT_ID,
                }),
                (err) => err.message === "Post-attach character status failure"
            );

            assert.equal(wf.primary_media_id, establishedPrimary, "Rollback must restore established primary_media_id and not leave it pointing to deleted media");
        });

        it("CharacterMediaService end-to-end integration with real WorkflowMediaService attaches uploaded and existing items with item.kind and setPrimary: true", async () => {
            const realMediaList = [];
            const realLinks = [];
            let wfPrimary = null;

            const realWfMediaSvc = new WorkflowMediaService({
                db: {
                    workflows: {
                        getWorkflow: async () => ({ id: WORKFLOW_ID, project_id: PROJECT_ID, user_id: USER_ID }),
                        findById: async () => ({ id: WORKFLOW_ID, project_id: PROJECT_ID, user_id: USER_ID, primary_media_id: wfPrimary }),
                        updatePrimaryMedia: async (wId, mId) => { wfPrimary = mId; },
                        updateFields: async (wId, f) => { if (f.primary_media_id !== undefined) wfPrimary = f.primary_media_id; },
                    },
                    workflowMedia: {
                        findByMedia: async (mId) => realLinks.filter((l) => l.media_id === mId),
                        findByWorkflow: async (wId) => realLinks.filter((l) => l.workflow_id === wId),
                        getPrimaryMedia: async () => realLinks.find((l) => l.is_primary) || null,
                        setPrimaryMedia: async ({ mediaId }) => {
                            realLinks.forEach((l) => { l.is_primary = (l.media_id === mediaId); });
                        },
                        attachReferenceMedia: async ({ workflowId, mediaId, role, is_primary = false }) => {
                            const link = { workflow_id: workflowId, media_id: mediaId, role, is_primary: Boolean(is_primary), is_existing: false };
                            realLinks.push(link);
                            return link;
                        },
                        unlink: async ({ workflowId, mediaId }) => {
                            const idx = realLinks.findIndex((l) => l.workflow_id === workflowId && l.media_id === mediaId);
                            if (idx !== -1) realLinks.splice(idx, 1);
                        },
                    },
                    media: {
                        createMedia: async (payload) => {
                            const rec = { id: `m-real-${realMediaList.length + 1}`, status: "completed", ...payload };
                            realMediaList.push(rec);
                            return rec;
                        },
                        findById: async (id) => realMediaList.find((m) => m.id === id) || null,
                        deleteById: async (id) => {
                            const idx = realMediaList.findIndex((m) => m.id === id);
                            if (idx !== -1) realMediaList.splice(idx, 1);
                        },
                    },
                },
                storageService: {
                    deleteByUrl: async () => {},
                },
                mediaUploadService: {
                    discard: async () => {},
                },
                authService: {
                    verifyWorkflowOwnership: async () => true,
                    verifyMediaOwnership: async () => true,
                },
            });

            const integrationService = new CharacterMediaService({
                db: {
                    workflows: {
                        getWorkflow: async () => ({ id: WORKFLOW_ID, project_id: PROJECT_ID, user_id: USER_ID }),
                        updatePrimaryMedia: async (wId, mId) => { wfPrimary = mId; },
                    },
                    workflowMedia: {
                        findByWorkflow: async () => realLinks.filter((l) => l.workflow_id === WORKFLOW_ID),
                    },
                    characters: {
                        updateCharacterFields: async () => {},
                    },
                    media: {
                        findById: async (id) => realMediaList.find((m) => m.id === id) || null,
                    },
                },
                storageService: {
                    deleteByUrl: async () => {},
                },
                mediaUploadService: mockUploadService,
                workflowMediaService: realWfMediaSvc,
                authService: mockAuthService,
            });

            // 1. Upload sheet via real WorkflowMediaService: verifies kind: 'uploaded' and setPrimary: true
            const sheetRes = await integrationService.uploadSheetMedia({
                characterId: WORKFLOW_ID,
                file: { buffer: Buffer.from("real-sheet"), originalname: "sheet.png" },
                userId: USER_ID,
                projectId: PROJECT_ID,
            });
            assert.ok(sheetRes.ok);
            assert.equal(wfPrimary, sheetRes.media.id);
            assert.equal(realLinks.find((l) => l.media_id === sheetRes.media.id)?.is_primary, true);

            // 2. Upload detail via real WorkflowMediaService: verifies kind: 'uploaded' and detail isolation
            const detailRes = await integrationService.uploadDetailMedia({
                characterId: WORKFLOW_ID,
                file: { buffer: Buffer.from("real-detail"), originalname: "detail.png" },
                userId: USER_ID,
                projectId: PROJECT_ID,
            });
            assert.ok(detailRes.ok);
            assert.equal(realLinks.find((l) => l.media_id === detailRes.media.id)?.role, "detail");
            assert.equal(realLinks.find((l) => l.media_id === detailRes.media.id)?.is_primary, false);
            assert.equal(wfPrimary, sheetRes.media.id, "Detail attach must not alter sheet primary cover");
        });
    });
});
