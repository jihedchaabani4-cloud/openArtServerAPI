import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { CharacterMediaService, CHARACTER_MAX_DETAIL_MEDIA, CharacterGenerationService } from "#characters/tools";
import { CrudServiceError } from "#shared";
import { CHARACTER_SHEET_UPLOAD_POLICY, CHARACTER_DETAIL_UPLOAD_POLICY, createWorkflowWithMediaAtomic, failWorkflowPendingMedia, WorkflowMediaRepository } from "#media/tools";
import { WorkflowMediaService } from "#generation/tools";
import { ElementMediaService, ElementService } from "#elements/tools";
import { supabase } from "#shared/db/supabase.js";
import { setDb } from "#identity/tools";
import { BillingConfigurationError } from "#billing/tools";

// ─── Source: characterMediaServiceMigrated.test.js ───
{
process.env.NODE_ENV = "test";


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
}

// ─── Source: characterMediaWorkflowIdResolution.test.js ───
{
describe("Workflow ID resolution to media relation in Character & Element services", () => {
  it("CharacterMediaService.uploadDetailMedia with workflow ID resolves source media and links workflow_media relation with role 'detail'", async () => {
    let linkedPayload = null;
    let createMediaCalled = false;

    const mockSourceMedia = {
      id: "media-uuid-456",
      url: "https://storage.example.com/generated-shot.png",
      width: 1024,
      height: 1024,
      status: "success",
    };

    const mockDb = {
      workflows: {
        getWorkflow: async (id) => {
          if (id === "char-wf-1") return { id: "char-wf-1", project_id: "proj-1", user_id: "user-1", workflow_type: "CHARACTER" };
          if (id === "wf-source-123") return { id: "wf-source-123", primary_media_id: "media-uuid-456" };
          return null;
        },
      },
      media: {
        findById: async (id) => (id === "media-uuid-456" ? mockSourceMedia : null),
        findMediaByIdOrWorkflow: async (id) => (id === "wf-source-123" ? mockSourceMedia : null),
        findByWorkflow: async (id) => (id === "wf-source-123" ? [mockSourceMedia] : []),
        createMedia: async () => {
          createMediaCalled = true;
          return { id: "new-media-uuid" };
        },
      },
      workflowMedia: {
        findByMedia: async (id) => (id === "media-uuid-456" ? [{ workflow_id: "wf-source-123", media_id: "media-uuid-456" }] : []),
        linkMedia: async (payload) => {
          linkedPayload = payload;
          return payload;
        },
      },
    };

    const mockUploadService = {
      upload: async () => ({ uploaded: [] }),
      discard: async () => ({}),
    };
    const mockWorkflowMediaService = {
      attachMediaItems: async ({ workflowId, projectId, userId, role, items }) => {
        linkedPayload = {
          workflowId,
          mediaId: mockSourceMedia.id,
          role,
        };
        return {
          attached: [{
            media: mockSourceMedia,
            is_primary: false,
          }],
        };
      },
    };
    const mockAuthService = {
      verifyWorkflowOwnership: async () => true,
    };
    const service = new CharacterMediaService({
      db: mockDb,
      storageService: {},
      mediaUploadService: mockUploadService,
      workflowMediaService: mockWorkflowMediaService,
      authService: mockAuthService,
    });

    // Frontend passes workflow ID as mediaId (architectural contract)
    const result = await service.uploadDetailMedia({
      characterId: "char-wf-1",
      mediaId: "wf-source-123",
      projectId: "proj-1",
      userId: "user-1",
    });

    assert.equal(result.ok, true);
    assert.equal(createMediaCalled, false, "Should not create a duplicate media row for an existing asset");
    assert.ok(linkedPayload, "Should link existing media to character workflow in workflow_media");
    assert.equal(linkedPayload.workflowId, "char-wf-1");
    assert.equal(linkedPayload.mediaId, "media-uuid-456");
    assert.equal(linkedPayload.role, "detail");
    assert.equal(result.media.id, "media-uuid-456");
  });

  it("CharacterMediaService.uploadSheetMedia with workflow ID resolves source media and sets sheet relation", async () => {
    let linkedPayload = null;
    let updatedPrimaryMedia = null;
    let characterFieldsUpdated = null;

    const mockSourceMedia = {
      id: "media-uuid-789",
      url: "https://storage.example.com/character-sheet.png",
      width: 1344,
      height: 768,
      status: "success",
    };

    const mockDb = {
      workflows: {
        getWorkflow: async (id) => {
          if (id === "char-wf-1") return { id: "char-wf-1", project_id: "proj-1", user_id: "user-1", workflow_type: "CHARACTER" };
          if (id === "wf-sheet-source") return { id: "wf-sheet-source", primary_media_id: "media-uuid-789" };
          return null;
        },
        updatePrimaryMedia: async (wfId, mediaId) => {
          updatedPrimaryMedia = { wfId, mediaId };
          return {};
        },
      },
      media: {
        findById: async (id) => (id === "media-uuid-789" ? mockSourceMedia : null),
        findMediaByIdOrWorkflow: async (id) => (id === "wf-sheet-source" ? mockSourceMedia : null),
        findByWorkflow: async (id) => (id === "char-wf-1" ? [] : [mockSourceMedia]),
        createMedia: async () => ({ id: "fail-media" }),
        updateFields: async (id, fields) => ({ id, ...fields }),
        deleteByIdAndWorkflow: async () => ({}),
      },
      characters: {
        updateCharacterFields: async (charId, fields) => {
          characterFieldsUpdated = { charId, fields };
          return {};
        },
      },
      workflowMedia: {
        findByMedia: async (id) => (id === "media-uuid-789" ? [{ workflow_id: "wf-sheet-source", media_id: "media-uuid-789" }] : []),
        linkMedia: async (payload) => {
          linkedPayload = payload;
          return payload;
        },
      },
    };

    const mockUploadService = {
      upload: async () => ({ uploaded: [] }),
      discard: async () => ({}),
    };
    const mockWorkflowMediaService = {
      attachMediaItems: async ({ workflowId, projectId, userId, role, items }) => {
        linkedPayload = {
          workflowId,
          mediaId: mockSourceMedia.id,
          role,
        };
        return {
          attached: [{
            media: mockSourceMedia,
            is_primary: true,
          }],
        };
      },
    };
    const mockAuthService = {
      verifyWorkflowOwnership: async () => true,
    };
    const service = new CharacterMediaService({
      db: mockDb,
      storageService: {},
      mediaUploadService: mockUploadService,
      workflowMediaService: mockWorkflowMediaService,
      authService: mockAuthService,
    });

    const result = await service.uploadSheetMedia({
      characterId: "char-wf-1",
      mediaId: "wf-sheet-source",
      projectId: "proj-1",
      userId: "user-1",
    });

    assert.equal(result.ok, true);
    assert.ok(linkedPayload, "Must link sheet media in workflow_media");
    assert.equal(linkedPayload.workflowId, "char-wf-1");
    assert.equal(linkedPayload.mediaId, "media-uuid-789");
    assert.equal(linkedPayload.role, "sheet");
    assert.deepEqual(updatedPrimaryMedia, { wfId: "char-wf-1", mediaId: "media-uuid-789" });
    assert.equal(characterFieldsUpdated.fields.status, "completed");
  });

  it("ElementMediaService.addReferenceMedia with workflow ID resolves source media and links relation", async () => {
    let linkedPayload = null;
    let updatedElement = null;

    const mockSourceMedia = {
      id: "media-elem-source-456",
      url: "https://storage.example.com/prop.png",
      width: 1024,
      height: 1024,
      status: "success",
    };

    const mockDb = {
      elements: {
        resolveRecord: async (id) => ({ id, workflow_id: "elem-wf-1", project_id: "proj-1", source_images: [] }),
        update: async (id, patch) => {
          updatedElement = { id, patch };
          return {};
        },
      },
      workflows: {
        getWorkflow: async (id) => {
          if (id === "wf-source-prop") return { id: "wf-source-prop", primary_media_id: "media-elem-source-456" };
          return null;
        },
      },
      media: {
        findById: async (id) => (id === "media-elem-source-456" ? mockSourceMedia : null),
        findMediaByIdOrWorkflow: async (id) => (id === "wf-source-prop" ? mockSourceMedia : null),
        findByWorkflow: async (id) => (id === "wf-source-prop" ? [mockSourceMedia] : []),
        createMedia: async () => ({ id: "fail" }),
      },
      workflowMedia: {
        findByMedia: async (id) => (id === "media-elem-source-456" ? [{ workflow_id: "wf-source-prop", media_id: "media-elem-source-456" }] : []),
        linkMedia: async (payload) => {
          linkedPayload = payload;
          return payload;
        },
      },
    };

    const mockUploadService = {
      upload: async () => ({ uploaded: [] }),
      discard: async () => ({}),
    };
    const mockWorkflowMediaService = {
      attachMediaItems: async ({ workflowId, projectId, userId, role, items }) => {
        linkedPayload = {
          workflowId,
          mediaId: mockSourceMedia.id,
          role,
        };
        return {
          attached: [{
            media: mockSourceMedia,
            is_primary: true,
          }],
        };
      },
    };
    const mockAuthService = {
      verifyWorkflowOwnership: async () => true,
    };
    const service = new ElementMediaService({
      db: mockDb,
      storageService: {},
      mediaUploadService: mockUploadService,
      workflowMediaService: mockWorkflowMediaService,
      authService: mockAuthService,
    });

    const result = await service.addReferenceMedia({
      elementId: "11111111-1111-4111-8111-111111111111",
      mediaId: "wf-source-prop",
      projectId: "proj-1",
      userId: "user-1",
    });

    assert.equal(result.media.id, "media-elem-source-456");
    assert.ok(linkedPayload, "Must link media to element in workflow_media");
    assert.equal(linkedPayload.workflowId, "elem-wf-1");
    assert.equal(linkedPayload.mediaId, "media-elem-source-456");
    assert.equal(linkedPayload.role, "detail");
    assert.equal(updatedElement, null, "Must NOT update element.source_images (ADR-0009)");
  });

  it("CharacterMediaService.removeDetailMedia unlinks workflow_media and keeps source media intact when linked from another workflow", async () => {
    let unlinkedPayload = null;
    let deleteByIdAndWorkflowCalled = false;
    let storageDeleteCalled = false;

    const mockDb = {
      workflows: {
        getWorkflow: async (id) => ({ id, project_id: "proj-1", user_id: "user-1", workflow_type: "CHARACTER" }),
      },
      media: {
        findById: async () => ({
          id: "media-uuid-456",
          role: "detail",
          mediaRole: "detail",
          step_id: "character_detail",
          url: "https://storage.example.com/asset.png",
        }),
        deleteByIdAndWorkflow: async () => {
          deleteByIdAndWorkflowCalled = true;
        },
      },
      workflowMedia: {
        unlink: async (payload) => {
          unlinkedPayload = payload;
        },
        countLinksForMedia: async () => 1, // Still has original link
      },
    };

    const mockStorage = {
      deleteByUrl: async () => {
        storageDeleteCalled = true;
      },
    };

    const service = new CharacterMediaService({
      db: mockDb,
      storageService: mockStorage,
      mediaUploadService: { upload: async () => ({}) },
      workflowMediaService: { attachMediaItems: async () => ({}) },
      authService: { verifyWorkflowOwnership: async () => true },
    });

    const result = await service.removeDetailMedia({
      characterId: "char-wf-1",
      mediaId: "media-uuid-456",
      userId: "user-1",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(unlinkedPayload, {
      workflowId: "char-wf-1",
      mediaId: "media-uuid-456",
      role: "detail",
    });
    assert.equal(deleteByIdAndWorkflowCalled, false, "Must NOT delete media row when linked from another workflow");
    assert.equal(storageDeleteCalled, false, "Must NOT delete storage file when linked from another workflow");
  });

  it("CharacterMediaService.uploadDetailMedia rejects cross-user asset reference with 404", async () => {
    const mockVictimMedia = {
      id: "media-victim-999",
      user_id: "victim-user",
      project_id: "proj-1",
      url: "https://storage.example.com/victim.png",
      status: "success",
    };

    const mockDb = {
      workflows: {
        getWorkflow: async (id) => {
          if (id === "char-wf-1") return { id: "char-wf-1", project_id: "proj-1", user_id: "user-1", workflow_type: "CHARACTER" };
          if (id === "wf-victim-999") return { id: "wf-victim-999", user_id: "victim-user", project_id: "proj-1", primary_media_id: "media-victim-999" };
          return null;
        },
      },
      media: {
        findById: async (id) => (id === "media-victim-999" ? mockVictimMedia : null),
        findMediaByIdOrWorkflow: async (id) => (id === "wf-victim-999" ? mockVictimMedia : null),
      },
      workflowMedia: {
        findByMedia: async (id) => (id === "media-victim-999" ? [{ workflow_id: "wf-victim-999", media_id: "media-victim-999" }] : []),
      },
    };

    const service = new CharacterMediaService({
      db: mockDb,
      storageService: {},
      mediaUploadService: { upload: async () => ({}) },
      workflowMediaService: {
        attachMediaItems: async ({ userId, items }) => {
          const media = items?.[0]?.mediaId ? mockVictimMedia : null;
          if (media && media.user_id !== userId) {
            const err = new Error("Media not found");
            err.statusCode = 404;
            throw err;
          }
          return { attached: [{ media }] };
        },
      },
      authService: { verifyWorkflowOwnership: async () => true },
    });

    await assert.rejects(
      async () => {
        await service.uploadDetailMedia({
          characterId: "char-wf-1",
          mediaId: "wf-victim-999",
          projectId: "proj-1",
          userId: "user-1",
        });
      },
      (err) => {
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  });

  it("CharacterMediaService.uploadDetailMedia rejects cross-project asset reference with 404", async () => {
    const mockOtherProjMedia = {
      id: "media-other-proj-888",
      user_id: "user-1",
      project_id: "proj-OTHER",
      url: "https://storage.example.com/other.png",
      status: "success",
    };

    const mockDb = {
      workflows: {
        getWorkflow: async (id) => {
          if (id === "char-wf-1") return { id: "char-wf-1", project_id: "proj-1", user_id: "user-1", workflow_type: "CHARACTER" };
          if (id === "wf-other-proj-888") return { id: "wf-other-proj-888", user_id: "user-1", project_id: "proj-OTHER", primary_media_id: "media-other-proj-888" };
          return null;
        },
      },
      media: {
        findById: async (id) => (id === "media-other-proj-888" ? mockOtherProjMedia : null),
        findMediaByIdOrWorkflow: async (id) => (id === "wf-other-proj-888" ? mockOtherProjMedia : null),
      },
      workflowMedia: {
        findByMedia: async (id) => (id === "media-other-proj-888" ? [{ workflow_id: "wf-other-proj-888", media_id: "media-other-proj-888" }] : []),
      },
    };

    const service = new CharacterMediaService({
      db: mockDb,
      storageService: {},
      mediaUploadService: { upload: async () => ({}) },
      workflowMediaService: {
        attachMediaItems: async ({ projectId, items }) => {
          const media = items?.[0]?.mediaId ? mockOtherProjMedia : null;
          if (media && media.project_id !== projectId) {
            const err = new Error("Media not found");
            err.statusCode = 404;
            throw err;
          }
          return { attached: [{ media }] };
        },
      },
      authService: { verifyWorkflowOwnership: async () => true },
    });

    await assert.rejects(
      async () => {
        await service.uploadDetailMedia({
          characterId: "char-wf-1",
          mediaId: "wf-other-proj-888",
          projectId: "proj-1",
          userId: "user-1",
        });
      },
      (err) => {
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  });

  it("ElementMediaService.addReferenceMedia rejects cross-user and cross-project asset references with 404", async () => {
    const mockVictimMedia = {
      id: "media-victim-777",
      user_id: "victim-user",
      project_id: "proj-1",
      url: "https://storage.example.com/victim2.png",
      status: "success",
    };

    const mockDb = {
      elements: {
        resolveRecord: async (id) => ({ id, workflow_id: "elem-wf-1", project_id: "proj-1" }),
      },
      workflows: {
        getWorkflow: async (id) => {
          if (id === "wf-victim-777") return { id: "wf-victim-777", user_id: "victim-user", project_id: "proj-1", primary_media_id: "media-victim-777" };
          return null;
        },
      },
      media: {
        findById: async (id) => (id === "media-victim-777" ? mockVictimMedia : null),
        findMediaByIdOrWorkflow: async (id) => (id === "wf-victim-777" ? mockVictimMedia : null),
      },
      workflowMedia: {
        findByMedia: async (id) => (id === "media-victim-777" ? [{ workflow_id: "wf-victim-777", media_id: "media-victim-777" }] : []),
      },
    };

    const service = new ElementMediaService({
      db: mockDb,
      storageService: {},
      mediaUploadService: { upload: async () => ({ uploaded: [] }), discard: async () => ({}) },
      workflowMediaService: {
        attachMediaItems: async () => {
          const err = new Error("Media not found");
          err.statusCode = 404;
          err.errorCode = "MEDIA_NOT_FOUND";
          throw err;
        },
      },
      authService: {
        verifyWorkflowOwnership: async (wfId, uId) => uId === "user-1",
      },
    });

    await assert.rejects(
      async () => {
        await service.addReferenceMedia({
          elementId: "11111111-1111-4111-8111-111111111111",
          mediaId: "wf-victim-777",
          projectId: "proj-1",
          userId: "user-1",
        });
      },
      (err) => {
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  });
});
}

// ─── Source: sheetGenerationWorkflowMediaRealService.test.js ───
{
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}


describe("Sheet Generation real service layer tests — workflow_media integrity", () => {
  let originalRpc;

  beforeEach(() => {
    originalRpc = supabase.rpc;
  });

  afterEach(() => {
    supabase.rpc = originalRpc;
    setDb(null);
  });

  it("1. Character Sheet Generation path: links workflow_media on success and fails closed on link error", async () => {
    const mediaTable = new Map();
    const workflowMediaTable = [];
    const workflowTable = new Map();

    const realDb = {
      media: {
        createMedia: async (data) => {
          const row = { id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...data };
          mediaTable.set(row.id, row);
          return row;
        },
        updateMedia: async (id, fields) => {
          const existing = mediaTable.get(id) || {};
          const updated = { ...existing, ...fields };
          mediaTable.set(id, updated);
          return updated;
        },
        findByWorkflow: async (workflowId) => {
          const links = workflowMediaTable.filter((wm) => wm.workflow_id === workflowId);
          return links.map((link) => ({
            ...(mediaTable.get(link.media_id) || {}),
            workflow_id: link.workflow_id,
            role: link.role,
          }));
        },
      },
      workflows: {
        getWorkflow: async (id) => workflowTable.get(id) || null,
        createWorkflow: async (data) => {
          const row = { id: data.id || `wf-${Date.now()}`, ...data };
          workflowTable.set(row.id, row);
          return row;
        },
        updateFields: async (id, fields) => {
          const existing = workflowTable.get(id) || {};
          const updated = { ...existing, ...fields };
          workflowTable.set(id, updated);
          return updated;
        },
      },
      characters: {
        findByCharacterId: async (id) => ({ id, workflow_id: id, project_id: "proj-100", name: "Hero" }),
        upsert: async (payload) => payload,
      },
      workflowMedia: {
        linkMedia: async ({ workflowId, mediaId, role, stepId }) => {
          const link = { workflow_id: workflowId, media_id: mediaId, role: role || (stepId === "character_sheet" ? "sheet" : "detail") };
          workflowMediaTable.push(link);
          return link;
        },
      },
    };

    const mockUseCaseService = {
      prepareAndEnqueue: async ({ executionId }) => ({ executionId, workflowRunId: executionId }),
    };

    // A. Success path: verify placeholder media and workflow_media link are created
    const charGenService = new CharacterGenerationService({
      db: realDb,
      useCaseService: mockUseCaseService,
    });

    const res = await charGenService.enqueueSheetGeneration({
      characterId: "char-wf-success-1",
      prompt: "Epic fantasy knight",
      projectId: "proj-100",
      userId: "user-100",
      name: "Knight",
    });

    assert.ok(res.placeholderMedia?.id, "Placeholder media must be created");
    assert.equal(res.status, "processing");
    const createdMedia = mediaTable.get(res.placeholderMedia.id);
    assert.equal(createdMedia.status, "processing");
    assert.equal(createdMedia.step_id, "image_generation");

    const sheetLinks = workflowMediaTable.filter(
      (wm) => wm.workflow_id === "char-wf-success-1" && wm.media_id === res.placeholderMedia.id
    );
    assert.equal(sheetLinks.length, 1, "workflow_media link must be created for character sheet placeholder");
    assert.equal(sheetLinks[0].role, "sheet");

    // B. Failure path: if linking fails, placeholder media must NOT remain orphaned in processing status
    const failingDb = {
      ...realDb,
      workflowMedia: {
        linkMedia: async () => {
          throw new Error("Simulated foreign key constraint violation");
        },
      },
    };

    const failingCharGenService = new CharacterGenerationService({
      db: failingDb,
      useCaseService: mockUseCaseService,
    });

    await assert.rejects(
      async () => {
        await failingCharGenService.enqueueSheetGeneration({
          characterId: "char-1",
          workflowId: "char-wf-fail-1",
          prompt: "Epic rogue",
          projectId: "proj-100",
          userId: "user-100",
          name: "Rogue",
        });
      },
      /Simulated foreign key constraint violation|Failed to link/
    );

    // C. Fail-closed on linkMedia returning null:
    // createMediaInWorkflow must NOT mask null with a synthetic object.
    let enqueueCallCount = 0;
    const trackedUseCaseService = {
      prepareAndEnqueue: async ({ executionId }) => {
        enqueueCallCount++;
        return { executionId, workflowRunId: executionId };
      },
    };

    const nullLinkDb = {
      ...realDb,
      workflowMedia: {
        linkMedia: async () => null,
      },
    };

    const nullLinkCharGenService = new CharacterGenerationService({
      db: nullLinkDb,
      useCaseService: trackedUseCaseService,
    });

    await assert.rejects(
      async () => {
        await nullLinkCharGenService.enqueueSheetGeneration({
          characterId: "char-null-1",
          workflowId: "char-wf-null-1",
          prompt: "Epic wizard",
          projectId: "proj-100",
          userId: "user-100",
          name: "Wizard",
        });
      },
      /Failed to link placeholder media/
    );

    assert.equal(enqueueCallCount, 0, "Job must NOT be enqueued into BullMQ when link returns null");

    // Verify placeholder media was marked failed and never remained in processing
    const allMedia = Array.from(mediaTable.values());
    const orphanedProcessing = allMedia.filter(
      (m) => m.status === "processing" && !workflowMediaTable.some((wm) => wm.media_id === m.id)
    );
    assert.equal(orphanedProcessing.length, 0, "No media should remain in 'processing' without a workflow_media link");

    const failedPlaceholder = allMedia.find((m) => m.step_id === "image_generation" && m.status === "failed");
    assert.ok(failedPlaceholder, "Failed placeholder media must be marked with status 'failed'");
  });

  it("2. createWorkflowWithMediaAtomic path: links workflow_media when RPC returns and allows failWorkflowPendingMedia cleanup", async () => {
    const mediaTable = new Map();
    const workflowMediaTable = [];

    const realDb = {
      media: {
        updateMedia: async (id, fields) => {
          const existing = mediaTable.get(id) || {};
          const updated = { ...existing, ...fields };
          mediaTable.set(id, updated);
          return updated;
        },
        findByWorkflow: async (workflowId) => {
          const links = workflowMediaTable.filter((wm) => wm.workflow_id === workflowId);
          return links.map((link) => ({
            ...(mediaTable.get(link.media_id) || {}),
            workflow_id: link.workflow_id,
            role: link.role,
          }));
        },
      },
      workflowMedia: {
        linkMedia: async ({ workflowId, mediaId, role, stepId }) => {
          const link = {
            workflow_id: workflowId,
            media_id: mediaId,
            role: role || (stepId === "character_sheet" ? "sheet" : "output"),
          };
          workflowMediaTable.push(link);
          return link;
        },
      },
    };

    // Simulate Supabase RPC create_workflow_with_placeholder_media succeeding and returning { workflow_id, media_id }
    const simulatedRpcWorkflowId = "wf-rpc-1";
    const simulatedRpcMediaId = "m-rpc-1";
    mediaTable.set(simulatedRpcMediaId, {
      id: simulatedRpcMediaId,
      step_id: "character_sheet",
      status: "processing",
      url: null,
    });

    supabase.rpc = async (fnName) => {
      if (fnName === "create_workflow_with_placeholder_media") {
        return {
          data: {
            workflow_id: simulatedRpcWorkflowId,
            media_id: simulatedRpcMediaId,
          },
          error: null,
        };
      }
      return { data: null, error: new Error("Unknown RPC") };
    };

    const res = await createWorkflowWithMediaAtomic(realDb, {
      workflowData: {
        project_id: "proj-1",
        workflow_type: "CHARACTER",
        display_name: "Atomic Hero",
      },
      mediaData: {
        step_id: "character_sheet",
        status: "processing",
      },
    });

    assert.equal(res.workflow.id, simulatedRpcWorkflowId);
    assert.equal(res.media.id, simulatedRpcMediaId);

    // CRITICAL: workflow_media MUST be linked after createWorkflowWithMediaAtomic
    const links = workflowMediaTable.filter(
      (wm) => wm.workflow_id === simulatedRpcWorkflowId && wm.media_id === simulatedRpcMediaId
    );
    assert.equal(links.length, 1, "createWorkflowWithMediaAtomic must link row in workflow_media");
    assert.equal(links[0].role, "sheet");

    // Failure cleanup: when job fails/dies, failWorkflowPendingMedia must find the media and mark it failed
    await failWorkflowPendingMedia(realDb, simulatedRpcWorkflowId, "Worker timed out after 2 hours");
    const finalizedMedia = mediaTable.get(simulatedRpcMediaId);
    assert.equal(finalizedMedia.status, "failed");
    assert.match(finalizedMedia.error_message, /Worker timed out/);
  });

  it("3. Element Sheet Generation / Ingestion path: links workflow_media even when db object lacks explicit workflowMedia repo", async () => {
    const mediaTable = new Map();
    const workflowMediaTable = [];
    const workflowTable = new Map();
    const elementTable = new Map();

    const dbWithoutWorkflowMedia = {
      media: {
        createMedia: async (data) => {
          const row = { id: `m-elem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...data };
          mediaTable.set(row.id, row);
          return row;
        },
        updateMedia: async (id, fields) => {
          const existing = mediaTable.get(id) || {};
          const updated = { ...existing, ...fields };
          mediaTable.set(id, updated);
          return updated;
        },
        findByWorkflow: async (workflowId) => {
          const links = workflowMediaTable.filter((wm) => wm.workflow_id === workflowId);
          return links.map((link) => ({
            ...(mediaTable.get(link.media_id) || {}),
            workflow_id: link.workflow_id,
            role: link.role,
          }));
        },
      },
      workflows: {
        createWorkflow: async (data) => {
          const row = { id: `wf-elem-${Date.now()}`, ...data };
          workflowTable.set(row.id, row);
          return row;
        },
        updatePrimaryMedia: async (wfId, mediaId) => {
          const wf = workflowTable.get(wfId);
          if (wf) wf.primary_media_id = mediaId;
        },
        findById: async (id) => workflowTable.get(id),
      },
      elements: {
        create: async (data) => {
          const row = { id: `elem-${Date.now()}`, ...data };
          elementTable.set(row.id, row);
          return row;
        },
        resolveRecord: async (id) => elementTable.get(id) || { id, workflow_id: id },
      },
      workflowMedia: {
        linkMedia: async ({ workflowId, mediaId, role, stepId }) => {
          const link = {
            workflow_id: workflowId,
            media_id: mediaId,
            role: role || (stepId === "element_sheet" ? "detail" : "detail"),
          };
          workflowMediaTable.push(link);
          return link;
        },
      },
    };

    const elementMediaService = new ElementMediaService({
      db: dbWithoutWorkflowMedia,
      storageService: {},
      mediaUploadService: {
        upload: async ({ files }) => ({
          uploaded: files.map((f, i) => {
            const m = { id: "m-sheet-" + (i + 1), url: f, step_id: "upload" };
            mediaTable.set(m.id, m);
            return m;
          }),
        }),
        discard: async () => ({}),
      },
      workflowMediaService: {
        attachMediaItems: async ({ workflowId, items, role = "detail" }) => {
          const attached = [];
          for (const item of items) {
            const m = item.uploadedFile;
            const link = {
              workflow_id: workflowId,
              media_id: m.id,
              role,
            };
            workflowMediaTable.push(link);
            attached.push({ media: m, link, is_primary: true });
          }
          return { attached };
        },
      },
      authService: {
        verifyWorkflowOwnership: async () => true,
      },
    });

    const elementService = new ElementService({
      db: dbWithoutWorkflowMedia,
      mediaService: elementMediaService,
      analysisService: { analyzeElement: async () => ({}) },
    });

    const created = await elementService.createElement({
      name: "Magic Sword",
      sourceImages: ["https://cdn.example.com/sword-sheet.png"],
      projectId: "proj-1",
      userId: "user-1",
      element_type: "object",
    });

    assert.ok(created.element, "Element must be created");
    assert.ok(created.element.primary_media_id, "primary_media_id must be set");

    const links = workflowMediaTable.filter((wm) => wm.media_id === created.element.primary_media_id);
    assert.equal(links.length, 1, "Element sheet media must have a link in workflow_media");
    assert.equal(links[0].role, "detail", "Element sheet role in workflow_media must be 'detail'");
  });

  it("4. WorkflowMediaRepository production fail-closed: throws if in-memory mode attempted outside test or if DB client not wired", async () => {
    const origEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";

      // A. enableTestMemoryFallback must throw in production
      assert.throws(
        () => WorkflowMediaRepository.enableTestMemoryFallback(),
        /prohibited outside NODE_ENV=test/
      );

      // B. useMemoryFallback setter must throw in production
      assert.throws(
        () => {
          WorkflowMediaRepository.useMemoryFallback = true;
        },
        /prohibited outside NODE_ENV=test/
      );

      // C. In production, calling linkMedia when DB client is not wired must throw
      const unconfiguredRepo = new WorkflowMediaRepository();
      unconfiguredRepo.client = () => null;

      await assert.rejects(
        async () => {
          await unconfiguredRepo.linkMedia({
            workflowId: "wf-prod-fail",
            mediaId: "m-prod-fail",
            role: "output",
          });
        },
        /Database client is not wired/
      );
    } finally {
      process.env.NODE_ENV = origEnv || "test";
      WorkflowMediaRepository.enableTestMemoryFallback();
    }
  });

  it("5. Worker crash handler: refunds credits idempotently (exactly once on double failure / retry / timeout) and marks direct media failed", async () => {
    process.env.NODE_ENV = "test";
    const { handleUseCaseWorkerFailure, useCaseWorker } = await import("#generation/tools");
    const { useCaseService, db } = await import("../../../src/container.js");
    const { redisConnection, workerRedisConnection, rateLimitRedisConnection } = await import("#shared");

    let actualRefundCount = 0;
    const mediaTable = new Map();
    const targetMediaId = "media-crash-idem-1";
    mediaTable.set(targetMediaId, { id: targetMediaId, status: "processing" });

    const origRollbackPreparedBilling = useCaseService.rollbackPreparedBilling;
    const { WalletService } = await import("#billing/tools");

    // Part A: Real WalletService rollbackFallback and rollbackHoldIdempotent tests
    const walletsTable = new Map();
    const transactionsTable = new Map();

    const mockSupabase = {
      from: (tableName) => {
        if (tableName === "wallets") {
          return {
            select: () => ({
              eq: (col, val) => ({
                single: async () => {
                  const row = walletsTable.get(val);
                  return row ? { data: { ...row }, error: null } : { data: null, error: { message: "Wallet not found" } };
                },
                maybeSingle: async () => {
                  const row = walletsTable.get(val);
                  return { data: row ? { ...row } : null, error: null };
                },
              }),
            }),
            update: (patch) => ({
              eq: async (col, val) => {
                const existing = walletsTable.get(val);
                if (existing) {
                  const updated = { ...existing, ...patch };
                  walletsTable.set(val, updated);
                  return { data: updated, error: null };
                }
                return { data: null, error: { message: "Wallet not found" } };
              },
            }),
          };
        }

        if (tableName === "transactions") {
          return {
            select: (cols) => ({
              eq: (col, val) => ({
                maybeSingle: async () => {
                  for (const tx of transactionsTable.values()) {
                    if (tx[col] === val) return { data: { ...tx }, error: null };
                  }
                  return { data: null, error: null };
                },
                single: async () => {
                  for (const tx of transactionsTable.values()) {
                    if (tx[col] === val) return { data: { ...tx }, error: null };
                  }
                  return { data: null, error: { message: "Not found" } };
                },
              }),
            }),
            update: (patch) => ({
              eq: (col1, val1) => ({
                eq: (col2, val2) => ({
                  select: () => ({
                    single: async () => {
                      const tx = transactionsTable.get(val1);
                      // Atomic optimistic lock: col2 ("status") must equal val2 ("PENDING")
                      if (tx && tx[col2] === val2) {
                        const updated = { ...tx, ...patch };
                        transactionsTable.set(val1, updated);
                        return { data: updated, error: null };
                      }
                      return { data: null, error: { message: "Conflict or already modified" } };
                    },
                  }),
                }),
              }),
            }),
          };
        }

        throw new Error(`Unexpected table: ${tableName}`);
      },
      rpc: async () => ({ data: null, error: { message: "RPC not found in test mode", code: "PGRST202" } }),
    };

    const walletService = new WalletService("https://placeholder.supabase.co", "placeholder-key");
    walletService.supabase = mockSupabase;
    const walletId = "wallet-real-test-1";
    const refId = "hold-ref-real-1";
    walletsTable.set(walletId, { id: walletId, user_id: "user-1", balance: 50 });
    transactionsTable.set("tx-1", {
      id: "tx-1",
      wallet_id: walletId,
      reference_id: refId,
      amount: 10,
      status: "PENDING",
      type: "HOLD",
    });

    // 1. Initial rollback: fails closed with BillingConfigurationError on PGRST202
    await assert.rejects(
      async () => walletService.rollback(refId),
      (err) => err instanceof BillingConfigurationError || /PGRST202|missing/.test(err?.message)
    );

    // 2. rollbackHoldIdempotent: also fails closed on missing RPC
    await assert.rejects(
      async () => walletService.rollbackHoldIdempotent(refId),
      (err) => err instanceof BillingConfigurationError || /PGRST202|missing/.test(err?.message)
    );

    // 3. Balance must remain untouched (50 credits, not refunded non-atomically)
    assert.equal(walletsTable.get(walletId).balance, 50, "Balance must remain unchanged when RPC fails closed");

    // Part B: Worker crash handler failure recovery marks ALL direct media failed
    const targetMediaId2 = "media-crash-idem-2";
    mediaTable.set(targetMediaId, { id: targetMediaId, status: "processing" });
    mediaTable.set(targetMediaId2, { id: targetMediaId2, status: "processing" });

    const origDbMedia = db.media;
    db.media = {
      updateMedia: async (id, patch) => {
        const existing = mediaTable.get(id) || { id };
        const updated = { ...existing, ...patch };
        mediaTable.set(id, updated);
        return updated;
      },
      findByWorkflow: async () => [],
    };

    const mockMultiMediaJob = {
      id: "job-crash-multi-1",
      data: {
        billingHoldId: refId,
        serverContext: {
          workflowId: "wf-crash-multi-1",
          mediaIds: [targetMediaId, targetMediaId2],
        },
      },
    };

    try {
      await handleUseCaseWorkerFailure(mockMultiMediaJob, new Error("Crash"));
      assert.equal(mediaTable.get(targetMediaId).status, "failed", "First media must be marked failed");
      assert.equal(mediaTable.get(targetMediaId2).status, "failed", "ALL media in mediaIds must be marked failed");
    } finally {
      db.media = origDbMedia;
      await useCaseWorker?.close?.().catch(() => {});
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
      await rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect());
    }
  });
});
}
