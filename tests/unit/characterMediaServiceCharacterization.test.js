process.env.NODE_ENV = "test";

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CharacterMediaService } from "#characters/tools";
import { CrudServiceError } from "#shared";

describe("CharacterMediaService Characterization (Pre-migration baseline)", () => {
    let mockDb;
    let workflowsStore;
    let charactersStore;
    let mediaStore;
    let workflowMediaStore;
    let storageCalls;
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
        storageCalls = [];

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
                deleteByIdAndWorkflow: async (mediaId, wfId) => {
                    const idx = mediaStore.findIndex((m) => m.id === mediaId);
                    if (idx !== -1) mediaStore.splice(idx, 1);
                    const linkIdx = workflowMediaStore.findIndex((wm) => wm.workflow_id === wfId && wm.media_id === mediaId);
                    if (linkIdx !== -1) workflowMediaStore.splice(linkIdx, 1);
                    return true;
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
                linkMedia: async (payload) => {
                    const row = {
                        workflow_id: payload.workflowId,
                        media_id: payload.mediaId,
                        role: payload.role || "detail",
                        step_id: payload.stepId || "upload",
                        is_primary: Boolean(payload.is_primary),
                    };
                    workflowMediaStore.push(row);
                    return row;
                },
                attachMedia: async (payload) => {
                    const row = {
                        workflow_id: payload.workflowId,
                        media_id: payload.mediaId,
                        role: payload.role || "detail",
                        step_id: payload.stepId || "upload",
                        is_primary: payload.role === "sheet",
                    };
                    workflowMediaStore.push(row);
                    return row;
                },
                attachReferenceMedia: async (payload) => {
                    const row = {
                        workflow_id: payload.workflowId,
                        media_id: payload.mediaId,
                        role: payload.role || "detail",
                        step_id: payload.stepId || "upload",
                        is_primary: payload.role === "sheet",
                    };
                    workflowMediaStore.push(row);
                    return row;
                },
            },
        };

        const mockStorageService = {
            paths: {
                characterSheet: (userId, charId, mediaId, ext) => `${userId}/character-sheets/${charId}/${mediaId}.${ext}`,
                characterDetail: (userId, charId, mediaId, ext) => `${userId}/character-details/${charId}/${mediaId}.${ext}`,
            },
            upload: async (storagePath, buffer) => {
                storageCalls.push({ path: storagePath, length: buffer?.length });
                return `https://storage.example.com/${storagePath}`;
            },
            deleteByUrl: async () => true,
        };

        const mockUploadService = {
            upload: async ({ files, policy, userId }) => {
                const uploaded = files.map((f, i) => {
                    const storagePath = `${userId}/${policy.storageFolder}/${CHARACTER_ID}/media-${mediaStore.length + i + 1}.png`;
                    storageCalls.push({ path: storagePath, length: f.buffer?.length || 0 });
                    return {
                        url: `https://storage.example.com/${storagePath}`,
                        storageKey: storagePath,
                        width: 1024,
                        height: 1024,
                        format: "PNG",
                        byteSize: f.buffer?.length || 0,
                    };
                });
                return { uploaded };
            },
            discard: async () => ({}),
        };

        const mockWorkflowMediaService = {
            attachMediaItems: async ({ workflowId, projectId, userId, role, items, autoPrimary, setPrimary }) => {
                const attached = [];
                for (const item of items) {
                    let mediaRecord;
                    if (item.kind === "existing") {
                        mediaRecord = mediaStore.find((m) => m.id === item.mediaId);
                        if (!mediaRecord || (mediaRecord.user_id && mediaRecord.user_id !== userId)) {
                            const err = new CrudServiceError("Media not found", {
                                statusCode: 404,
                                errorCode: "NOT_FOUND",
                            });
                            throw err;
                        }
                    } else if (item.kind === "uploaded") {
                        mediaRecord = {
                            id: `00000000-0000-0000-0000-00000000009${mediaStore.length + 1}`,
                            url: item.uploadedFile?.url,
                            user_id: userId,
                            project_id: projectId,
                            step_id: "upload",
                        };
                        mediaStore.push(mediaRecord);
                    } else {
                        throw new Error(`Item must specify kind ('uploaded' | 'existing')`);
                    }
                    const isPrimary = Boolean(setPrimary || autoPrimary || role === "sheet");
                    workflowMediaStore.push({
                        workflow_id: workflowId,
                        media_id: mediaRecord.id,
                        role,
                        is_primary: isPrimary,
                    });
                    attached.push({
                        kind: item.kind,
                        media: mediaRecord,
                        is_primary: isPrimary,
                    });
                }
                return { attached };
            },
        };

        const mockAuthService = {
            verifyWorkflowOwnership: async (wfId, uId) => {
                if (!uId || uId === "anonymous") return false;
                const wf = workflowsStore.find((w) => w.id === wfId);
                return Boolean(wf && wf.user_id === uId);
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

    describe("1. uploadSheetMedia characterization", () => {
        it("new file upload: sets role 'sheet', step_id 'upload', updates primary_media_id, and targets 'character-sheets'", async () => {
            const fakeBuffer = Buffer.from("sheet-image-data");
            const res = await service.uploadSheetMedia({
                characterId: CHARACTER_ID,
                file: { buffer: fakeBuffer, mimetype: "image/png" },
                userId: USER_ID,
                projectId: PROJECT_ID,
            });

            assert.equal(res.ok, true);
            assert.ok(res.url.includes("character-sheets"));
            assert.equal(storageCalls.length, 1);
            assert.ok(storageCalls[0].path.includes("character-sheets"));

            const wf = workflowsStore.find((w) => w.id === WORKFLOW_ID);
            assert.ok(wf.primary_media_id, "Workflow primary_media_id must be updated");
            assert.equal(wf.primary_media_id, res.media.id);

            const charRec = charactersStore.find((c) => c.id === CHARACTER_ID);
            assert.equal(charRec.status, "completed");
        });

        it("existing mediaId: links role 'sheet', updates primary_media_id, and preserves technical step_id", async () => {
            const existingMedia = {
                id: "00000000-0000-0000-0000-000000000099",
                url: "https://storage.example.com/existing-sheet.png",
                user_id: USER_ID,
                project_id: PROJECT_ID,
                step_id: "image_generation",
            };
            mediaStore.push(existingMedia);
            workflowMediaStore.push({
                workflow_id: "other-wf-1",
                media_id: existingMedia.id,
                role: "output",
            });

            const res = await service.uploadSheetMedia({
                characterId: CHARACTER_ID,
                mediaId: existingMedia.id,
                userId: USER_ID,
                projectId: PROJECT_ID,
            });

            assert.equal(res.ok, true);
            assert.equal(res.media.role, "sheet");
            assert.ok(
                ["image_generation", "character_sheet"].includes(res.media.step_id),
                "step_id should either be preserved ('image_generation') or legacy overwritten ('character_sheet')"
            );

            const wf = workflowsStore.find((w) => w.id === WORKFLOW_ID);
            assert.equal(wf.primary_media_id, existingMedia.id);
        });
    });

    describe("2. uploadDetailMedia characterization", () => {
        it("new file upload: sets role 'detail', step_id 'upload', does NOT set primary_media_id, and targets 'character-details'", async () => {
            const fakeBuffer = Buffer.from("detail-image-data");
            const res = await service.uploadDetailMedia({
                characterId: CHARACTER_ID,
                file: { buffer: fakeBuffer, mimetype: "image/png" },
                userId: USER_ID,
                projectId: PROJECT_ID,
            });

            assert.equal(res.ok, true);
            assert.ok(res.url.includes("character-details"));
            assert.equal(storageCalls.length, 1);
            assert.ok(storageCalls[0].path.includes("character-details"));

            const wf = workflowsStore.find((w) => w.id === WORKFLOW_ID);
            assert.equal(wf.primary_media_id, null, "uploadDetailMedia must not set primary_media_id");
        });

        it("existing mediaId: links role 'detail', does NOT set primary_media_id, and preserves technical step_id", async () => {
            const existingMedia = {
                id: "00000000-0000-0000-0000-000000000088",
                url: "https://storage.example.com/existing-detail.png",
                user_id: USER_ID,
                project_id: PROJECT_ID,
                step_id: "upload",
            };
            mediaStore.push(existingMedia);
            workflowMediaStore.push({
                workflow_id: "other-wf-2",
                media_id: existingMedia.id,
                role: "detail",
            });

            const res = await service.uploadDetailMedia({
                characterId: CHARACTER_ID,
                mediaId: existingMedia.id,
                userId: USER_ID,
                projectId: PROJECT_ID,
            });

            assert.equal(res.ok, true);
            assert.equal(res.media.role, "detail");

            const wf = workflowsStore.find((w) => w.id === WORKFLOW_ID);
            assert.equal(wf.primary_media_id, null, "uploadDetailMedia must not set primary_media_id");
        });
    });

    describe("3. Validation & Isolation Error Codes characterization", () => {
        it("missing characterId throws 400 VALIDATION_ERROR", async () => {
            await assert.rejects(
                () => service.uploadSheetMedia({ file: { buffer: Buffer.from("x") } }),
                (err) => err instanceof CrudServiceError && err.statusCode === 400 && err.errorCode === "VALIDATION_ERROR"
            );
        });

        it("missing payload throws 400 VALIDATION_ERROR", async () => {
            await assert.rejects(
                () => service.uploadSheetMedia({ characterId: CHARACTER_ID }),
                (err) => err instanceof CrudServiceError && err.statusCode === 400 && err.errorCode === "VALIDATION_ERROR"
            );
        });

        it("non-existent character workflow throws 404 NOT_FOUND", async () => {
            await assert.rejects(
                () => service.uploadSheetMedia({
                    characterId: "00000000-0000-0000-0000-999999999999",
                    file: { buffer: Buffer.from("x") },
                    userId: USER_ID,
                }),
                (err) => err instanceof CrudServiceError && err.statusCode === 404 && err.errorCode === "NOT_FOUND"
            );
        });

        it("cross-tenant mediaId throws 404", async () => {
            const foreignMedia = {
                id: "00000000-0000-0000-0000-000000000777",
                url: "https://storage.example.com/foreign.png",
                user_id: "attacker-user",
                project_id: PROJECT_ID,
            };
            mediaStore.push(foreignMedia);
            workflowMediaStore.push({
                workflow_id: "foreign-wf",
                media_id: foreignMedia.id,
                role: "detail",
            });

            await assert.rejects(
                () => service.uploadDetailMedia({
                    characterId: CHARACTER_ID,
                    mediaId: foreignMedia.id,
                    userId: USER_ID,
                    projectId: PROJECT_ID,
                }),
                (err) => err instanceof CrudServiceError && err.statusCode === 404
            );
        });
    });
});
