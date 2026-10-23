process.env.NODE_ENV = "test";

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkflowMediaService } from "../../src/platform/workflow/WorkflowMediaService.js";
import {
    QuotaError,
    ValidationError,
    UploadError,
    formatWorkflowReferenceQuotaMessage,
    isWorkflowReferenceQuotaError,
} from "../../src/platform/media-ingestion/MediaUploadErrors.js";
import { CrudServiceError } from "../../src/utils/crudOperationLog.js";
import { baseLogger } from "../../src/infrastructure/logging/index.js";
import { WorkflowMediaRepository } from "../../src/db/WorkflowMediaRepository.js";

function createMockHarness() {
    const workflows = new Map();
    const media = new Map();
    const workflowMedia = [];
    const storageFiles = new Set();
    const callLog = [];

    const db = {
        workflows: {
            findById: async (id, fields = "*") => {
                callLog.push({ op: "workflows.findById", id });
                const wf = workflows.get(id);
                return wf ? { ...wf } : null;
            },
            getWorkflow: async (id) => {
                callLog.push({ op: "workflows.getWorkflow", id });
                const wf = workflows.get(id);
                return wf ? { ...wf } : null;
            },
            updatePrimaryMedia: async (workflowId, primaryMediaId) => {
                callLog.push({ op: "workflows.updatePrimaryMedia", workflowId, primaryMediaId });
                const wf = workflows.get(workflowId);
                if (wf) {
                    wf.primary_media_id = primaryMediaId;
                }
                return { id: workflowId, primary_media_id: primaryMediaId };
            },
            conditionalRestorePrimaryMedia: async ({ workflowId, expectedPrimaryMediaId, restorePrimaryMediaId }) => {
                callLog.push({ op: "workflows.conditionalRestorePrimaryMedia", workflowId, expectedPrimaryMediaId, restorePrimaryMediaId });
                const wf = workflows.get(workflowId);
                if (wf && wf.primary_media_id === expectedPrimaryMediaId) {
                    wf.primary_media_id = restorePrimaryMediaId || null;
                    return { workflowId, updated: true, primary_media_id: wf.primary_media_id };
                }
                return { workflowId, updated: false, primary_media_id: wf?.primary_media_id || null };
            },
            updateFields: async (workflowId, fields) => {
                callLog.push({ op: "workflows.updateFields", workflowId, fields });
                const wf = workflows.get(workflowId);
                if (wf) {
                    Object.assign(wf, fields);
                }
                return { id: workflowId, ...(wf || {}) };
            },
            createWorkflow: async (fields) => {
                const id = fields.id || randomUUID();
                const record = { id, ...fields };
                workflows.set(id, record);
                callLog.push({ op: "workflows.createWorkflow", id });
                return record;
            },
            deleteById: async (id) => {
                callLog.push({ op: "workflows.deleteById", id });
                workflows.delete(id);
                return true;
            },
        },
        media: {
            findById: async (id) => {
                callLog.push({ op: "media.findById", id });
                const m = media.get(id);
                return m ? { ...m } : null;
            },
            createMedia: async (fields) => {
                const id = fields.id || randomUUID();
                const record = { id, ...fields };
                media.set(id, record);
                callLog.push({ op: "media.createMedia", id, url: fields.url });
                return record;
            },
            deleteById: async (id) => {
                callLog.push({ op: "media.deleteById", id });
                media.delete(id);
                return true;
            },
        },
        workflowMedia: {
            findByWorkflow: async (workflowId) => {
                return workflowMedia.filter((wm) => wm.workflow_id === workflowId);
            },
            findByMedia: async (mediaId) => {
                return workflowMedia.filter((wm) => wm.media_id === mediaId);
            },
            getPrimaryMedia: async (workflowId) => {
                return workflowMedia.find((wm) => wm.workflow_id === workflowId && wm.is_primary === true) || null;
            },
            attachReferenceMedia: async ({ workflowId, mediaId, role = "detail", maxAllowed = 6, autoPrimary = true }) => {
                callLog.push({ op: "workflowMedia.attachReferenceMedia", workflowId, mediaId, role, maxAllowed, autoPrimary });
                const currentRelations = workflowMedia.filter(
                    (wm) => wm.workflow_id === workflowId && wm.role === role
                );
                const existing = currentRelations.find((wm) => wm.media_id === mediaId);
                if (existing) {
                    return {
                        workflow_id: workflowId,
                        media_id: mediaId,
                        role,
                        is_primary: Boolean(existing.is_primary),
                        current_count: currentRelations.length,
                        max_allowed: maxAllowed,
                        is_existing: true,
                    };
                }

                if (maxAllowed !== null && maxAllowed !== undefined && currentRelations.length >= maxAllowed) {
                    const err = new Error(formatWorkflowReferenceQuotaMessage(maxAllowed, currentRelations.length));
                    err.code = "23514";
                    err.statusCode = 400;
                    throw err;
                }

                const autoPrimaryEffective = autoPrimary === undefined || autoPrimary === null ? true : Boolean(autoPrimary);
                let is_primary = false;
                if (autoPrimaryEffective) {
                    const hasPrimary = workflowMedia.some((wm) => wm.workflow_id === workflowId && wm.is_primary === true);
                    is_primary = !hasPrimary;
                }
                if (is_primary) {
                    const wf = workflows.get(workflowId);
                    if (wf && !wf.primary_media_id) {
                        wf.primary_media_id = mediaId;
                    }
                }
                const link = {
                    workflow_id: workflowId,
                    media_id: mediaId,
                    role,
                    is_primary,
                    created_at: new Date().toISOString(),
                };
                workflowMedia.push(link);
                return {
                    workflow_id: workflowId,
                    media_id: mediaId,
                    role,
                    is_primary,
                    current_count: currentRelations.length + 1,
                    max_allowed: maxAllowed,
                    is_existing: false,
                };
            },
            setPrimaryMedia: async ({ workflowId, mediaId }) => {
                callLog.push({ op: "workflowMedia.setPrimaryMedia", workflowId, mediaId });
                for (const wm of workflowMedia) {
                    if (wm.workflow_id === workflowId) {
                        wm.is_primary = wm.media_id === mediaId;
                    }
                }
                return { workflow_id: workflowId, media_id: mediaId, is_primary: true };
            },
            clearPrimaryMedia: async ({ workflowId }) => {
                callLog.push({ op: "workflowMedia.clearPrimaryMedia", workflowId });
                for (const wm of workflowMedia) {
                    if (wm.workflow_id === workflowId) {
                        wm.is_primary = false;
                    }
                }
                return { workflow_id: workflowId, cleared: true };
            },
            unlink: async ({ workflowId, mediaId, role = null }) => {
                callLog.push({ op: "workflowMedia.unlink", workflowId, mediaId, role });
                for (let i = workflowMedia.length - 1; i >= 0; i--) {
                    const wm = workflowMedia[i];
                    const matchWf = !workflowId || wm.workflow_id === workflowId;
                    const matchMedia = !mediaId || wm.media_id === mediaId;
                    const matchRole = !role || wm.role === role;
                    if (matchWf && matchMedia && matchRole) {
                        workflowMedia.splice(i, 1);
                    }
                }
            },
        },
    };

    const storageService = {
        delete: async (key) => {
            callLog.push({ op: "storageService.delete", key });
            storageFiles.delete(key);
            return true;
        },
        deleteFiles: async (keys) => {
            callLog.push({ op: "storageService.deleteFiles", keys });
            for (const k of keys) storageFiles.delete(k);
            return { deletedCount: keys.length, failures: [] };
        },
        paths: {
            projectAsset: (userId, folder, filename) => `${userId}/${folder}/${filename}`,
        },
    };

    const mediaUploadService = {
        discard: async (keys = []) => {
            callLog.push({ op: "mediaUploadService.discard", keys: [...keys] });
            for (const k of keys) storageFiles.delete(k);
            return { deletedCount: keys.length };
        },
    };

    const authService = {
        verifyWorkflowOwnership: async (workflowId, userId) => {
            const wf = workflows.get(workflowId);
            return Boolean(wf && (!userId || wf.user_id === userId));
        },
        verifyMediaOwnership: async (mediaId, userId) => {
            const m = media.get(mediaId);
            return Boolean(m && (!userId || m.user_id === userId));
        },
    };

    const service = new WorkflowMediaService({
        db,
        storageService,
        authService,
        mediaUploadService,
    });

    return {
        service,
        db,
        storageService,
        mediaUploadService,
        authService,
        workflows,
        media,
        workflowMedia,
        storageFiles,
        callLog,
    };
}

