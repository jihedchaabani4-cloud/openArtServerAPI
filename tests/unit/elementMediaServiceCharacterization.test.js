process.env.NODE_ENV = "test";

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";
import { CrudServiceError } from "../../src/utils/crudOperationLog.js";

describe("ElementMediaService Characterization (Pre-migration baseline)", () => {
    let mockDb;
    let elementsStore;
    let workflowsStore;
    let mediaStore;
    let workflowMediaStore;
    let ingestionCalls;
    let service;

    const ELEMENT_ID = "00000000-0000-0000-0000-000000000001";
    const WORKFLOW_ID = "00000000-0000-0000-0000-000000000010";
    const PROJECT_ID = "00000000-0000-0000-0000-000000000100";
    const USER_ID = "user-elem-1";

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
        mediaStore = [];
        workflowMediaStore = [];
        ingestionCalls = [];

        mockDb = {
            elements: {
                resolveRecord: async (id) => elementsStore.find((e) => e.id === id || e.workflow_id === id) || null,
                findById: async (id) => elementsStore.find((e) => e.id === id) || null,
                update: async (id, fields) => {
                    const el = elementsStore.find((e) => e.id === id);
                    if (el) Object.assign(el, fields);
                    return el;
                },
            },
            workflows: {
                findById: async (id) => workflowsStore.find((w) => w.id === id) || null,
                getWorkflow: async (id) => workflowsStore.find((w) => w.id === id) || null,
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
            },
            workflowMedia: {
                findByWorkflow: async (wfId) => workflowMediaStore.filter((wm) => wm.workflow_id === wfId),
                findByMedia: async (mId) => workflowMediaStore.filter((wm) => wm.media_id === mId),
                getPrimaryMedia: async (wfId) => workflowMediaStore.find((wm) => wm.workflow_id === wfId && wm.is_primary === true) || null,
                setPrimaryMedia: async ({ workflowId, mediaId }) => {
                    for (const wm of workflowMediaStore) {
                        if (wm.workflow_id === workflowId) {
                            wm.is_primary = wm.media_id === mediaId;
                        }
                    }
                    return { workflow_id: workflowId, media_id: mediaId, is_primary: true };
                },
                clearPrimaryMedia: async ({ workflowId }) => {
                    for (const wm of workflowMediaStore) {
                        if (wm.workflow_id === workflowId) wm.is_primary = false;
                    }
                    return { cleared: true };
                },
                attachReferenceMedia: async ({ workflowId, mediaId, role = "detail", maxAllowed = 6 }) => {
                    const current = workflowMediaStore.filter((wm) => wm.workflow_id === workflowId && wm.role === role);
                    if (maxAllowed !== null && current.length >= maxAllowed) {
                        const err = new Error(`Maximum ${maxAllowed} reference images allowed per element`);
                        err.code = "23514";
                        err.errorCode = "LIMIT_EXCEEDED";
                        err.statusCode = 400;
                        throw err;
                    }
                    const hasPrimary = workflowMediaStore.some((wm) => wm.workflow_id === workflowId && wm.is_primary === true);
                    const is_primary = !hasPrimary;
                    const link = {
                        workflow_id: workflowId,
                        media_id: mediaId,
                        role,
                        is_primary,
                    };
                    workflowMediaStore.push(link);
                    return { ...link, current_count: current.length + 1, max_allowed: maxAllowed };
                },
                linkMedia: async (payload) => {
                    const link = {
                        workflow_id: payload.workflowId,
                        media_id: payload.mediaId,
                        role: payload.role || "detail",
                        step_id: payload.stepId || "upload",
                        is_primary: payload.isPrimary ?? payload.is_primary ?? false,
                    };
                    workflowMediaStore.push(link);
                    return link;
                },
            },
        };

        const mockUploadService = {
            upload: async ({ files, policy, maxFiles, userId, folder }) => {
                ingestionCalls.push({ files, policy, folder: policy?.storageFolder });
                const uploaded = files.map((f, idx) => {
                    const row = {
                        id: `media-upload-${mediaStore.length + 1}`,
                        url: `https://storage.test/${policy?.storageFolder || "uploads"}/img-${mediaStore.length + 1}.png`,
                        storageKey: `${userId}/${policy?.storageFolder || "uploads"}/img-${mediaStore.length + 1}.png`,
                        step_id: "upload",
                        width: 512,
                        height: 512,
                        format: "PNG",
                    };
                    mediaStore.push(row);
                    return row;
                });
                return { uploaded, files: uploaded };
            },
            discard: async () => {},
        };

        const mockWorkflowMediaService = {
            attachMediaItems: async ({ workflowId, projectId, userId, role = "detail", maxAllowed = 6, items = [], setPrimary = false, autoPrimary = true }) => {
                const currentCount = workflowMediaStore.filter((wm) => wm.workflow_id === workflowId && wm.role === role).length;
                if (maxAllowed !== null && currentCount + items.length > maxAllowed) {
                    throw new CrudServiceError(`Maximum ${maxAllowed} reference images allowed per element`, {
                        statusCode: 400,
                        errorCode: "LIMIT_EXCEEDED",
                    });
                }
                const attached = [];
                for (const item of items) {
                    let mediaRecord = null;
                    if (item.kind === "existing") {
                        mediaRecord = mediaStore.find((m) => m.id === item.mediaId);
                        if (!mediaRecord) {
                            throw new CrudServiceError("Media not found", { statusCode: 404, errorCode: "NOT_FOUND" });
                        }
                    } else {
                        mediaRecord = item.uploadedFile;
                    }
                    const isFirst = workflowMediaStore.filter((wm) => wm.workflow_id === workflowId).length === 0;
                    const isPrimary = setPrimary || (autoPrimary && isFirst);
                    if (isPrimary) {
                        for (const wm of workflowMediaStore) {
                            if (wm.workflow_id === workflowId) wm.is_primary = false;
                        }
                    }
                    const link = {
                        workflow_id: workflowId,
                        media_id: mediaRecord.id,
                        role,
                        step_id: "upload",
                        is_primary: isPrimary,
                    };
                    workflowMediaStore.push(link);
                    attached.push({
                        kind: item.kind,
                        media: mediaRecord,
                        link,
                        is_primary: isPrimary,
                    });
                }
                return { attached };
            },
        };

        const mockAuthService = {
            verifyWorkflowOwnership: async (wfId, uId) => {
                const wf = workflowsStore.find((w) => w.id === wfId);
                return Boolean(wf && wf.user_id === uId);
            },
        };

        const mockMediaIngestionService = {
            ingest: async ({ source, userId, projectId, workflowId, purpose, stepId, folder }) => {
                const targetFolder = folder || purpose || "element-references";
                ingestionCalls.push({ files: [source], folder: targetFolder, policy: { storageFolder: targetFolder } });
                const row = {
                    id: `media-upload-${mediaStore.length + 1}`,
                    url: `https://storage.test/${targetFolder}/img-${mediaStore.length + 1}.png`,
                    storageKey: `${userId}/${targetFolder}/img-${mediaStore.length + 1}.png`,
                    step_id: stepId || "upload",
                    width: 512,
                    height: 512,
                    format: "PNG",
                };
                mediaStore.push(row);
                return { media: row, url: row.url };
            },
        };

        service = new ElementMediaService({
            db: mockDb,
            storageService: {},
            mediaIngestionService: mockMediaIngestionService,
            workflowService: {},
            mediaUploadService: mockUploadService,
            workflowMediaService: mockWorkflowMediaService,
            authService: mockAuthService,
        });
    });

    it("1. addReferenceMedia (new file upload): uses folder element-references, creates media with step_id upload, workflow_media role detail and autoPrimary", async () => {
        const res = await service.addReferenceMedia({
            elementId: ELEMENT_ID,
            file: { buffer: Buffer.from("image1"), mimetype: "image/png" },
            userId: USER_ID,
            projectId: PROJECT_ID,
        });

        assert.equal(res.ok, true);
        assert.equal(ingestionCalls.length, 1);
        assert.equal(ingestionCalls[0].folder, "element-references");

        // Verify media row created
        assert.equal(mediaStore.length, 1);
        assert.equal(mediaStore[0].step_id, "upload");

        // Verify workflow_media link created
        assert.equal(workflowMediaStore.length, 1);
        assert.equal(workflowMediaStore[0].role, "detail");
        assert.equal(workflowMediaStore[0].is_primary, true, "First item becomes primary (auto-primary)");

        // Add 2nd reference image
        const res2 = await service.addReferenceMedia({
            elementId: ELEMENT_ID,
            file: { buffer: Buffer.from("image2"), mimetype: "image/png" },
            userId: USER_ID,
            projectId: PROJECT_ID,
        });
        assert.equal(res2.ok, true);
        assert.equal(workflowMediaStore.length, 2);
        assert.equal(workflowMediaStore[1].role, "detail");
        assert.equal(workflowMediaStore[1].is_primary, false, "Second item is not primary");
    });

    it("2. addReferenceMedia (existing mediaId): resolves existing media, links with role detail, does not call ingestion", async () => {
        const existingMedia = {
            id: "m-existing-100",
            status: "completed",
            url: "https://storage.test/existing.png",
            user_id: USER_ID,
            project_id: PROJECT_ID,
            step_id: "upload",
        };
        mediaStore.push(existingMedia);
        // Media is already linked to a prior workflow
        workflowMediaStore.push({
            workflow_id: "00000000-0000-0000-0000-000000000099",
            media_id: existingMedia.id,
            role: "output",
        });

        const res = await service.addReferenceMedia({
            elementId: ELEMENT_ID,
            mediaId: existingMedia.id,
            userId: USER_ID,
            projectId: PROJECT_ID,
        });

        assert.equal(res.ok, true);
        assert.equal(ingestionCalls.length, 0, "Ingestion must not be called for existing media");
        const elementLinks = workflowMediaStore.filter((wm) => wm.workflow_id === WORKFLOW_ID);
        assert.equal(elementLinks.length, 1);
        assert.equal(elementLinks[0].media_id, existingMedia.id);
        assert.equal(elementLinks[0].role, "detail");
        assert.equal(elementLinks[0].is_primary, true);
    });

    it("3. setSheetMedia (new file upload): uses folder element-sheets, step_id upload, role detail, updates workflows.primary_media_id", async () => {
        const res = await service.setSheetMedia({
            elementId: ELEMENT_ID,
            file: { buffer: Buffer.from("sheet-img"), mimetype: "image/png" },
            userId: USER_ID,
            projectId: PROJECT_ID,
        });

        assert.equal(res.ok, true);
        assert.equal(ingestionCalls.length, 1);
        assert.equal(ingestionCalls[0].folder, "element-sheets");

        // Media created
        assert.equal(mediaStore.length, 1);
        assert.ok(["upload", "element_sheet"].includes(mediaStore[0].step_id));

        // WorkflowMedia created
        assert.equal(workflowMediaStore.length, 1);
        assert.equal(workflowMediaStore[0].role, "detail");
        assert.equal(workflowMediaStore[0].is_primary, false);

        // workflows.primary_media_id updated
        const wf = workflowsStore.find((w) => w.id === WORKFLOW_ID);
        assert.equal(wf.primary_media_id, mediaStore[0].id);
    });

    it("4. ingestElementSources (@deprecated): uses folder element-sheets, links role detail, updates workflows.primary_media_id", async () => {
        const res = await service.ingestElementSources({
            workflowId: WORKFLOW_ID,
            sourceImages: ["https://example.com/img1.png", "https://example.com/img2.png"],
            projectId: PROJECT_ID,
            userId: USER_ID,
        });

        assert.equal(res.mediaRecords.length, 2);
        assert.equal(ingestionCalls.length, 1, "Batch upload executes in a single call");
        assert.equal(ingestionCalls[0].files.length, 2);
        assert.equal(ingestionCalls[0].folder, "element-sheets");

        // Role detail
        assert.equal(workflowMediaStore.length, 2);
        assert.equal(workflowMediaStore[0].role, "detail");
        assert.equal(workflowMediaStore[1].role, "detail");

        // workflows.primary_media_id set to first
        const wf = workflowsStore.find((w) => w.id === WORKFLOW_ID);
        assert.equal(wf.primary_media_id, res.primaryMedia.id);
    });

    it("5. Quota error: rejects 7th reference image with 400 LIMIT_EXCEEDED", async () => {
        // Pre-fill 6 items
        for (let i = 1; i <= 6; i++) {
            await service.addReferenceMedia({
                elementId: ELEMENT_ID,
                file: { buffer: Buffer.from(`img-${i}`), mimetype: "image/png" },
                userId: USER_ID,
                projectId: PROJECT_ID,
            });
        }
        assert.equal(workflowMediaStore.length, 6);

        await assert.rejects(
            () => service.addReferenceMedia({
                elementId: ELEMENT_ID,
                file: { buffer: Buffer.from("img-7"), mimetype: "image/png" },
                userId: USER_ID,
                projectId: PROJECT_ID,
            }),
            (err) => {
                assert.equal(err.statusCode, 400);
                assert.equal(err.errorCode, "LIMIT_EXCEEDED");
                assert.match(err.message, /Maximum 6 reference images allowed/i);
                return true;
            }
        );
    });
});