describe("Ticket 03 — WorkflowMediaService Single Attach Seam & Explicit Rollback Order", () => {
    describe("1. Contract & Input Validation", () => {
        it("throws an error at construction if mediaUploadService is missing or lacks a discard method (fail-fast)", () => {
            assert.throws(
                () => new WorkflowMediaService({ db: {}, storageService: {} }),
                /WorkflowMediaService requires mediaUploadService with a discard method\./
            );
            assert.throws(
                () => new WorkflowMediaService({ db: {}, storageService: {}, mediaUploadService: {} }),
                /WorkflowMediaService requires mediaUploadService with a discard method\./
            );
            assert.throws(
                () => new WorkflowMediaService({ db: {}, storageService: {}, mediaUploadService: { discard: "not-a-func" } }),
                /WorkflowMediaService requires mediaUploadService with a discard method\./
            );
        });

        it("rejects undefined, NaN, string, negative, and non-integer maxAllowed with ValidationError (and discards uploaded keys)", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });
            h.storageFiles.add("user-1/uploads/temp1.png");

            const invalidValues = [undefined, NaN, "6", -1, 3.5, true];

            for (const badValue of invalidValues) {
                h.callLog.length = 0;
                await assert.rejects(
                    async () => {
                        await h.service.attachMediaItems({
                            workflowId: wfId,
                            userId: "user-1",
                            projectId: "proj-1",
                            role: "detail",
                            maxAllowed: badValue,
                            items: [
                                {
                                    kind: "uploaded",
                                    uploadedFile: {
                                        storageKey: "user-1/uploads/temp1.png",
                                        url: "https://storage.test/temp1.png",
                                        width: 100,
                                        height: 100,
                                        format: "PNG",
                                    },
                                },
                            ],
                        });
                    },
                    (err) => {
                        assert.ok(err instanceof ValidationError, `Expected ValidationError for ${badValue}, got ${err}`);
                        assert.equal(err.statusCode, 400);
                        return true;
                    }
                );
                // Discard must have been called for the uploaded key so it is not stranded
                const discardCall = h.callLog.find((c) => c.op === "mediaUploadService.discard");
                assert.ok(discardCall, `Expected discard on bad maxAllowed: ${badValue}`);
                assert.deepEqual(discardCall.keys, ["user-1/uploads/temp1.png"]);
            }
        });

        it("rejects non-boolean autoPrimary with ValidationError (and discards uploaded keys)", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });
            h.storageFiles.add("user-1/uploads/temp-auto.png");

            const invalidValues = ["true", "false", 1, 0, NaN, {}, []];

            for (const badValue of invalidValues) {
                h.callLog.length = 0;
                await assert.rejects(
                    async () => {
                        await h.service.attachMediaItems({
                            workflowId: wfId,
                            userId: "user-1",
                            projectId: "proj-1",
                            role: "detail",
                            maxAllowed: 6,
                            autoPrimary: badValue,
                            items: [
                                {
                                    kind: "uploaded",
                                    uploadedFile: {
                                        storageKey: "user-1/uploads/temp-auto.png",
                                        url: "https://storage.test/temp-auto.png",
                                        width: 100,
                                        height: 100,
                                        format: "PNG",
                                    },
                                },
                            ],
                        });
                    },
                    (err) => {
                        assert.ok(err instanceof ValidationError, `Expected ValidationError for ${badValue}, got ${err}`);
                        assert.equal(err.statusCode, 400);
                        return true;
                    }
                );
                const discardCall = h.callLog.find((c) => c.op === "mediaUploadService.discard");
                assert.ok(discardCall, `Expected discard on bad autoPrimary: ${badValue}`);
                assert.deepEqual(discardCall.keys, ["user-1/uploads/temp-auto.png"]);
            }
        });

        it("in-memory double handles autoPrimary: false -> sets is_primary: false on workflow with no primary", async () => {
            WorkflowMediaRepository.enableTestMemoryFallback();
            WorkflowMediaRepository.clearMemory();
            const repo = new WorkflowMediaRepository();

            const res = await repo.attachReferenceMedia({
                workflowId: "00000000-0000-0000-0000-000000000099",
                mediaId: "00000000-0000-0000-0000-000000000088",
                role: "detail",
                maxAllowed: 6,
                autoPrimary: false,
            });

            assert.equal(res.is_primary, false, "Must not set is_primary when autoPrimary is false");
            const links = await repo.findByWorkflow("00000000-0000-0000-0000-000000000099");
            assert.equal(links.length, 1);
            assert.equal(links[0].is_primary, false);
        });

        it("accepts maxAllowed: null (unlimited quota) and maxAllowed: 0 (zero-capacity quota)", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });

            // maxAllowed: null -> succeeds
            const resNull = await h.service.attachMediaItems({
                workflowId: wfId,
                userId: "user-1",
                projectId: "proj-1",
                role: "original",
                maxAllowed: null,
                items: [
                    {
                        kind: "uploaded",
                        uploadedFile: {
                            storageKey: "user-1/uploads/null_quota.png",
                            url: "https://storage.test/null_quota.png",
                            width: 100,
                            height: 100,
                            format: "PNG",
                        },
                    },
                ],
            });
            assert.equal(resNull.attached.length, 1);
            assert.equal(resNull.attached[0].link.max_allowed, null);

            // maxAllowed: 0 with an empty container -> rejects with QuotaError
            await assert.rejects(
                async () => {
                    await h.service.attachMediaItems({
                        workflowId: wfId,
                        userId: "user-1",
                        projectId: "proj-1",
                        role: "detail",
                        maxAllowed: 0,
                        items: [
                            {
                                kind: "uploaded",
                                uploadedFile: {
                                    storageKey: "user-1/uploads/zero_quota.png",
                                    url: "https://storage.test/zero_quota.png",
                                    width: 100,
                                    height: 100,
                                    format: "PNG",
                                },
                            },
                        ],
                    });
                },
                (err) => {
                    assert.ok(err instanceof QuotaError, `Expected QuotaError for maxAllowed=0, got ${err}`);
                    assert.equal(err.statusCode, 400);
                    return true;
                }
            );
        });

        it("rejects missing or foreign workflowId with 404 NOT_FOUND (never 403) and discards uploaded keys", async () => {
            const h = createMockHarness();
            const foreignWfId = "00000000-0000-0000-0000-000000000099";
            h.workflows.set(foreignWfId, { id: foreignWfId, user_id: "attacker", project_id: "proj-99" });

            await assert.rejects(
                async () => {
                    await h.service.attachMediaItems({
                        workflowId: foreignWfId,
                        userId: "victim",
                        projectId: "proj-1",
                        role: "detail",
                        maxAllowed: 6,
                        items: [
                            {
                                kind: "uploaded",
                                uploadedFile: {
                                    storageKey: "victim/uploads/leak.png",
                                    url: "https://storage.test/leak.png",
                                    width: 100,
                                    height: 100,
                                    format: "PNG",
                                },
                            },
                        ],
                    });
                },
                (err) => {
                    assert.equal(err.statusCode, 404, "Cross-tenant access must return 404, never 403");
                    assert.equal(err.errorCode, "NOT_FOUND");
                    return true;
                }
            );

            const discardCall = h.callLog.find((c) => c.op === "mediaUploadService.discard");
            assert.ok(discardCall, "Must discard uploaded keys when workflowId check fails");
            assert.deepEqual(discardCall.keys, ["victim/uploads/leak.png"]);
        });
    });

    describe("2. Phase 1 Pre-Flight for Existing Items", () => {
        it("pre-validates all existing media items before any DB writes; foreign mediaId throws 404 and discards uploaded batch keys without creating DB rows", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });

            // Foreign media item belonging to attacker
            const foreignMediaId = "00000000-0000-0000-0000-000000000099";
            h.media.set(foreignMediaId, { id: foreignMediaId, user_id: "attacker", project_id: "proj-99", url: "https://storage.test/foreign.png" });
            h.workflowMedia.push({ workflow_id: "wf-foreign", media_id: foreignMediaId, role: "detail", is_primary: false });

            h.callLog.length = 0;
            await assert.rejects(
                async () => {
                    await h.service.attachMediaItems({
                        workflowId: wfId,
                        userId: "user-1",
                        projectId: "proj-1",
                        role: "detail",
                        maxAllowed: 6,
                        items: [
                            {
                                kind: "uploaded",
                                uploadedFile: {
                                    storageKey: "user-1/uploads/batch1.png",
                                    url: "https://storage.test/batch1.png",
                                    width: 100,
                                    height: 100,
                                    format: "PNG",
                                },
                            },
                            {
                                kind: "existing",
                                mediaId: foreignMediaId,
                            },
                        ],
                    });
                },
                (err) => {
                    assert.equal(err.statusCode, 404, "Foreign mediaId must return 404");
                    return true;
                }
            );

            // Verify ZERO public.media creation calls occurred
            const createCalls = h.callLog.filter((c) => c.op === "media.createMedia");
            assert.equal(createCalls.length, 0, "Pre-flight must prevent any createMedia calls when existing mediaId fails");

            // Verify uploaded key was safely discarded
            const discardCall = h.callLog.find((c) => c.op === "mediaUploadService.discard");
            assert.ok(discardCall);
            assert.deepEqual(discardCall.keys, ["user-1/uploads/batch1.png"]);
        });
    });

    describe("3. Attachment Success & Handle Contract", () => {
        it("attaches uploaded and existing items, marks first item primary, and returns complete rollbackHandle", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });

            const existingMediaId = "00000000-0000-0000-0000-000000000002";
            h.media.set(existingMediaId, { id: existingMediaId, user_id: "user-1", project_id: "proj-1", url: "https://storage.test/existing.png" });
            h.workflowMedia.push({ workflow_id: "wf-prior", media_id: existingMediaId, role: "output", is_primary: true });

            const result = await h.service.attachMediaItems({
                workflowId: wfId,
                userId: "user-1",
                projectId: "proj-1",
                role: "detail",
                maxAllowed: 6,
                items: [
                    {
                        kind: "uploaded",
                        uploadedFile: {
                            storageKey: "user-1/uploads/upload1.png",
                            url: "https://storage.test/upload1.png",
                            width: 200,
                            height: 200,
                            format: "PNG",
                        },
                    },
                    {
                        kind: "existing",
                        mediaId: existingMediaId,
                    },
                ],
            });

            assert.equal(result.attached.length, 2);
            assert.equal(result.attached[0].kind, "uploaded");
            assert.equal(result.attached[0].is_primary, true, "First item becomes primary");
            assert.equal(result.attached[0].is_existing, false);
            assert.equal(result.attached[1].kind, "existing");
            assert.equal(result.attached[1].is_primary, false);
            assert.equal(result.attached[1].is_existing, false);

            const handle = result.rollbackHandle;
            assert.ok(handle, "rollbackHandle must be returned");
            assert.equal(handle.workflowId, wfId);
            assert.equal(handle.role, "detail");
            assert.equal(handle.entries.length, 2);
            assert.equal(handle.entries[0].mediaCreatedInCall, true);
            assert.equal(handle.entries[0].linkCreatedInCall, true);
            assert.equal(handle.entries[0].storageKey, "user-1/uploads/upload1.png");
            assert.equal(handle.entries[1].mediaCreatedInCall, false);
            assert.equal(handle.entries[1].linkCreatedInCall, true);
            assert.equal(handle.entries[1].storageKey, null);
        });

        it("idempotent re-attachment marks is_existing: true and does not create duplicate links", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });

            const mediaId = "00000000-0000-0000-0000-000000000002";
            h.media.set(mediaId, { id: mediaId, user_id: "user-1", project_id: "proj-1", url: "https://storage.test/m2.png" });
            h.workflowMedia.push({ workflow_id: wfId, media_id: mediaId, role: "detail", is_primary: true });

            const result = await h.service.attachMediaItems({
                workflowId: wfId,
                userId: "user-1",
                projectId: "proj-1",
                role: "detail",
                maxAllowed: 6,
                items: [{ kind: "existing", mediaId }],
            });

            assert.equal(result.attached[0].is_existing, true);
            assert.equal(result.rollbackHandle.entries[0].linkCreatedInCall, false);
        });
    });

    describe("4. Quota Enforcement & Check Constraint Error Isolation", () => {
        it("maps PostgreSQL check_violation (23514) to QuotaError only when message matches reference quota, never on workflow_media_role_check", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });

            // Force attachReferenceMedia to simulate workflow_media_role_check
            h.db.workflowMedia.attachReferenceMedia = async () => {
                const err = new Error('new row for relation "workflow_media" violates check constraint "workflow_media_role_check"');
                err.code = "23514";
                err.statusCode = 400;
                throw err;
            };

            await assert.rejects(
                async () => {
                    await h.service.attachMediaItems({
                        workflowId: wfId,
                        userId: "user-1",
                        projectId: "proj-1",
                        role: "invalid_role",
                        maxAllowed: 6,
                        items: [
                            {
                                kind: "uploaded",
                                uploadedFile: {
                                    storageKey: "user-1/uploads/test.png",
                                    url: "https://storage.test/test.png",
                                    width: 100,
                                    height: 100,
                                    format: "PNG",
                                },
                            },
                        ],
                    });
                },
                (err) => {
                    assert.ok(!(err instanceof QuotaError), "workflow_media_role_check must NOT be mapped to QuotaError");
                    assert.equal(err.code, "23514");
                    return true;
                }
            );
        });
    });

    describe("5. Rollback Order, Per-Item Guard & Skipping Discard on Delete Failure", () => {
        it("executes strict rollback order: unlink -> restore/clear primary -> deleteById -> discard on batch failure", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });

            const existingMediaId = "00000000-0000-0000-0000-000000000002";
            h.media.set(existingMediaId, { id: existingMediaId, user_id: "user-1", project_id: "proj-1", url: "https://storage.test/m2.png" });
            h.workflowMedia.push({ workflow_id: "wf-prior", media_id: existingMediaId, role: "output", is_primary: true });

            let callCount = 0;
            const origAttach = h.db.workflowMedia.attachReferenceMedia;
            h.db.workflowMedia.attachReferenceMedia = async (params) => {
                callCount++;
                if (callCount === 3) {
                    // Third item fails quota
                    const err = new Error(formatWorkflowReferenceQuotaMessage(6, 6));
                    err.code = "23514";
                    err.statusCode = 400;
                    throw err;
                }
                return origAttach(params);
            };

            h.callLog.length = 0;
            await assert.rejects(
                async () => {
                    await h.service.attachMediaItems({
                        workflowId: wfId,
                        userId: "user-1",
                        projectId: "proj-1",
                        role: "detail",
                        maxAllowed: 6,
                        items: [
                            { kind: "existing", mediaId: existingMediaId },
                            {
                                kind: "uploaded",
                                uploadedFile: {
                                    storageKey: "user-1/uploads/item2.png",
                                    url: "https://storage.test/item2.png",
                                    width: 100,
                                    height: 100,
                                    format: "PNG",
                                },
                            },
                            {
                                kind: "uploaded",
                                uploadedFile: {
                                    storageKey: "user-1/uploads/item3.png",
                                    url: "https://storage.test/item3.png",
                                    width: 100,
                                    height: 100,
                                    format: "PNG",
                                },
                            },
                        ],
                    });
                },
                QuotaError
            );

            // Verify exact rollback order:
            // 1. unlink items 1 and 2
            // 2. clear primary
            // 3. deleteById for uploaded items 2 and 3 (item 1 pre-existing row NEVER deleted)
            // 4. discard for uploaded items 2 and 3 (item 1 storage NEVER discarded)
            const rollbackOps = h.callLog.filter((c) =>
                ["workflowMedia.unlink", "workflowMedia.clearPrimaryMedia", "media.deleteById", "mediaUploadService.discard"].includes(c.op)
            );

            const unlinkIndices = rollbackOps.map((c, i) => (c.op === "workflowMedia.unlink" ? i : -1)).filter((i) => i >= 0);
            const deleteIndices = rollbackOps.map((c, i) => (c.op === "media.deleteById" ? i : -1)).filter((i) => i >= 0);
            const discardIndices = rollbackOps.map((c, i) => (c.op === "mediaUploadService.discard" ? i : -1)).filter((i) => i >= 0);

            assert.ok(unlinkIndices.length >= 2, "Both item 1 and item 2 must be unlinked");
            assert.ok(Math.max(...unlinkIndices) < Math.min(...deleteIndices), "All unlinks must complete before deleteById");
            assert.ok(Math.max(...deleteIndices) < Math.min(...discardIndices), "All deleteById calls must complete before discard");

            // Verify item 1's media row still exists
            assert.ok(h.media.has(existingMediaId), "Pre-existing media row must NEVER be deleted on rollback");
        });

        it("item #k with mediaCreatedInCall: true and linkCreatedInCall: false runs deleteById without unlink", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });

            h.db.workflowMedia.attachReferenceMedia = async () => {
                const err = new Error(formatWorkflowReferenceQuotaMessage(6, 6));
                err.code = "23514";
                err.statusCode = 400;
                throw err;
            };

            h.callLog.length = 0;
            await assert.rejects(
                async () => {
                    await h.service.attachMediaItems({
                        workflowId: wfId,
                        userId: "user-1",
                        projectId: "proj-1",
                        role: "detail",
                        maxAllowed: 6,
                        items: [
                            {
                                kind: "uploaded",
                                uploadedFile: {
                                    storageKey: "user-1/uploads/fail_attach.png",
                                    url: "https://storage.test/fail_attach.png",
                                    width: 100,
                                    height: 100,
                                    format: "PNG",
                                },
                            },
                        ],
                    });
                },
                QuotaError
            );

            // Since attachReferenceMedia threw, no workflow_media row was created
            const unlinkCalls = h.callLog.filter((c) => c.op === "workflowMedia.unlink");
            assert.equal(unlinkCalls.length, 0, "No unlink call if linkCreatedInCall is false");

            // But media.deleteById MUST run because media.createMedia succeeded
            const deleteCalls = h.callLog.filter((c) => c.op === "media.deleteById");
            assert.equal(deleteCalls.length, 1);

            // Storage must be discarded
            const discardCall = h.callLog.find((c) => c.op === "mediaUploadService.discard");
            assert.ok(discardCall);
            assert.deepEqual(discardCall.keys, ["user-1/uploads/fail_attach.png"]);
        });

        it("skips discard when media.deleteById fails, logging the skipped storage key and never leaving a dangling DB row", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });

            // Fail attachReferenceMedia so rollback is triggered
            h.db.workflowMedia.attachReferenceMedia = async () => {
                const err = new Error(formatWorkflowReferenceQuotaMessage(6, 6));
                err.code = "23514";
                err.statusCode = 400;
                throw err;
            };

            // Also make media.deleteById fail
            h.db.media.deleteById = async () => {
                throw new Error("DB deadlock on media delete");
            };

            h.callLog.length = 0;
            await assert.rejects(
                async () => {
                    await h.service.attachMediaItems({
                        workflowId: wfId,
                        userId: "user-1",
                        projectId: "proj-1",
                        role: "detail",
                        maxAllowed: 6,
                        items: [
                            {
                                kind: "uploaded",
                                uploadedFile: {
                                    storageKey: "user-1/uploads/skip_discard.png",
                                    url: "https://storage.test/skip_discard.png",
                                    width: 100,
                                    height: 100,
                                    format: "PNG",
                                },
                            },
                        ],
                    });
                },
                QuotaError
            );

            // mediaUploadService.discard must NOT have been called with the failed item's key
            const discardCall = h.callLog.find((c) => c.op === "mediaUploadService.discard");
            if (discardCall) {
                assert.ok(!discardCall.keys.includes("user-1/uploads/skip_discard.png"));
            }
        });

        it("never unlinks pre-existing links (is_existing: true) during rollback", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });

            const preExistingMediaId = "00000000-0000-0000-0000-000000000010";
            h.media.set(preExistingMediaId, { id: preExistingMediaId, user_id: "user-1", project_id: "proj-1", url: "https://storage.test/m10.png" });
            h.workflowMedia.push({ workflow_id: wfId, media_id: preExistingMediaId, role: "detail", is_primary: false });

            let callCount = 0;
            const origAttach = h.db.workflowMedia.attachReferenceMedia;
            h.db.workflowMedia.attachReferenceMedia = async (params) => {
                callCount++;
                if (callCount === 2) {
                    throw new Error("Network hiccup on item 2");
                }
                return origAttach(params);
            };

            h.callLog.length = 0;
            await assert.rejects(
                async () => {
                    await h.service.attachMediaItems({
                        workflowId: wfId,
                        userId: "user-1",
                        projectId: "proj-1",
                        role: "detail",
                        maxAllowed: 6,
                        items: [
                            { kind: "existing", mediaId: preExistingMediaId }, // is_existing: true
                            {
                                kind: "uploaded",
                                uploadedFile: {
                                    storageKey: "user-1/uploads/i2.png",
                                    url: "https://storage.test/i2.png",
                                    width: 100,
                                    height: 100,
                                    format: "PNG",
                                },
                            },
                        ],
                    });
                },
                /Network hiccup/
            );

            // Verify preExistingMediaId was NOT unlinked
            const unlinkCalls = h.callLog.filter((c) => c.op === "workflowMedia.unlink");
            assert.equal(unlinkCalls.length, 0, "Pre-existing link must NEVER be unlinked on rollback");
            const stillLinked = h.workflowMedia.some((wm) => wm.workflow_id === wfId && wm.media_id === preExistingMediaId);
            assert.equal(stillLinked, true);
        });
    });

    describe("6. Primary Media Rollback & Compare-and-Restore", () => {
        it("restores previous primary when setPrimary: true and a previous primary existed", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            const prevPrimaryId = "00000000-0000-0000-0000-000000000011";

            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1", primary_media_id: prevPrimaryId });
            h.media.set(prevPrimaryId, { id: prevPrimaryId, user_id: "user-1", project_id: "proj-1", url: "https://storage.test/p.png" });
            h.workflowMedia.push({ workflow_id: wfId, media_id: prevPrimaryId, role: "detail", is_primary: true });

            // Attach with setPrimary: true
            const res = await h.service.attachMediaItems({
                workflowId: wfId,
                userId: "user-1",
                projectId: "proj-1",
                role: "detail",
                maxAllowed: 6,
                setPrimary: true,
                items: [
                    {
                        kind: "uploaded",
                        uploadedFile: {
                            storageKey: "user-1/uploads/new_primary.png",
                            url: "https://storage.test/new_primary.png",
                            width: 100,
                            height: 100,
                            format: "PNG",
                        },
                    },
                ],
            });

            const newPrimaryId = res.attached[0].media.id;
            assert.equal(h.workflows.get(wfId).primary_media_id, newPrimaryId);

            // Now simulate caller step failure (Matrix Row 6) and trigger rollbackAttachedMedia
            h.callLog.length = 0;
            const rbRes = await h.service.rollbackAttachedMedia(res.rollbackHandle);

            assert.equal(rbRes.complete, true, "Rollback must report complete: true on successful compensation");
            assert.equal(rbRes.restoredPrimaryMediaId, prevPrimaryId);
            assert.equal(h.workflows.get(wfId).primary_media_id, prevPrimaryId);

            const wm = h.workflowMedia.find((w) => w.workflow_id === wfId && w.media_id === prevPrimaryId);
            assert.equal(wm?.is_primary, true, "Previous primary relation must be restored");
        });

        it("clears primary (sets null on workflow_media and workflows table) when previous primary was null", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1", primary_media_id: null });

            const res = await h.service.attachMediaItems({
                workflowId: wfId,
                userId: "user-1",
                projectId: "proj-1",
                role: "detail",
                maxAllowed: 6,
                setPrimary: true,
                items: [
                    {
                        kind: "uploaded",
                        uploadedFile: {
                            storageKey: "user-1/uploads/first_primary.png",
                            url: "https://storage.test/first_primary.png",
                            width: 100,
                            height: 100,
                            format: "PNG",
                        },
                    },
                ],
            });

            assert.equal(h.workflows.get(wfId).primary_media_id, res.attached[0].media.id);

            // Rollback
            await h.service.rollbackAttachedMedia(res.rollbackHandle);

            assert.equal(h.workflows.get(wfId).primary_media_id, null, "primary_media_id must be cleared to null");
            const hasAnyPrimary = h.workflowMedia.some((w) => w.workflow_id === wfId && w.is_primary === true);
            assert.equal(hasAnyPrimary, false);
        });

        it("rollback with autoPrimary: false unlinks and reaps media without altering workflow primary", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000003";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1", primary_media_id: null });
            h.storageFiles.add("user-1/uploads/autoprimary_false.png");

            const res = await h.service.attachMediaItems({
                workflowId: wfId,
                userId: "user-1",
                projectId: "proj-1",
                role: "detail",
                maxAllowed: 6,
                autoPrimary: false,
                items: [
                    {
                        kind: "uploaded",
                        uploadedFile: {
                            storageKey: "user-1/uploads/autoprimary_false.png",
                            url: "https://storage.test/autoprimary_false.png",
                            width: 100,
                            height: 100,
                            format: "PNG",
                        },
                    },
                ],
            });

            assert.equal(res.attached[0].is_primary, false);
            assert.equal(h.workflows.get(wfId).primary_media_id, null);

            // Rollback
            const rbRes = await h.service.rollbackAttachedMedia(res.rollbackHandle);
            assert.equal(rbRes.complete, true);
            assert.equal(rbRes.unlinkedMediaIds.length, 1);
            assert.equal(rbRes.deletedMediaIds.length, 1);
            assert.equal(h.workflows.get(wfId).primary_media_id, null);

            // Storage was discarded
            assert.ok(!h.storageFiles.has("user-1/uploads/autoprimary_false.png"));
        });

        it("compare-and-restore does not overwrite a concurrent primary change made by another process", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            const prevPrimaryId = "00000000-0000-0000-0000-000000000011";

            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1", primary_media_id: prevPrimaryId });
            h.media.set(prevPrimaryId, { id: prevPrimaryId, user_id: "user-1", project_id: "proj-1", url: "https://storage.test/p.png" });
            h.workflowMedia.push({ workflow_id: wfId, media_id: prevPrimaryId, role: "detail", is_primary: true });

            const res = await h.service.attachMediaItems({
                workflowId: wfId,
                userId: "user-1",
                projectId: "proj-1",
                role: "detail",
                maxAllowed: 6,
                setPrimary: true,
                items: [
                    {
                        kind: "uploaded",
                        uploadedFile: {
                            storageKey: "user-1/uploads/set_p.png",
                            url: "https://storage.test/set_p.png",
                            width: 100,
                            height: 100,
                            format: "PNG",
                        },
                    },
                ],
            });

            // Simulate concurrent worker setting a different primary (e.g. concurrent user edit)
            const concurrentMediaId = "00000000-0000-0000-0000-000000000099";
            h.media.set(concurrentMediaId, { id: concurrentMediaId, user_id: "user-1", project_id: "proj-1", url: "https://storage.test/c.png" });
            h.workflowMedia.push({ workflow_id: wfId, media_id: concurrentMediaId, role: "detail", is_primary: true });
            h.workflows.get(wfId).primary_media_id = concurrentMediaId;

            // Rollback must NOT restore prevPrimaryId over concurrentMediaId
            const rbRes = await h.service.rollbackAttachedMedia(res.rollbackHandle);

            assert.equal(h.workflows.get(wfId).primary_media_id, concurrentMediaId);
            assert.equal(rbRes.restoredPrimaryMediaId, null, "Concurrent primary must be preserved");
        });

        it("conditionalRestorePrimaryMedia: updated true confirms restore, deletes media and discards storage", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            const prevPrimaryId = "00000000-0000-0000-0000-000000000011";

            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1", primary_media_id: prevPrimaryId });
            h.media.set(prevPrimaryId, { id: prevPrimaryId, user_id: "user-1", project_id: "proj-1", url: "https://storage.test/p.png" });
            h.workflowMedia.push({ workflow_id: wfId, media_id: prevPrimaryId, role: "detail", is_primary: true });

            h.db.workflows.conditionalRestorePrimaryMedia = async () => ({ updated: true });

            const res = await h.service.attachMediaItems({
                workflowId: wfId,
                userId: "user-1",
                projectId: "proj-1",
                role: "detail",
                maxAllowed: 6,
                setPrimary: true,
                items: [
                    {
                        kind: "uploaded",
                        uploadedFile: {
                            storageKey: "user-1/uploads/cond_true.png",
                            url: "https://storage.test/cond_true.png",
                            width: 100,
                            height: 100,
                            format: "PNG",
                        },
                    },
                ],
            });

            const rbRes = await h.service.rollbackAttachedMedia(res.rollbackHandle);
            assert.equal(rbRes.complete, true);
            assert.ok(rbRes.deletedMediaIds.includes(res.attached[0].media.id));
            assert.ok(rbRes.discardedStorageKeys.includes("user-1/uploads/cond_true.png"));
        });

        it("conditionalRestorePrimaryMedia: updated false fails restore confirmation, keeps media row and file, logs at error level", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            const prevPrimaryId = "00000000-0000-0000-0000-000000000011";

            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1", primary_media_id: prevPrimaryId });
            h.media.set(prevPrimaryId, { id: prevPrimaryId, user_id: "user-1", project_id: "proj-1", url: "https://storage.test/p.png" });
            h.workflowMedia.push({ workflow_id: wfId, media_id: prevPrimaryId, role: "detail", is_primary: true });

            h.db.workflows.conditionalRestorePrimaryMedia = async () => ({ updated: false });

            const errorLogs = [];
            const origBaseError = baseLogger.error;
            baseLogger.error = (obj, msg, ...rest) => {
                errorLogs.push({ obj, msg });
                return origBaseError.call(baseLogger, obj, msg, ...rest);
            };

            try {
                const res = await h.service.attachMediaItems({
                    workflowId: wfId,
                    userId: "user-1",
                    projectId: "proj-1",
                    role: "detail",
                    maxAllowed: 6,
                    setPrimary: true,
                    items: [
                        {
                            kind: "uploaded",
                            uploadedFile: {
                                storageKey: "user-1/uploads/cond_false.png",
                                url: "https://storage.test/cond_false.png",
                                width: 100,
                                height: 100,
                                format: "PNG",
                            },
                        },
                    ],
                });

                const rbRes = await h.service.rollbackAttachedMedia(res.rollbackHandle);
                assert.equal(rbRes.complete, false);
                assert.ok(!rbRes.deletedMediaIds.includes(res.attached[0].media.id));
                assert.ok(rbRes.skippedStorageKeys.includes("user-1/uploads/cond_false.png"));

                const restoreErrorLog = errorLogs.find(
                    (l) => l.obj?.operation === "rollbackAttachedMedia:restorePrimary" && l.obj?.status === "error"
                );
                assert.ok(restoreErrorLog, "Must log at error level when restore is not confirmed");
                assert.equal(restoreErrorLog.obj.workflowId, wfId);
                assert.deepEqual(restoreErrorLog.obj.storageKeys, ["user-1/uploads/cond_false.png"]);
            } finally {
                baseLogger.error = origBaseError;
            }
        });

        it("conditionalRestorePrimaryMedia: updated undefined fails restore confirmation, keeps media row and file, logs at error level", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            const prevPrimaryId = "00000000-0000-0000-0000-000000000011";

            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1", primary_media_id: prevPrimaryId });
            h.media.set(prevPrimaryId, { id: prevPrimaryId, user_id: "user-1", project_id: "proj-1", url: "https://storage.test/p.png" });
            h.workflowMedia.push({ workflow_id: wfId, media_id: prevPrimaryId, role: "detail", is_primary: true });

            // Simulates RPC failure or return value where updated is undefined
            h.db.workflows.conditionalRestorePrimaryMedia = async () => ({});

            const errorLogs = [];
            const origBaseError = baseLogger.error;
            baseLogger.error = (obj, msg, ...rest) => {
                errorLogs.push({ obj, msg });
                return origBaseError.call(baseLogger, obj, msg, ...rest);
            };

            try {
                const res = await h.service.attachMediaItems({
                    workflowId: wfId,
                    userId: "user-1",
                    projectId: "proj-1",
                    role: "detail",
                    maxAllowed: 6,
                    setPrimary: true,
                    items: [
                        {
                            kind: "uploaded",
                            uploadedFile: {
                                storageKey: "user-1/uploads/cond_undefined.png",
                                url: "https://storage.test/cond_undefined.png",
                                width: 100,
                                height: 100,
                                format: "PNG",
                            },
                        },
                    ],
                });

                const rbRes = await h.service.rollbackAttachedMedia(res.rollbackHandle);
                assert.equal(rbRes.complete, false, "Must report complete: false when updated is undefined");
                assert.ok(!rbRes.deletedMediaIds.includes(res.attached[0].media.id));
                assert.ok(rbRes.skippedStorageKeys.includes("user-1/uploads/cond_undefined.png"));

                const restoreErrorLog = errorLogs.find(
                    (l) => l.obj?.operation === "rollbackAttachedMedia:restorePrimary" && l.obj?.status === "error"
                );
                assert.ok(restoreErrorLog, "Must log at error level when updated is undefined");
                assert.equal(restoreErrorLog.obj.workflowId, wfId);
                assert.deepEqual(restoreErrorLog.obj.storageKeys, ["user-1/uploads/cond_undefined.png"]);
            } finally {
                baseLogger.error = origBaseError;
            }
        });

        it("if primary restore fails, new primary media is NOT confirmed gone (deleteById and discard are skipped)", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            const prevPrimaryId = "00000000-0000-0000-0000-000000000011";

            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1", primary_media_id: prevPrimaryId });
            h.media.set(prevPrimaryId, { id: prevPrimaryId, user_id: "user-1", project_id: "proj-1", url: "https://storage.test/p.png" });
            h.workflowMedia.push({ workflow_id: wfId, media_id: prevPrimaryId, role: "detail", is_primary: true });

            const res = await h.service.attachMediaItems({
                workflowId: wfId,
                userId: "user-1",
                projectId: "proj-1",
                role: "detail",
                maxAllowed: 6,
                setPrimary: true,
                items: [
                    {
                        kind: "uploaded",
                        uploadedFile: {
                            storageKey: "user-1/uploads/keep_file_on_restore_fail.png",
                            url: "https://storage.test/keep.png",
                            width: 100,
                            height: 100,
                            format: "PNG",
                        },
                    },
                ],
            });

            // Force setPrimaryMedia to fail on restore
            h.db.workflowMedia.setPrimaryMedia = async () => {
                throw new Error("Primary lock failed");
            };

            const rbRes = await h.service.rollbackAttachedMedia(res.rollbackHandle);

            assert.equal(rbRes.complete, false, "Rollback must report complete: false when primary restore fails");
            // New primary media row must NOT be deleted, and its storage file must NOT be discarded
            assert.ok(rbRes.skippedStorageKeys.includes("user-1/uploads/keep_file_on_restore_fail.png"));
            assert.ok(!rbRes.discardedStorageKeys.includes("user-1/uploads/keep_file_on_restore_fail.png"));
            assert.ok(!rbRes.deletedMediaIds.includes(res.attached[0].media.id));
        });

        it("auto-primary: empty workflow, no setPrimary, a later caller step fails, and workflows.primary_media_id must not reference a deleted media row", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1", primary_media_id: null });

            const res = await h.service.attachMediaItems({
                workflowId: wfId,
                userId: "user-1",
                projectId: "proj-1",
                role: "detail",
                maxAllowed: 6,
                setPrimary: false,
                items: [
                    {
                        kind: "uploaded",
                        uploadedFile: {
                            storageKey: "user-1/uploads/auto_primary.png",
                            url: "https://storage.test/auto_primary.png",
                            width: 100,
                            height: 100,
                            format: "PNG",
                        },
                    },
                ],
            });

            assert.equal(res.attached[0].is_primary, true, "First item becomes primary via RPC/mock");
            const attachedMediaId = res.attached[0].media.id;

            // Simulate caller step 2 writing workflows.primary_media_id
            await h.db.workflows.updatePrimaryMedia(wfId, attachedMediaId);
            assert.equal(h.workflows.get(wfId).primary_media_id, attachedMediaId);

            // Caller step 3 fails -> calls rollbackAttachedMedia
            const rbRes = await h.service.rollbackAttachedMedia(res.rollbackHandle);

            // workflows.primary_media_id must NOT point to the deleted media row
            assert.equal(h.workflows.get(wfId).primary_media_id, null, "primary_media_id must be cleared on rollback");
            assert.equal(h.media.has(attachedMediaId), false, "Media record must be deleted");
            assert.ok(rbRes.discardedStorageKeys.includes("user-1/uploads/auto_primary.png"), "Storage file must be discarded");
        });
    });

    describe("7. Rollback Idempotency & Non-Throwing Invariant", () => {
        it("calling rollbackAttachedMedia twice is idempotent and does not repeat DB or storage actions", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });

            const res = await h.service.attachMediaItems({
                workflowId: wfId,
                userId: "user-1",
                projectId: "proj-1",
                role: "detail",
                maxAllowed: 6,
                items: [
                    {
                        kind: "uploaded",
                        uploadedFile: {
                            storageKey: "user-1/uploads/idem.png",
                            url: "https://storage.test/idem.png",
                            width: 100,
                            height: 100,
                            format: "PNG",
                        },
                    },
                ],
            });

            // First rollback
            const rb1 = await h.service.rollbackAttachedMedia(res.rollbackHandle);
            assert.equal(rb1.unlinkedMediaIds.length, 1);
            assert.equal(rb1.deletedMediaIds.length, 1);
            assert.equal(rb1.discardedStorageKeys.length, 1);

            h.callLog.length = 0;

            // Second rollback
            const rb2 = await h.service.rollbackAttachedMedia(res.rollbackHandle);
            assert.equal(rb2.unlinkedMediaIds.length, 0);
            assert.equal(rb2.deletedMediaIds.length, 0);
            assert.equal(rb2.discardedStorageKeys.length, 0);

            // Zero DB calls during second rollback
            const dbOps = h.callLog.filter((c) => c.op.startsWith("workflowMedia.") || c.op.startsWith("media."));
            assert.equal(dbOps.length, 0);
        });

        it("rollbackAttachedMedia never throws even when DB unlink, deleteById, and storage discard reject", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });

            const res = await h.service.attachMediaItems({
                workflowId: wfId,
                userId: "user-1",
                projectId: "proj-1",
                role: "detail",
                maxAllowed: 6,
                items: [
                    {
                        kind: "uploaded",
                        uploadedFile: {
                            storageKey: "user-1/uploads/crash.png",
                            url: "https://storage.test/crash.png",
                            width: 100,
                            height: 100,
                            format: "PNG",
                        },
                    },
                ],
            });

            // Sabotage DB and storage methods to throw
            h.db.workflowMedia.unlink = async () => { throw new Error("DB fatal unlink crash"); };
            h.db.media.deleteById = async () => { throw new Error("DB fatal delete crash"); };
            h.storageService.deleteFiles = async () => { throw new Error("Storage fatal crash"); };

            const rbRes = await h.service.rollbackAttachedMedia(res.rollbackHandle);
            assert.ok(rbRes && typeof rbRes === "object", "Must return tracking object without throwing");
        });

        it("storage discard failure logs at error level with workflowId and storageKeys, populating discardFailedKeys while complete is true", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000002";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });

            const res = await h.service.attachMediaItems({
                workflowId: wfId,
                userId: "user-1",
                projectId: "proj-1",
                role: "detail",
                maxAllowed: 6,
                items: [
                    {
                        kind: "uploaded",
                        uploadedFile: {
                            storageKey: "user-1/uploads/fail-discard.png",
                            url: "https://storage.test/fail-discard.png",
                            width: 100,
                            height: 100,
                            format: "PNG",
                        },
                    },
                ],
            });

            const errorLogs = [];
            const origBaseError = baseLogger.error;
            baseLogger.error = (obj, msg, ...rest) => {
                errorLogs.push({ obj, msg });
                return origBaseError.call(baseLogger, obj, msg, ...rest);
            };

            try {
                // Storage discard fails
                h.mediaUploadService.discard = async () => {
                    throw new Error("Simulated storage discard failure");
                };

                const rbRes = await h.service.rollbackAttachedMedia(res.rollbackHandle);
                assert.equal(rbRes.complete, true, "DB operations succeeded so complete must remain true");
                assert.deepEqual(rbRes.discardFailedKeys, ["user-1/uploads/fail-discard.png"], "discardFailedKeys must contain failed storage keys");

                const discardErrorLog = errorLogs.find(
                    (l) => l.obj?.operation === "WorkflowMediaService:discardStorage" && l.obj?.status === "error"
                );
                assert.ok(discardErrorLog, "Must log at error level on discard failure");
                assert.equal(discardErrorLog.obj.workflowId, wfId, "Must include workflowId in structured log");
                assert.deepEqual(discardErrorLog.obj.storageKeys, ["user-1/uploads/fail-discard.png"], "Must include storageKeys in structured log");
            } finally {
                baseLogger.error = origBaseError;
            }
        });
    });
});
