import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkflowService } from "#generation/tools";
import { WorkflowMediaService, sanitizeStoragePath } from "../../../src/systems/generation/internal/services/WorkflowMediaService.js";
import { QuotaError, ValidationError, UploadError, MediaConflictError, formatWorkflowReferenceQuotaMessage, isWorkflowReferenceQuotaError, WorkflowMediaRepository } from "#media/tools";
import { CrudServiceError, baseLogger } from "#shared";
import { ElementService, ElementMediaService, ElementRepository } from "#elements/tools";
import { CharacterService, CharacterMediaService } from "#characters/tools";
import { deleteMedia as workflowsControllerDeleteMedia } from "#generation/api";
import { workflowService } from "../../../src/container.js";

// ─── Source: workflowMediaServiceAttachAndRollback.test.js ───
{
process.env.NODE_ENV = "test";


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
                callLog.push({ op: "media.createMedia", id, url: fields.url, fields });
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
                // Faithful to attach_workflow_reference_media: writes workflow_media.is_primary only,
                // never workflows.primary_media_id.
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
        it("throws an error at construction if authService or mediaUploadService is missing (fail-fast)", () => {
            const validAuth = { verifyWorkflowOwnership: async () => true };
            const validUpload = { discard: async () => {} };

            // authService validation
            assert.throws(
                () => new WorkflowMediaService({ db: {}, storageService: {}, mediaUploadService: validUpload }),
                /WorkflowMediaService requires authService with verifyWorkflowOwnership method\./
            );
            assert.throws(
                () => new WorkflowMediaService({ db: {}, storageService: {}, mediaUploadService: validUpload, authService: {} }),
                /WorkflowMediaService requires authService with verifyWorkflowOwnership method\./
            );
            assert.throws(
                () => new WorkflowMediaService({ db: {}, storageService: {}, mediaUploadService: validUpload, authService: { verifyWorkflowOwnership: "not-a-func" } }),
                /WorkflowMediaService requires authService with verifyWorkflowOwnership method\./
            );
            // Single dependency key: the legacy workflowAuthService alias does not satisfy authService
            assert.throws(
                () => new WorkflowMediaService({
                    db: { workflowMedia: { findByMedia: async () => [] } },
                    storageService: {},
                    mediaUploadService: validUpload,
                    workflowAuthService: validAuth,
                }),
                /WorkflowMediaService requires authService with verifyWorkflowOwnership method\./
            );

            // mediaUploadService validation
            assert.throws(
                () => new WorkflowMediaService({ db: {}, storageService: {}, authService: validAuth }),
                /WorkflowMediaService requires mediaUploadService with a discard method\./
            );
            assert.throws(
                () => new WorkflowMediaService({ db: {}, storageService: {}, authService: validAuth, mediaUploadService: {} }),
                /WorkflowMediaService requires mediaUploadService with a discard method\./
            );
            assert.throws(
                () => new WorkflowMediaService({ db: {}, storageService: {}, authService: validAuth, mediaUploadService: { discard: "not-a-func" } }),
                /WorkflowMediaService requires mediaUploadService with a discard method\./
            );

            // db.workflowMedia.findByMedia validation
            assert.throws(
                () => new WorkflowMediaService({ db: {}, storageService: {}, authService: validAuth, mediaUploadService: validUpload }),
                /WorkflowMediaService requires db\.workflowMedia with findByMedia method\./
            );
            assert.throws(
                () => new WorkflowMediaService({ db: { workflowMedia: {} }, storageService: {}, authService: validAuth, mediaUploadService: validUpload }),
                /WorkflowMediaService requires db\.workflowMedia with findByMedia method\./
            );
            assert.throws(
                () => new WorkflowMediaService({ db: { workflowMedia: { findByMedia: "not-a-func" } }, storageService: {}, authService: validAuth, mediaUploadService: validUpload }),
                /WorkflowMediaService requires db\.workflowMedia with findByMedia method\./
            );
        });

        it("rejects missing, empty, or anonymous userId with ValidationError (and discards uploaded keys)", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });

            for (const badUser of [null, undefined, "", "anonymous"]) {
                await assert.rejects(
                    () => h.service.attachMediaItems({
                        workflowId: wfId,
                        userId: badUser,
                        maxAllowed: null,
                        items: [{ kind: "uploaded", uploadedFile: { storageKey: `storage/key-${badUser}` } }]
                    }),
                    /userId is required and cannot be anonymous/
                );
            }
        });

        it("resolveOwnedSourceMedia rejects missing or anonymous userId with ValidationError", async () => {
            const h = createMockHarness();
            for (const badUser of [null, undefined, "", "anonymous"]) {
                await assert.rejects(
                    () => h.service.resolveOwnedSourceMedia({
                        mediaId: "00000000-0000-0000-0000-000000000010",
                        userId: badUser,
                    }),
                    /userId is required and cannot be anonymous/
                );
            }
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

        it("cross-tenant / source container isolation: rejects existing item when specified source workflowId does not link to media, discarding uploaded keys", async () => {
            const h = createMockHarness();
            const targetWfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(targetWfId, { id: targetWfId, user_id: "user-1", project_id: "proj-1" });

            const validSourceWfId = "00000000-0000-0000-0000-000000000002";
            h.workflows.set(validSourceWfId, { id: validSourceWfId, user_id: "user-1", project_id: "proj-1" });

            const unlinkedWfId = "00000000-0000-0000-0000-000000000099";
            h.workflows.set(unlinkedWfId, { id: unlinkedWfId, user_id: "user-1", project_id: "proj-1" });

            const ownedMediaId = "00000000-0000-0000-0000-000000000003";
            h.media.set(ownedMediaId, {
                id: ownedMediaId,
                user_id: "user-1",
                project_id: "proj-1",
                url: "https://storage.test/owned.png",
            });
            // Link media ONLY to validSourceWfId
            h.workflowMedia.push({
                workflow_id: validSourceWfId,
                media_id: ownedMediaId,
                role: "output",
                is_primary: true,
            });

            await assert.rejects(
                async () => {
                    await h.service.attachMediaItems({
                        workflowId: targetWfId,
                        userId: "user-1",
                        projectId: "proj-1",
                        role: "detail",
                        maxAllowed: 6,
                        items: [
                            {
                                kind: "uploaded",
                                uploadedFile: {
                                    storageKey: "user-1/uploads/test-isolation.png",
                                    url: "https://storage.test/test-isolation.png",
                                    width: 100,
                                    height: 100,
                                    format: "PNG",
                                },
                            },
                            {
                                kind: "existing",
                                mediaId: ownedMediaId,
                                workflowId: unlinkedWfId, // specified workflow does NOT have this media!
                            },
                        ],
                    });
                },
                (err) => {
                    assert.equal(err.statusCode, 404, "Must return 404 when media is not linked to specified source workflow");
                    return true;
                }
            );

            // Verify uploaded key was safely discarded
            const discardCall = h.callLog.find((c) => c.op === "mediaUploadService.discard");
            assert.ok(discardCall, "Must discard uploaded files on source workflow isolation failure");
            assert.deepEqual(discardCall.keys, ["user-1/uploads/test-isolation.png"]);

            // Verify zero attachments created in target workflow
            const targetLinks = h.workflowMedia.filter((m) => m.workflow_id === targetWfId);
            assert.equal(targetLinks.length, 0, "No media should be attached to target workflow");
        });

        it("SOURCE ISOLATION (i): mediaId of another user with NO workflowId throws 404, creates 0 rows, and discards uploaded keys", async () => {
            const h = createMockHarness();
            const targetWfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(targetWfId, { id: targetWfId, user_id: "user-1", project_id: "proj-1" });

            // Foreign media owned by attacker (no user_id on media row, linked to attacker's workflow)
            const foreignMediaId = "00000000-0000-0000-0000-000000000099";
            h.media.set(foreignMediaId, { id: foreignMediaId, url: "https://storage.test/attacker-media.png" });
            const attackerWfId = "00000000-0000-0000-0000-000000000088";
            h.workflows.set(attackerWfId, { id: attackerWfId, user_id: "attacker", project_id: "proj-attacker" });
            h.workflowMedia.push({ workflow_id: attackerWfId, media_id: foreignMediaId, role: "detail", is_primary: false });

            h.callLog.length = 0;
            await assert.rejects(
                async () => {
                    await h.service.attachMediaItems({
                        workflowId: targetWfId,
                        userId: "user-1",
                        projectId: "proj-1",
                        role: "detail",
                        maxAllowed: 6,
                        items: [
                            {
                                kind: "uploaded",
                                uploadedFile: {
                                    storageKey: "user-1/uploads/batch-i.png",
                                    url: "https://storage.test/batch-i.png",
                                    width: 100,
                                    height: 100,
                                    format: "PNG",
                                },
                            },
                            {
                                kind: "existing",
                                mediaId: foreignMediaId,
                                // NO workflowId provided
                            },
                        ],
                    });
                },
                (err) => {
                    assert.equal(err.statusCode, 404, "Foreign media with no workflowId must return 404");
                    return true;
                }
            );

            // Assert zero rows created in target workflow
            const targetLinks = h.workflowMedia.filter((m) => m.workflow_id === targetWfId);
            assert.equal(targetLinks.length, 0, "Zero rows must be created in target workflow");

            // Assert uploaded key was safely discarded
            const discardCall = h.callLog.find((c) => c.op === "mediaUploadService.discard");
            assert.ok(discardCall, "Uploaded keys must be discarded on foreign media rejection");
            assert.deepEqual(discardCall.keys, ["user-1/uploads/batch-i.png"]);
        });

        it("SOURCE ISOLATION (ii): own workflowId but mediaId is not linked to that workflow throws 404, creates 0 rows, and discards uploaded keys", async () => {
            const h = createMockHarness();
            const targetWfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(targetWfId, { id: targetWfId, user_id: "user-1", project_id: "proj-1" });

            // User owns source workflow A, but media is actually attached to foreign workflow B
            const ownSourceWfId = "00000000-0000-0000-0000-000000000002";
            h.workflows.set(ownSourceWfId, { id: ownSourceWfId, user_id: "user-1", project_id: "proj-1" });

            const foreignMediaId = "00000000-0000-0000-0000-000000000099";
            h.media.set(foreignMediaId, { id: foreignMediaId, url: "https://storage.test/attacker-media.png" });
            const attackerWfId = "00000000-0000-0000-0000-000000000088";
            h.workflows.set(attackerWfId, { id: attackerWfId, user_id: "attacker", project_id: "proj-attacker" });
            h.workflowMedia.push({ workflow_id: attackerWfId, media_id: foreignMediaId, role: "detail", is_primary: false });

            h.callLog.length = 0;
            await assert.rejects(
                async () => {
                    await h.service.attachMediaItems({
                        workflowId: targetWfId,
                        userId: "user-1",
                        projectId: "proj-1",
                        role: "detail",
                        maxAllowed: 6,
                        items: [
                            {
                                kind: "uploaded",
                                uploadedFile: {
                                    storageKey: "user-1/uploads/batch-ii.png",
                                    url: "https://storage.test/batch-ii.png",
                                    width: 100,
                                    height: 100,
                                    format: "PNG",
                                },
                            },
                            {
                                kind: "existing",
                                mediaId: foreignMediaId,
                                workflowId: ownSourceWfId, // Own workflow, but media is NOT linked to it!
                            },
                        ],
                    });
                },
                (err) => {
                    assert.equal(err.statusCode, 404, "Media not linked to own workflow must return 404");
                    return true;
                }
            );

            const targetLinks = h.workflowMedia.filter((m) => m.workflow_id === targetWfId);
            assert.equal(targetLinks.length, 0, "Zero rows must be created in target workflow");

            const discardCall = h.callLog.find((c) => c.op === "mediaUploadService.discard");
            assert.ok(discardCall, "Uploaded keys must be discarded on unlinked media rejection");
            assert.deepEqual(discardCall.keys, ["user-1/uploads/batch-ii.png"]);
        });

        it("SOURCE ISOLATION (iii): foreign workflowId (media is linked to it, but workflow belongs to another user) throws 404, creates 0 rows, and discards uploaded keys", async () => {
            const h = createMockHarness();
            const targetWfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(targetWfId, { id: targetWfId, user_id: "user-1", project_id: "proj-1" });

            // Attacker's workflow and media
            const attackerWfId = "00000000-0000-0000-0000-000000000088";
            h.workflows.set(attackerWfId, { id: attackerWfId, user_id: "attacker", project_id: "proj-attacker" });

            const foreignMediaId = "00000000-0000-0000-0000-000000000099";
            h.media.set(foreignMediaId, { id: foreignMediaId, url: "https://storage.test/attacker-media.png" });
            h.workflowMedia.push({ workflow_id: attackerWfId, media_id: foreignMediaId, role: "detail", is_primary: false });

            h.callLog.length = 0;
            await assert.rejects(
                async () => {
                    await h.service.attachMediaItems({
                        workflowId: targetWfId,
                        userId: "user-1",
                        projectId: "proj-1",
                        role: "detail",
                        maxAllowed: 6,
                        items: [
                            {
                                kind: "uploaded",
                                uploadedFile: {
                                    storageKey: "user-1/uploads/batch-iii.png",
                                    url: "https://storage.test/batch-iii.png",
                                    width: 100,
                                    height: 100,
                                    format: "PNG",
                                },
                            },
                            {
                                kind: "existing",
                                mediaId: foreignMediaId,
                                workflowId: attackerWfId, // Foreign workflowId! Media IS linked, but workflow belongs to attacker!
                            },
                        ],
                    });
                },
                (err) => {
                    assert.equal(err.statusCode, 404, "Foreign workflowId must return 404");
                    return true;
                }
            );

            const targetLinks = h.workflowMedia.filter((m) => m.workflow_id === targetWfId);
            assert.equal(targetLinks.length, 0, "Zero rows must be created in target workflow");

            const discardCall = h.callLog.find((c) => c.op === "mediaUploadService.discard");
            assert.ok(discardCall, "Uploaded keys must be discarded on foreign workflow rejection");
            assert.deepEqual(discardCall.keys, ["user-1/uploads/batch-iii.png"]);
        });

        it("fails closed when authService throws: logs at error level and throws 404 with no DB fallback", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });
            h.authService.verifyWorkflowOwnership = async () => {
                throw new Error("DB connection dropped in auth service");
            };
            // Even though wf in db has user_id matching userId, repository fallback is forbidden!
            h.db.workflows.getWorkflow = async () => ({ id: wfId, user_id: "user-1" });

            await assert.rejects(
                () => h.service.attachMediaItems({
                    workflowId: wfId,
                    userId: "user-1",
                    maxAllowed: null,
                    items: [{ kind: "existing", mediaId: "00000000-0000-0000-0000-000000000010" }]
                }),
                (err) => err instanceof CrudServiceError && err.statusCode === 404
            );
        });

        it("fails closed (404) if projectId is requested and source project cannot be determined or mismatches", async () => {
            const h = createMockHarness();
            const mediaId = "00000000-0000-0000-0000-000000000099";
            // Source media has no project_id and linked workflow has no project_id
            h.media.set(mediaId, { id: mediaId, status: "completed" });
            h.workflowMedia.push({ workflow_id: "wf-no-proj", media_id: mediaId, role: "detail" });
            h.workflows.set("wf-no-proj", { id: "wf-no-proj", user_id: "user-1" }); // no project_id

            await assert.rejects(
                () => h.service.resolveOwnedSourceMedia({
                    mediaId,
                    projectId: "proj-target",
                    userId: "user-1",
                }),
                (err) => err instanceof CrudServiceError && err.statusCode === 404
            );
        });

        it("resolves the source project through db.workflows.getWorkflow only (no findById probing)", async () => {
            const h = createMockHarness();
            const mediaId = "00000000-0000-0000-0000-000000000098";
            h.media.set(mediaId, { id: mediaId, status: "completed" });
            h.workflowMedia.push({ workflow_id: "wf-split", media_id: mediaId, role: "detail" });
            h.workflows.set("wf-split", { id: "wf-split", user_id: "user-1" }); // ownership via authService
            h.db.workflows.getWorkflow = async () => null; // the one lookup method finds no project
            // A second lookup method must never be consulted to find the project.
            h.db.workflows.findById = async (id) => ({ id, user_id: "user-1", project_id: "proj-target" });

            await assert.rejects(
                () => h.service.resolveOwnedSourceMedia({ mediaId, projectId: "proj-target", userId: "user-1" }),
                (err) => err instanceof CrudServiceError && err.statusCode === 404
            );
        });
    });

    describe("3. Attachment Success & Handle Contract", () => {
        it("attaches uploaded and existing items, marks first item primary, and returns complete rollbackHandle", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });

            const existingMediaId = "00000000-0000-0000-0000-000000000002";
            h.media.set(existingMediaId, { id: existingMediaId, user_id: "user-1", project_id: "proj-1", url: "https://storage.test/existing.png" });
            h.workflows.set("wf-prior", { id: "wf-prior", user_id: "user-1", project_id: "proj-1" });
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

        it("passes only valid media schema fields to db.media.createMedia (omitting user_id and format)", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1" });

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
                            storageKey: "user-1/uploads/upload1.png",
                            url: "https://storage.test/upload1.png",
                            width: 200,
                            height: 200,
                            format: "PNG",
                        },
                    },
                ],
            });

            const createCall = h.callLog.find((c) => c.op === "media.createMedia");
            assert.ok(createCall, "createMedia must be called");
            assert.equal("user_id" in createCall.fields, false, "user_id must NOT be passed to createMedia");
            assert.equal("format" in createCall.fields, false, "format must NOT be passed to createMedia");
            assert.equal(createCall.fields.project_id, "proj-1");
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
            h.workflows.set("wf-prior", { id: "wf-prior", user_id: "user-1", project_id: "proj-1" });
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

        it("auto-primary: empty workflow, no setPrimary, a later caller step fails -> link removed, media deleted, storage discarded, complete === true, no leftover is_primary", async () => {
            const h = createMockHarness();
            const wfId = "00000000-0000-0000-0000-000000000001";
            h.workflows.set(wfId, { id: wfId, user_id: "user-1", project_id: "proj-1", primary_media_id: null });
            h.storageFiles.add("user-1/uploads/auto_primary.png");

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

            assert.equal(res.attached[0].is_primary, true, "RPC auto-primary sets workflow_media.is_primary on the first link");
            const attachedMediaId = res.attached[0].media.id;
            assert.equal(h.workflows.get(wfId).primary_media_id, null, "RPC never writes workflows.primary_media_id");

            // A later caller step fails -> caller calls rollbackAttachedMedia
            const rbRes = await h.service.rollbackAttachedMedia(res.rollbackHandle);

            assert.equal(rbRes.complete, true, "Rollback must be complete");
            assert.deepEqual(rbRes.unlinkedMediaIds, [attachedMediaId], "Link must be removed");
            assert.equal(h.workflowMedia.some((w) => w.workflow_id === wfId), false, "No workflow_media row may remain");
            assert.equal(h.workflowMedia.some((w) => w.is_primary === true), false, "No leftover is_primary");
            assert.equal(h.media.has(attachedMediaId), false, "Media row must be deleted");
            assert.deepEqual(rbRes.discardedStorageKeys, ["user-1/uploads/auto_primary.png"], "Storage must be discarded");
            assert.equal(h.storageFiles.has("user-1/uploads/auto_primary.png"), false);
            assert.deepEqual(rbRes.skippedStorageKeys, []);
            assert.equal(h.workflows.get(wfId).primary_media_id, null);
        });

        it("fail-closed rollback: when db.workflows has neither conditionalRestorePrimaryMedia nor findById, fails closed and skips deletion/discard", async () => {
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
                            storageKey: "user-1/uploads/fail_closed.png",
                            url: "https://storage.test/fail_closed.png",
                            width: 100,
                            height: 100,
                            format: "PNG",
                        },
                    },
                ],
            });

            // Strip inspection methods from db.workflows
            delete h.db.workflows.conditionalRestorePrimaryMedia;
            delete h.db.workflows.findById;

            const errorLogs = [];
            const origBaseError = baseLogger.error;
            baseLogger.error = (obj, msg, ...rest) => {
                errorLogs.push({ obj, msg });
                return origBaseError.call(baseLogger, obj, msg, ...rest);
            };

            try {
                const rbRes = await h.service.rollbackAttachedMedia(res.rollbackHandle);
                assert.equal(rbRes.complete, false, "Must fail closed (complete: false) when primary cannot be confirmed");
                assert.equal(rbRes.primaryRestoreFailed, true, "primaryRestoreFailed must be true");
                assert.deepEqual(rbRes.skippedStorageKeys, ["user-1/uploads/fail_closed.png"], "Storage key must be preserved in skippedStorageKeys");

                const restoreErrorLog = errorLogs.find(
                    (l) => l.obj?.operation === "rollbackAttachedMedia:restorePrimary" && l.obj?.status === "error"
                );
                assert.ok(restoreErrorLog, "Must log at error level on primary restore match failure");
                assert.equal(restoreErrorLog.obj.workflowId, wfId);
                assert.equal(restoreErrorLog.obj.mediaId, res.attached[0].media.id);
                assert.equal(restoreErrorLog.obj.storageKey, "user-1/uploads/fail_closed.png");
            } finally {
                baseLogger.error = origBaseError;
            }
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
}

// ─── Source: workflowMediaDeleteOrphan.test.js ───
{
/**
 * WM-T5 & B4a: Delete, orphan rules, and sidecar preservation.
 *
 * Rules under test:
 *  1. workflow_media relation rows are unlinked BEFORE the media row is deleted.
 *  2. Storage file is deleted only when media has no remaining workflow_media links (orphan).
 *  3. Storage file is NOT deleted when media is still linked to other workflows (shared).
 *  4. Cross-tenant: deleteMedia returns 404 (via verifyMediaOwnership = false).
 *  5. B4a: Deleting the last media of a workflow preserves the workflow container if a character or element sidecar is attached.
 *  6. B4a: Explicit user DELETE of element or character still deletes the sidecar and releases/deletes its workflow container.
 *  7. B4a: ElementRepository and ElementService handle workflow_id = null safely without throwing or dropping entities.
 */
describe("WorkflowMediaService delete, orphan rules, and sidecar preservation (WM-T5 / B4a)", () => {

  /** Build a minimal service under test with injectable spy stubs */
  function makeService({
    mediaRec = { id: "media-1", url: "https://cdn.example.com/img.png" },
    countLinks = 0,       // remaining links AFTER unlink
    authorised = true,
  } = {}) {
    const calls = {
      unlink: [],
      deleteById: [],
      storageDelete: [],
      deleteGenRef: false,
      workflowFindById: [],
      workflowUpdatePrimary: [],
    };

    const db = {
      media: {
        findById: async () => mediaRec,
        deleteById: async (id) => { calls.deleteById.push(id); return { id }; },
        findByWorkflow: async () => [],
        client: () => ({
          from: () => ({
            delete: () => ({
              eq: () => Promise.resolve({ error: null }),
            }),
          }),
        }),
      },
      workflows: {
        findById: async (id) => { calls.workflowFindById.push(id); return { id, primary_media_id: "media-1" }; },
        deleteById: async () => ({}),
        updateFields: async () => ({}),
        updatePrimaryMedia: async (wfId, mid) => { calls.workflowUpdatePrimary.push({ wfId, mid }); return {}; },
      },
      workflowMedia: {
        findByMedia: async () => [{ workflow_id: "wf-1", media_id: "media-1" }],
        unlink: async (args) => { calls.unlink.push(args); },
        countLinksForMedia: async () => countLinks,
        unlinkAndReapOrphan: async ({ workflowId, mediaId } = {}) => {
          calls.unlink.push({ workflowId, mediaId });
          return {
            unlinked: true,
            is_orphan: countLinks === 0,
            storage_url: countLinks === 0 ? (mediaRec?.url || null) : null,
            remaining_links: countLinks,
            was_primary: false,
          };
        },
      },
    };

    const storageService = {
      deleteByUrl: async (url) => { calls.storageDelete.push(url); },
    };

    const authService = {
      verifyWorkflowOwnership: async () => true,
      verifyMediaOwnership: async () => authorised,
    };

    const service = new WorkflowMediaService({ db, storageService, authService, mediaUploadService: { discard: async () => ({}) } });
    const origDeleteMedia = service.deleteMedia.bind(service);
    service.deleteMedia = ({ workflowId = "wf-1", ...args }) => origDeleteMedia({ workflowId, ...args });
    return { service, calls };
  }

  it("unlinks workflow_media relation before deleting media row (orphaned media — 0 links)", async () => {
    const { service, calls } = makeService({ countLinks: 0 });

    const result = await service.deleteMedia({ mediaId: "media-1", userId: "user-1" });

    assert.equal(result.deleted, true);
    // unlink must have been called with the correct mediaId
    assert.equal(calls.unlink.length, 1);
    assert.equal(calls.unlink[0].mediaId, "media-1");
    // media row deleted
    assert.deepEqual(calls.deleteById, ["media-1"]);
    // storage deleted because orphaned (0 remaining links after unlink)
    assert.deepEqual(calls.storageDelete, ["https://cdn.example.com/img.png"]);
  });

  it("does NOT delete storage file when media still has relation links (shared media)", async () => {
    const { service, calls } = makeService({ countLinks: 2 });

    const result = await service.deleteMedia({ mediaId: "media-1", userId: "user-1" });

    assert.equal(result.deleted, false);
    // unlink still called (to remove the global association)
    assert.equal(calls.unlink.length, 1);
    // media row NOT deleted — still linked to other workflows
    assert.deepEqual(calls.deleteById, []);
    // storage NOT deleted — other workflows still reference this file
    assert.deepEqual(calls.storageDelete, []);
  });

  it("returns 404 (throws CrudServiceError) when media belongs to another user", async () => {
    const { service } = makeService({ authorised: false });

    await assert.rejects(
      () => service.deleteMedia({ mediaId: "media-1", userId: "attacker" }),
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.equal(err.errorCode, "NOT_FOUND");
        return true;
      }
    );
  });

  it("unlink is called before deleteById (ordering guarantee)", async () => {
    const order = [];
    const mediaRec = { id: "media-1", url: "https://cdn.example.com/img.png" };

    const db = {
      media: {
        findById: async () => mediaRec,
        deleteById: async (id) => { order.push("deleteById"); return { id }; },
        findByWorkflow: async () => [],
        client: () => ({
          from: () => ({ delete: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
        }),
      },
      workflows: {
        findById: async () => ({ id: "wf-1", primary_media_id: null }),
        deleteById: async () => ({}),
        updatePrimaryMedia: async () => ({}),
      },
      workflowMedia: {
        findByMedia: async () => [{ workflow_id: "wf-1", media_id: "media-1" }],
        unlink: async () => { order.push("unlink"); },
        countLinksForMedia: async () => 0,
        unlinkAndReapOrphan: async ({ workflowId, mediaId } = {}) => {
          order.push("unlink");
          return { unlinked: true, is_orphan: true, storage_url: "https://cdn.example.com/img.png", remaining_links: 0, was_primary: false };
        },
      },
    };

    const service = new WorkflowMediaService({
      db,
      storageService: { deleteByUrl: async () => {} },
      authService: { verifyMediaOwnership: async () => true, verifyWorkflowOwnership: async () => true },
      mediaUploadService: { discard: async () => ({}) },
    });

    await service.deleteMedia({ mediaId: "media-1", workflowId: "wf-1", userId: "user-1" });

    assert.equal(order[0], "unlink", "unlink must happen before deleteById");
    assert.equal(order[1], "deleteById");
  });

  it("Test 1 (B4a): deleting the last media unlinks without deleting workflow container when character or element sidecar is attached", async () => {
    const deletedWorkflowIds = [];
    const updatedPrimaryCalls = [];

    const db = {
      media: {
        findById: async (id) => ({ id, url: `https://cdn.example.com/${id}.png` }),
        deleteById: async (id) => ({ id }),
        findByWorkflow: async () => [], // 0 remaining media!
        client: () => ({
          from: () => ({ delete: () => ({ eq: async () => ({ error: null }) }) }),
        }),
      },
      workflows: {
        findById: async (wfId) => {
          if (wfId === "wf-char-1") return { id: "wf-char-1", primary_media_id: "m-char-last", workflow_type: "IMAGE" };
          if (wfId === "wf-elem-1") return { id: "wf-elem-1", primary_media_id: "m-elem-last", workflow_type: "IMAGE" };
          return { id: wfId, primary_media_id: null, workflow_type: "IMAGE" };
        },
        deleteById: async (wfId) => {
          deletedWorkflowIds.push(wfId);
          return {};
        },
        updatePrimaryMedia: async (wfId, mediaId) => {
          updatedPrimaryCalls.push({ wfId, mediaId });
          return {};
        },
      },
      characters: {
        findByCharacterId: async (wfId) => (wfId === "wf-char-1" ? { id: "char-1", workflow_id: "wf-char-1" } : null),
      },
      elements: {
        findByWorkflowId: async (wfId) => (wfId === "wf-elem-1" ? { id: "elem-1", workflow_id: "wf-elem-1" } : null),
      },
      workflowMedia: {
        findByMedia: async (mediaId) => {
          if (mediaId === "m-char-last") return [{ workflow_id: "wf-char-1", media_id: "m-char-last" }];
          if (mediaId === "m-elem-last") return [{ workflow_id: "wf-elem-1", media_id: "m-elem-last" }];
          return [{ workflow_id: "wf-plain-1", media_id: mediaId }];
        },
        unlink: async () => {},
        countLinksForMedia: async () => 0,
        unlinkAndReapOrphan: async ({ workflowId, mediaId } = {}) => {
          return {
            unlinked: true,
            is_orphan: true,
            storage_url: `https://cdn.example.com/${mediaId}.png`,
            remaining_links: 0,
            was_primary: true,
          };
        },
      },
    };

    const service = new WorkflowMediaService({
      db,
      storageService: { deleteByUrl: async () => {} },
      authService: { verifyMediaOwnership: async () => true, verifyWorkflowOwnership: async () => true },
      mediaUploadService: { discard: async () => ({}) },
    });

    // 1. Delete last media of character workflow -> container MUST NOT be deleted
    const charRes = await service.deleteMedia({ mediaId: "m-char-last", workflowId: "wf-char-1", userId: "user-1" });
    assert.equal(charRes.deleted, true);
    assert.equal(charRes.workflow_deleted, false, "Character workflow container must NOT be deleted when last media is removed");
    assert.equal(deletedWorkflowIds.includes("wf-char-1"), false);
    assert.deepEqual(updatedPrimaryCalls[0], { wfId: "wf-char-1", mediaId: null });

    // 2. Delete last media of element workflow -> container MUST NOT be deleted
    const elemRes = await service.deleteMedia({ mediaId: "m-elem-last", workflowId: "wf-elem-1", userId: "user-1" });
    assert.equal(elemRes.deleted, true);
    assert.equal(elemRes.workflow_deleted, false, "Element workflow container must NOT be deleted when last media is removed");
    assert.equal(deletedWorkflowIds.includes("wf-elem-1"), false);
    assert.deepEqual(updatedPrimaryCalls[1], { wfId: "wf-elem-1", mediaId: null });

    // 3. Delete last media of plain non-sidecar workflow -> container IS deleted
    const plainRes = await service.deleteMedia({ mediaId: "m-plain-last", workflowId: "wf-plain-1", userId: "user-1" });
    assert.equal(plainRes.deleted, true);
    assert.equal(plainRes.workflow_deleted, true);
    assert.equal(deletedWorkflowIds.includes("wf-plain-1"), true);
  });

  it("Test 2 (B4a): explicit user DELETE of element or character deletes the sidecar entity and releases its workflow container", async () => {
    const deletedElementIds = [];
    const deletedCharacterIds = [];
    const deletedWorkflowIds = [];

    const elemService = new ElementService({
      db: {
        elements: {
          resolveRecord: async (id) => ({ id, workflow_id: "wf-elem-del-1", name: "Prop" }),
          deleteById: async (id) => { deletedElementIds.push(id); return { id }; },
        },
        workflows: {
          deleteById: async (wfId) => { deletedWorkflowIds.push(wfId); },
        },
        media: {},
      },
      workflowService: {
        deleteWorkflow: async ({ workflowId }) => { deletedWorkflowIds.push(workflowId); },
      },
      mediaService: {},
    });

    const elemDeleted = await elemService.deleteElement("elem-del-1", "user-1");
    assert.deepEqual(elemDeleted, {
      workflowId: "wf-elem-del-1",
      unlinkedMediaCount: 0,
      deletedOrphanCount: 0,
      deletedMediaCount: 0,
      storageFailures: [],
    });
    assert.deepEqual(deletedElementIds, ["elem-del-1"]);
    assert.deepEqual(deletedWorkflowIds, ["wf-elem-del-1"]);

    const charService = new CharacterService({
      mediaService: {},
      db: {
        workflows: {
          getWorkflow: async (id) => ({ id, user_id: "user-1", project_id: "proj-1", workflow_type: "CHARACTER" }),
          deleteById: async (id) => { deletedWorkflowIds.push(id); },
        },
        characters: {
          findByCharacterId: async (id) => ({ id, workflow_id: id }),
          deleteById: async (id) => { deletedCharacterIds.push(id); },
        },
      },
      workflowService: {
        deleteWorkflow: async ({ workflowId }) => {
          deletedWorkflowIds.push(workflowId);
          return { ok: true };
        },
      },
    });

    const charDeleted = await charService.deleteCharacter({ characterId: "wf-char-del-1" });
    assert.equal(charDeleted.ok, true);
    assert.deepEqual(deletedCharacterIds, ["wf-char-del-1"]);
    assert.equal(deletedWorkflowIds.includes("wf-char-del-1"), true);
  });

  it("Test 3 (B4a): ElementRepository and ElementService handle workflow_id = null safely without throwing or dropping entities", async () => {
    const repo = new ElementRepository();
    assert.equal(await repo.findByWorkflowId(null), null);
    assert.equal(await repo.resolveRecord(null), null);

    let getPrimaryMediaCalled = false;
    let findByWorkflowCalled = false;
    let deleteWorkflowCalled = false;

    const service = new ElementService({
      db: {
        elements: {
          list: async () => [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Detached Element",
              description: "Still intact",
              workflow_id: null,
              source_images: [],
              tags: ["object"],
              create_time: "2026-01-01T00:00:00Z",
            },
          ],
          resolveRecord: async () => ({
            id: "11111111-1111-4111-8111-111111111111",
            name: "Detached Element",
            description: "Still intact",
            workflow_id: null,
            source_images: [],
            tags: ["object"],
          }),
          findById: async () => ({
            id: "11111111-1111-4111-8111-111111111111",
            name: "Detached Element",
            description: "Still intact",
            workflow_id: null,
          }),
          deleteById: async (id) => ({ id }),
        },
        workflows: {
          getPrimaryMediaUrl: async () => {
            getPrimaryMediaCalled = true;
            throw new Error("Should not call getPrimaryMediaUrl with null workflow_id");
          },
          deleteById: async () => {
            deleteWorkflowCalled = true;
          },
        },
        media: {
          findByWorkflow: async () => {
            findByWorkflowCalled = true;
            throw new Error("Should not call findByWorkflow with null workflow_id");
          },
        },
      },
      workflowService: {
        deleteWorkflow: async () => {
          deleteWorkflowCalled = true;
        },
      },
      mediaService: {},
    });

    const list = await service.listProjectElements("proj-1");
    assert.equal(list.length, 1, "Element with workflow_id = null must not be dropped from listProjectElements");
    assert.equal(list[0].workflow_id, null);
    assert.equal(list[0].primary_media_url, null);
    assert.equal(getPrimaryMediaCalled, false);

    const detail = await service.getElementById("11111111-1111-4111-8111-111111111111");
    assert.ok(detail);
    assert.equal(detail.workflow_id, null);
    assert.deepEqual(detail.reference_images, []);
    assert.equal(detail.primary_media_url, null);
    assert.equal(findByWorkflowCalled, false);

    const promptCtx = await service.getElementContextForPrompt({
      nameOrId: "11111111-1111-4111-8111-111111111111",
      projectId: "proj-1",
    });
    assert.ok(promptCtx);
    assert.deepEqual(promptCtx.referenceImageUrls, []);
    assert.equal(findByWorkflowCalled, false);

    const delRes = await service.deleteElement("11111111-1111-4111-8111-111111111111", "user-1");
    assert.deepEqual(delRes, {
      workflowId: "11111111-1111-4111-8111-111111111111",
      unlinkedMediaCount: 0,
      deletedOrphanCount: 0,
      deletedMediaCount: 0,
      storageFailures: [],
    });
    assert.equal(deleteWorkflowCalled, false, "deleteElement must not call deleteWorkflow when workflow_id is null");
  });

  it("T0 (STD-08/STD-10): ElementService.deleteElement deletes the workflow BEFORE deleting the element row, keeps the element row if deleteWorkflow fails, and throws if workflowService is missing", async () => {
    const callOrder = [];
    const elemService = new ElementService({
      db: {
        elements: {
          resolveRecord: async (id) => ({ id: "elem-order-1", workflow_id: "wf-elem-order-1", name: "Ordered Prop" }),
          deleteById: async (id) => {
            callOrder.push(`deleteElementRow:${id}`);
            return { id };
          },
        },
        workflows: {
          deleteById: async () => {
            callOrder.push("directDbWorkflowDelete");
          },
        },
        media: {},
      },
      workflowService: {
        deleteWorkflow: async ({ workflowId, userId }) => {
          callOrder.push(`deleteWorkflow:${workflowId}:${userId}`);
          return {
            workflowId,
            unlinkedMediaCount: 2,
            deletedOrphanCount: 1,
            deletedMediaCount: 1,
            storageFailures: [],
          };
        },
      },
      mediaService: {},
    });

    const result = await elemService.deleteElement("elem-order-1", "user-order-1");
    assert.deepEqual(callOrder, [
      "deleteWorkflow:wf-elem-order-1:user-order-1",
      "deleteElementRow:elem-order-1",
    ], "workflowService.deleteWorkflow must run BEFORE db.elements.deleteById");
    assert.deepEqual(result, {
      workflowId: "wf-elem-order-1",
      unlinkedMediaCount: 2,
      deletedOrphanCount: 1,
      deletedMediaCount: 1,
      storageFailures: [],
    });

    // Partial failure: deleteWorkflow rejects -> element row is KEPT
    let elementRowDeletedOnFailure = false;
    const failingElemService = new ElementService({
      db: {
        elements: {
          resolveRecord: async () => ({ id: "elem-fail-1", workflow_id: "wf-elem-fail-1", name: "Keep On Fail" }),
          deleteById: async () => {
            elementRowDeletedOnFailure = true;
          },
        },
        workflows: {},
        media: {},
      },
      workflowService: {
        deleteWorkflow: async () => {
          throw new Error("deleteWorkflow failed mid-reap");
        },
      },
      mediaService: {},
    });

    await assert.rejects(
      () => failingElemService.deleteElement("elem-fail-1", "user-1"),
      /deleteWorkflow failed mid-reap/
    );
    assert.equal(elementRowDeletedOnFailure, false, "element row must be kept when deleteWorkflow rejects");

    // Missing workflowService on non-null workflow_id -> throws and never falls back to db.workflows.deleteById
    let fallbackWorkflowDeleteCalled = false;
    let elementDeletedWithoutWfService = false;
    const noWfServiceElem = new ElementService({
      db: {
        elements: {
          resolveRecord: async () => ({ id: "elem-nowf-1", workflow_id: "wf-elem-nowf-1", name: "No Fallback" }),
          deleteById: async () => {
            elementDeletedWithoutWfService = true;
          },
        },
        workflows: {
          deleteById: async () => {
            fallbackWorkflowDeleteCalled = true;
          },
        },
        media: {},
      },
      workflowService: null,
      mediaService: {},
    });

    await assert.rejects(
      () => noWfServiceElem.deleteElement("elem-nowf-1", "user-1"),
      /ElementService\.deleteElement requires workflowService/
    );
    assert.equal(fallbackWorkflowDeleteCalled, false, "must never call db.workflows.deleteById fallback");
    assert.equal(elementDeletedWithoutWfService, false, "must not delete element row when workflowService is missing");
  });

  it("T0 (STD-08): CharacterService.deleteCharacter deletes the workflow BEFORE deleting the characters row, keeps the characters row if deleteWorkflow fails, and handles orphan characters with workflow_id = null", async () => {
    const callOrder = [];
    const charService = new CharacterService({
      mediaService: {},
      db: {
        workflows: {
          getWorkflow: async (id) => ({ id, user_id: "user-char-1", project_id: "proj-1", workflow_type: "CHARACTER" }),
        },
        characters: {
          findByCharacterId: async (id) => ({ id, user_id: "user-char-1", project_id: "proj-1", workflow_id: id }),
          deleteById: async (id) => {
            callOrder.push(`deleteCharacterRow:${id}`);
            return true;
          },
        },
      },
      workflowService: {
        deleteWorkflow: async ({ workflowId }) => {
          callOrder.push(`deleteWorkflow:${workflowId}`);
          return {
            workflowId,
            unlinkedMediaCount: 3,
            deletedOrphanCount: 2,
            deletedMediaCount: 2,
            storageFailures: [],
          };
        },
      },
    });

    const delResult = await charService.deleteCharacter({ characterId: "char-order-1" });
    assert.deepEqual(callOrder, [
      "deleteWorkflow:char-order-1",
      "deleteCharacterRow:char-order-1",
    ], "workflowService.deleteWorkflow must run BEFORE db.characters.deleteById");
    assert.deepEqual(delResult, {
      workflowId: "char-order-1",
      unlinkedMediaCount: 3,
      deletedOrphanCount: 2,
      deletedMediaCount: 2,
      storageFailures: [],
    });

    // Partial failure: deleteWorkflow rejects -> characters row is KEPT
    let charRowDeletedOnFailure = false;
    const failingCharService = new CharacterService({
      mediaService: {},
      db: {
        workflows: {},
        characters: {
          findByCharacterId: async (id) => ({ id, user_id: "user-char-1", project_id: "proj-1", workflow_id: id }),
          deleteById: async () => {
            charRowDeletedOnFailure = true;
          },
        },
      },
      workflowService: {
        deleteWorkflow: async () => {
          throw new Error("character workflow delete failed");
        },
      },
    });

    await assert.rejects(
      () => failingCharService.deleteCharacter({ characterId: "char-fail-1" }),
      /character workflow delete failed/
    );
    assert.equal(charRowDeletedOnFailure, false, "characters row must be kept when deleteWorkflow rejects");

    // Missing workflowService on non-null workflow_id -> throws and keeps characters row
    let charRowDeletedWithoutWfService = false;
    const noWfCharService = new CharacterService({
      mediaService: {},
      db: {
        workflows: {},
        characters: {
          findByCharacterId: async (id) => ({ id, user_id: "user-char-1", project_id: "proj-1", workflow_id: id }),
          deleteById: async () => {
            charRowDeletedWithoutWfService = true;
          },
        },
      },
      workflowService: null,
    });

    await assert.rejects(
      () => noWfCharService.deleteCharacter({ characterId: "char-nowf-1" }),
      /CharacterService\.deleteCharacter requires workflowService/
    );
    assert.equal(charRowDeletedWithoutWfService, false, "characters row must be kept when workflowService is missing");

    // Orphan character (workflow_id === null): deletes characters row directly without calling deleteWorkflow
    let orphanDeleteWorkflowCalled = false;
    const deletedOrphanCharIds = [];
    const orphanCharService = new CharacterService({
      mediaService: {},
      db: {
        workflows: {},
        characters: {
          findByCharacterId: async (id) => ({ id, user_id: "user-char-1", project_id: "proj-1", workflow_id: null }),
          deleteById: async (id) => {
            deletedOrphanCharIds.push(id);
            return true;
          },
        },
      },
      workflowService: {
        deleteWorkflow: async () => {
          orphanDeleteWorkflowCalled = true;
        },
      },
    });

    const orphanRes = await orphanCharService.deleteCharacter({ characterId: "char-orphan-1" });
    assert.equal(orphanDeleteWorkflowCalled, false, "deleteCharacter must not call deleteWorkflow when workflow_id is null");
    assert.deepEqual(deletedOrphanCharIds, ["char-orphan-1"]);
    assert.deepEqual(orphanRes, {
      workflowId: "char-orphan-1",
      unlinkedMediaCount: 0,
      deletedOrphanCount: 0,
      deletedMediaCount: 0,
      storageFailures: [],
    });
  });

  it("Test 1 (B4b): deleting a character's turnaround sheet sets primary_media_id to null while remaining detail photos remain unpinned", async () => {
    const primaryUpdates = [];
    const detailPhotos = [
      { id: "m-detail-1", url: "https://cdn.example.com/detail-1.png", step_id: "character_detail", role: "detail", mediaRole: "detail" },
      { id: "m-detail-2", url: "https://cdn.example.com/detail-2.png", step_id: "character_detail", role: "detail", mediaRole: "detail" },
    ];

    const db = {
      media: {
        findById: async (id) => ({ id, url: `https://cdn.example.com/${id}.png`, step_id: "character_sheet" }),
        deleteById: async (id) => ({ id }),
        findByWorkflow: async () => detailPhotos, // 2 detail photos remain after turnaround sheet is deleted
        client: () => ({
          from: () => ({ delete: () => ({ eq: async () => ({ error: null }) }) }),
        }),
      },
      workflows: {
        findById: async (wfId) => ({
          id: wfId,
          primary_media_id: "m-sheet-1",
          workflow_type: "CHARACTER_SHEET",
        }),
        deleteById: async () => ({}),
        updatePrimaryMedia: async (wfId, mediaId) => {
          primaryUpdates.push({ wfId, mediaId });
          return { id: wfId, primary_media_id: mediaId };
        },
      },
      characters: {
        findByCharacterId: async (wfId) => ({ id: wfId, workflow_id: wfId }),
      },
      workflowMedia: {
        findByMedia: async () => [{ workflow_id: "wf-char-sheet", media_id: "m-sheet-1", role: "sheet" }],
        unlink: async () => {},
        countLinksForMedia: async () => 0,
        unlinkAndReapOrphan: async () => ({ unlinked: true, is_orphan: true, storage_url: "https://cdn.example.com/m-sheet-1.png", remaining_links: 0, was_primary: true }),
      },
    };

    const service = new WorkflowMediaService({
      db,
      storageService: { deleteByUrl: async () => {} },
      authService: { verifyMediaOwnership: async () => true, verifyWorkflowOwnership: async () => true },
      mediaUploadService: { discard: async () => ({}) },
    });

    const result = await service.deleteMedia({ mediaId: "m-sheet-1", workflowId: "wf-char-sheet", userId: "user-1" });

    assert.equal(result.deleted, true);
    assert.equal(result.workflow_deleted, false);
    assert.equal(result.next_primary_media_id, null, "Must NOT auto-promote remaining detail photo to primary_media_id");
    assert.deepEqual(primaryUpdates, [{ wfId: "wf-char-sheet", mediaId: null }]);
  });

  it("Test 2 (B4b): deleting or detaching a pinned generation or upload sets primary_media_id to null without auto-promoting remaining media", async () => {
    const primaryUpdates = [];
    const fieldUpdates = [];
    const remainingVariations = [
      { id: "m-var-2", url: "https://cdn.example.com/var-2.png", step_id: "txt2img" },
      { id: "m-var-3", url: "https://cdn.example.com/var-3.png", step_id: "txt2img" },
    ];

    const db = {
      media: {
        findById: async (id) => ({
          id,
          url: `https://cdn.example.com/${id}.png`,
          status: "ready",
          project_id: "proj-1",
          user_id: "user-1",
          step_id: "txt2img",
        }),
        deleteById: async (id) => ({ id }),
        updateFields: async (id, fields) => ({ id, ...fields }),
        findByWorkflow: async () => remainingVariations,
        client: () => ({
          from: () => ({
            delete: () => ({ eq: async () => ({ error: null }) }),
          }),
        }),
      },
      workflows: {
        findById: async (wfId) => ({
          id: wfId,
          project_id: "proj-1",
          user_id: "user-1",
          primary_media_id: "m-pinned-1",
          workflow_type: "IMAGE",
        }),
        createWorkflow: async (payload) => ({ id: "wf-detached-new", ...payload }),
        deleteById: async () => ({}),
        updatePrimaryMedia: async (wfId, mediaId) => {
          primaryUpdates.push({ wfId, mediaId });
          return { id: wfId, primary_media_id: mediaId };
        },
        updateFields: async (wfId, fields) => {
          fieldUpdates.push({ wfId, fields });
          return { id: wfId, ...fields };
        },
      },
      workflowMedia: {
        findByMedia: async () => [{ workflow_id: "wf-gen-1", media_id: "m-pinned-1", role: "output" }],
        link: async () => ({}),
        unlink: async () => {},
        unlinkByWorkflow: async () => {},
        countLinksForMedia: async () => 0,
        unlinkAndReapOrphan: async () => ({ unlinked: true, is_orphan: true, storage_url: "https://cdn.example.com/m-pinned-1.png", remaining_links: 0, was_primary: true }),
      },
    };

    const service = new WorkflowMediaService({
      db,
      storageService: { deleteByUrl: async () => {} },
      authService: { verifyMediaOwnership: async () => true, verifyWorkflowOwnership: async () => true },
      mediaUploadService: { discard: async () => ({}) },
    });

    // 1. deleteMedia on pinned generation/upload variation -> sets primary_media_id to null
    const deleteRes = await service.deleteMedia({ mediaId: "m-pinned-1", workflowId: "wf-gen-1", userId: "user-1" });
    assert.equal(deleteRes.deleted, true);
    assert.equal(deleteRes.workflow_deleted, false);
    assert.equal(deleteRes.next_primary_media_id, null, "Must NOT auto-promote m-var-2 to primary_media_id on delete");
    assert.deepEqual(primaryUpdates, [{ wfId: "wf-gen-1", mediaId: null }]);

    // 2. detachMedia on pinned generation/upload variation -> clears old workflow primary pin without auto-promoting
    primaryUpdates.length = 0;
    await service.detachMedia({ mediaId: "m-pinned-1", userId: "user-1" });
    const oldWfPrimaryClear = primaryUpdates.find((u) => u.wfId === "wf-gen-1");
    assert.ok(oldWfPrimaryClear, "Old workflow primary pin must be cleared when detaching pinned media");
    assert.equal(oldWfPrimaryClear.mediaId, null, "Old workflow primary pin must be nullified, never auto-promoted");
  });

  it("Test 1 (B4c): reference-counted unlinking in ElementMediaService.removeReferenceMedia and CharacterMediaService.removeDetailMedia deletes DB row and storage ONLY when countLinksForMedia === 0", async () => {
    const elemUnlinkCalls = [];
    const elemDeletedIds = [];
    const elemStorageDeletes = [];
    const elemOrder = [];

    let elemLinkCount = 1; // Shared at first
    const elemMediaService = new ElementMediaService({
      mediaUploadService: { upload: async () => ({ uploaded: [] }), discard: async () => ({}) },
      workflowMediaService: { attachMediaItems: async () => ({ attached: [] }) },
      authService: { verifyWorkflowOwnership: async () => true },
      db: {
        elements: {
          resolveRecord: async () => ({
            id: "11111111-1111-4111-8111-111111111111",
            workflow_id: "wf-elem-ref",
            source_images: ["m-elem-ref-1", "m-elem-ref-2"],
          }),
          update: async () => ({}),
        },
        workflows: {
          findById: async () => ({ id: "wf-elem-ref", primary_media_id: "m-elem-ref-1" }),
          updatePrimaryMedia: async () => ({}),
        },
        media: {
          findById: async (id) => ({ id, url: `https://cdn.example.com/${id}.png` }),
          deleteById: async (id) => {
            elemOrder.push("deleteById");
            elemDeletedIds.push(id);
          },
        },
        workflowMedia: {
          unlink: async (args) => {
            elemOrder.push("unlink");
            elemUnlinkCalls.push(args);
          },
          unlinkAndReapOrphan: async (args) => {
            elemOrder.push("unlink");
            elemUnlinkCalls.push(args);
            return {
              unlinked: true,
              is_orphan: elemLinkCount === 0,
              storage_url: `https://cdn.example.com/${args.mediaId}.png`,
            };
          },
          countLinksForMedia: async () => elemLinkCount,
        },
      },
      storageService: {
        deleteByUrl: async (url) => {
          elemOrder.push("deleteByUrl");
          elemStorageDeletes.push(url);
        },
      },
    });

    // Case A: Shared media (countLinksForMedia = 1) -> unlinks, does NOT delete media row or storage
    await elemMediaService.removeReferenceMedia({
      elementId: "11111111-1111-4111-8111-111111111111",
      mediaId: "m-elem-ref-1",
      userId: "user-1",
    });
    assert.equal(elemUnlinkCalls.length, 1);
    assert.deepEqual(elemDeletedIds, [], "Must NOT delete media row when remainingLinks > 0");
    assert.deepEqual(elemStorageDeletes, [], "Must NOT delete storage file when remainingLinks > 0");

    // Case B: Orphaned media (countLinksForMedia = 0) -> unlinks, deletes media row FIRST, then deletes storage
    elemLinkCount = 0;
    elemOrder.length = 0;
    await elemMediaService.removeReferenceMedia({
      elementId: "11111111-1111-4111-8111-111111111111",
      mediaId: "m-elem-ref-2",
      userId: "user-1",
    });
    assert.deepEqual(elemDeletedIds, ["m-elem-ref-2"]);
    assert.deepEqual(elemStorageDeletes, ["https://cdn.example.com/m-elem-ref-2.png"]);
    assert.deepEqual(elemOrder, ["unlink", "deleteById", "deleteByUrl"], "Storage delete must run post-DB-delete");

    // Case C: CharacterMediaService.removeDetailMedia with countLinksForMedia = 0 and db.media.deleteById
    const charOrder = [];
    const charMediaService = new CharacterMediaService({
      mediaUploadService: { upload: async () => ({}) },
      workflowMediaService: { attachMediaItems: async () => ({}) },
      authService: { verifyWorkflowOwnership: async () => true },
      db: {
        workflows: {
          getWorkflow: async (id) => ({ id, primary_media_id: "m-char-det-1" }),
          updatePrimaryMedia: async () => ({}),
        },
        media: {
          findById: async (id) => ({ id, url: "https://cdn.example.com/char-det-1.png", step_id: "character_detail", role: "detail" }),
          deleteById: async () => { charOrder.push("deleteById"); },
        },
        workflowMedia: {
          findByMedia: async () => [{ workflow_id: "wf-char-1", media_id: "m-char-det-1", role: "detail" }],
          unlink: async () => { charOrder.push("unlink"); },
          countLinksForMedia: async () => 0,
        },
      },
      storageService: {
        deleteByUrl: async () => { charOrder.push("deleteByUrl"); },
      },
    });

    await charMediaService.removeDetailMedia({
      characterId: "wf-char-1",
      mediaId: "m-char-det-1",
      userId: "user-1",
    });
    assert.deepEqual(charOrder, ["unlink", "deleteById", "deleteByUrl"]);
  });

  it("Test 2 (B4c): scanOrphanMediaDryRun lists candidate orphan media IDs and sanitized storage paths without performing deletions", async () => {
    let deleteByIdCalled = false;
    let deleteByUrlCalled = false;

    const candidateMedia = [
      {
        id: "m-linked-1",
        url: "https://project.supabase.co/storage/v1/object/sign/bucket/u1/linked.png?token=secret-jwt-linked",
        project_id: "proj-1",
      },
      {
        id: "m-orphan-1",
        url: "https://project.supabase.co/storage/v1/object/sign/bucket/u1/orphan-1.png?token=secret-jwt-orphan-1&sig=xyz",
        project_id: "proj-1",
      },
      {
        id: "m-orphan-2",
        url: "character-sheets/u1/c1/orphan-2.png?token=secret-jwt-orphan-2",
        project_id: "proj-1",
      },
    ];

    const service = new WorkflowMediaService({
      db: {
        media: {
          listAll: async () => candidateMedia,
          deleteById: async () => { deleteByIdCalled = true; },
        },
        workflowMedia: {
          countLinksForMedia: async (mediaId) => (mediaId === "m-linked-1" ? 2 : 0),
          findByMedia: async () => [],
        },
      },
      storageService: {
        deleteByUrl: async () => { deleteByUrlCalled = true; },
      },
      authService: { verifyWorkflowOwnership: async () => true, verifyMediaOwnership: async () => true },
      mediaUploadService: { discard: async () => ({}) },
    });

    const report = await service.scanOrphanMediaDryRun({ projectId: "proj-1" });

    assert.equal(report.dryRun, true);
    assert.equal(report.count, 2);
    assert.deepEqual(report.orphanMediaIds, ["m-orphan-1", "m-orphan-2"]);
    assert.deepEqual(report.orphanStoragePaths, [
      "/storage/v1/object/sign/bucket/u1/orphan-1.png",
      "character-sheets/u1/c1/orphan-2.png",
    ]);
    for (const p of report.orphanStoragePaths) {
      assert.equal(p.includes("token="), false, "Sanitized storage path must never contain signed URL tokens");
      assert.equal(p.includes("secret-jwt"), false, "Sanitized storage path must never leak signed URL secrets");
    }
    assert.equal(deleteByIdCalled, false, "Dry-run sweep must NEVER delete media DB rows");
    assert.equal(deleteByUrlCalled, false, "Dry-run sweep must NEVER delete storage binaries");
  });

  it("Test 3 (B4c): sanitizeStoragePath strips signed URL query tokens and storage deletion errors never leak signed URLs", async () => {
    const signedUrl = "https://project.supabase.co/storage/v1/object/sign/media-bucket/user-1/img.png?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret&Expires=1999999999";
    const sanitized = sanitizeStoragePath(signedUrl);

    assert.equal(sanitized, "/storage/v1/object/sign/media-bucket/user-1/img.png");
    assert.equal(sanitized.includes("token="), false);
    assert.equal(sanitized.includes("eyJ"), false);

    const { service } = makeService({
      mediaRec: { id: "media-signed-err", url: signedUrl },
      countLinks: 0,
    });
    service.storageService = {
      deleteByUrl: async () => {
        throw new Error("Storage bucket temporarily unavailable");
      },
    };

    const res = await service.deleteMedia({ mediaId: "media-signed-err", userId: "user-1" });
    assert.equal(res.deleted, true);
  });
});
}

// ─── Source: workflowMediaRelease.test.js ───
{
function createHarness() {
  const mediaRows = [
    { id: "m-exclusive", url: "https://cdn.example/exclusive.png" },
    { id: "m-shared", url: "https://cdn.example/shared.png" },
  ];
  const relationRows = [
    { workflow_id: "wf-1", media_id: "m-exclusive", role: "output" },
    { workflow_id: "wf-1", media_id: "m-shared", role: "output" },
    { workflow_id: "wf-2", media_id: "m-shared", role: "input" },
  ];
  const workflows = [
    { id: "wf-1", project_id: "proj-1", primary_media_id: "m-exclusive", folder_id: "folder-1" },
    { id: "wf-3", project_id: "proj-1", primary_media_id: null, folder_id: "folder-1-child" },
    { id: "wf-keep", project_id: "proj-1", primary_media_id: null, folder_id: "folder-other" },
  ];
  const deletedStorageUrls = [];
  const deletedMediaIds = [];
  const deletedWorkflowIds = [];

  const db = {
    media: {
      findByWorkflow: async (workflowId) => {
        const linkedIds = new Set(
          relationRows.filter((r) => r.workflow_id === workflowId).map((r) => r.media_id)
        );
        return mediaRows.filter((m) => linkedIds.has(m.id));
      },
      findById: async (id) => mediaRows.find((m) => m.id === id) || null,
      updateFields: async (id, fields) => {
        const row = mediaRows.find((m) => m.id === id);
        if (!row) return null;
        Object.assign(row, fields);
        return row;
      },
      deleteById: async (id) => {
        const idx = mediaRows.findIndex((m) => m.id === id);
        if (idx === -1) return null;
        deletedMediaIds.push(id);
        const [removed] = mediaRows.splice(idx, 1);
        return removed;
      },
      client: () => ({
        from: () => ({
          delete: () => ({
            eq: async () => ({ error: null }),
          }),
        }),
      }),
    },
        workflowMedia: {
      unlink: async ({ workflowId, mediaId } = {}) => {
        for (let i = relationRows.length - 1; i >= 0; i -= 1) {
          const matchWf = !workflowId || relationRows[i].workflow_id === workflowId;
          const matchMedia = !mediaId || relationRows[i].media_id === mediaId;
          if (matchWf && matchMedia) relationRows.splice(i, 1);
        }
      },
      unlinkAndReapOrphan: async ({ workflowId, mediaId } = {}) => {
        const idx = relationRows.findIndex(
          (r) => r.workflow_id === workflowId && r.media_id === mediaId
        );
        if (idx === -1) {
          return { unlinked: false, is_orphan: false, storage_url: null, remaining_links: relationRows.filter((r) => r.media_id === mediaId).length };
        }
        relationRows.splice(idx, 1);
        const remaining = relationRows.filter((r) => r.media_id === mediaId).length;
        const mediaRec = mediaRows.find((m) => m.id === mediaId);
        return {
          unlinked: true,
          is_orphan: remaining === 0,
          storage_url: remaining === 0 ? (mediaRec?.url || null) : null,
          remaining_links: remaining,
          was_primary: false,
        };
      },
      unlinkByWorkflow: async (workflowId) => {
        for (let i = relationRows.length - 1; i >= 0; i -= 1) {
          if (relationRows[i].workflow_id === workflowId) relationRows.splice(i, 1);
        }
      },
      unlinkByMedia: async (mediaId) => {
        for (let i = relationRows.length - 1; i >= 0; i -= 1) {
          if (relationRows[i].media_id === mediaId) relationRows.splice(i, 1);
        }
      },
      countLinksForMedia: async (mediaId) =>
        relationRows.filter((r) => r.media_id === mediaId).length,
      findByMedia: async (mediaId) => relationRows.filter((r) => r.media_id === mediaId),
    },
    workflows: {
      findById: async (id) => workflows.find((w) => w.id === id) || null,
      updateFields: async (id, fields) => {
        const row = workflows.find((w) => w.id === id);
        if (!row) return null;
        Object.assign(row, fields);
        return row;
      },
      updatePrimaryMedia: async (id, mediaId) => {
        const row = workflows.find((w) => w.id === id);
        if (!row) return null;
        row.primary_media_id = mediaId;
        return row;
      },
      listIdsByFolderIds: async ({ folderIds, projectId } = {}) =>
        workflows
          .filter((w) => (!projectId || w.project_id === projectId) && folderIds?.includes(w.folder_id))
          .map((w) => w.id),
      clearFolderIds: async ({ workflowIds = [], folderIds = [], projectId } = {}) => {
        const unlinked = [];
        for (const wf of workflows) {
          if (
            (!projectId || wf.project_id === projectId) &&
            workflowIds.includes(wf.id) &&
            folderIds.includes(wf.folder_id)
          ) {
            wf.folder_id = null;
            unlinked.push(wf.id);
          }
        }
        return unlinked;
      },
      deleteById: async (id) => {
        deletedWorkflowIds.push(id);
        const idx = workflows.findIndex((w) => w.id === id);
        if (idx !== -1) workflows.splice(idx, 1);
      },
      client: () => ({
        from: () => ({
          select: () => ({
            in: async () => ({ data: workflows, error: null }),
          }),
        }),
      }),
    },
  };

  const storageService = {
    deleteByUrl: async (url) => {
      deletedStorageUrls.push(url);
      return { ok: true };
    },
    deleteByUrls: async (urls) => {
      deletedStorageUrls.push(...urls);
      return { failures: [] };
    },
  };

  const mediaService = new WorkflowMediaService({
    db,
    storageService,
    authService: {
      verifyWorkflowOwnership: async () => true,
      verifyWorkflowOwnershipBulk: async (ids) => ids,
      verifyMediaOwnership: async () => true,
    },
    mediaUploadService: { discard: async () => ({}) },
  });

  const workflowService = new WorkflowService({
    db,
    storageService,
    mediaService,
    authService: {
      verifyWorkflowOwnership: async () => true,
      verifyWorkflowOwnershipBulk: async (ids) => ids,
      verifyMediaOwnership: async () => true,
    },
    mediaUploadService: { discard: async () => ({}) },
  });

  return {
    db,
    workflows,
    mediaRows,
    relationRows,
    mediaService,
    workflowService,
    deletedStorageUrls,
    deletedMediaIds,
    deletedWorkflowIds,
  };
}

describe("Workflow media unlink vs delete", () => {
  let harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("deleteWorkflow unlinks media and only deletes orphans with no remaining workflow", async () => {
    const result = await harness.workflowService.deleteWorkflow({
      workflowId: "wf-1",
      userId: "user-1",
    });

    assert.equal(harness.deletedWorkflowIds.includes("wf-1"), true);
    assert.equal(harness.deletedMediaIds.includes("m-exclusive"), true);
    assert.equal(harness.deletedMediaIds.includes("m-shared"), false);
    assert.equal(harness.mediaRows.some((m) => m.id === "m-shared"), true);
    assert.equal(
      harness.relationRows.some((r) => r.media_id === "m-shared" && r.workflow_id === "wf-2"),
      true
    );
    assert.equal(harness.relationRows.some((r) => r.workflow_id === "wf-1"), false);
    assert.equal(harness.deletedStorageUrls.includes("https://cdn.example/exclusive.png"), true);
    assert.equal(harness.deletedStorageUrls.includes("https://cdn.example/shared.png"), false);
    assert.equal(result.deletedOrphanCount, 1);
    assert.equal(result.unlinkedMediaCount, 2);
  });

  it("listOwnedWorkflowIdsInFolders and unlinkWorkflowsFromFolders detach owned workflows in target folders without deleting workflows or media", async () => {
    const ownedIds = await harness.workflowService.listOwnedWorkflowIdsInFolders({
      folderIds: ["folder-1", "folder-1-child"],
      userId: "user-1",
      projectId: "proj-1",
    });

    assert.deepEqual(ownedIds.slice().sort(), ["wf-1", "wf-3"]);

    const result = await harness.workflowService.unlinkWorkflowsFromFolders({
      workflowIds: ownedIds,
      folderIds: ["folder-1", "folder-1-child"],
      userId: "user-1",
      projectId: "proj-1",
    });

    assert.deepEqual(result.workflow_ids.slice().sort(), ["wf-1", "wf-3"]);
    assert.equal(result.count, 2);

    // Workflows and media are preserved (NOT permanently deleted)
    assert.equal(harness.deletedWorkflowIds.length, 0);
    assert.equal(harness.deletedMediaIds.length, 0);
    assert.equal(harness.deletedStorageUrls.length, 0);
    assert.equal(harness.workflows.find((w) => w.id === "wf-1").folder_id, null);
    assert.equal(harness.workflows.find((w) => w.id === "wf-3").folder_id, null);
    assert.equal(harness.workflows.find((w) => w.id === "wf-keep").folder_id, "folder-other");
  });

  it("listOwnedWorkflowIdsInFolders and unlinkWorkflowsFromFolders fail closed with 404 when ownership check fails", async () => {
    harness.workflowService.authService.verifyWorkflowOwnershipBulk = async () => null;

    await assert.rejects(
      () =>
        harness.workflowService.listOwnedWorkflowIdsInFolders({
          folderIds: ["folder-1"],
          userId: "user-foreign",
          projectId: "proj-1",
        }),
      (err) => err.statusCode === 404 && err.errorCode === "NOT_FOUND"
    );

    await assert.rejects(
      () =>
        harness.workflowService.unlinkWorkflowsFromFolders({
          workflowIds: ["wf-1"],
          folderIds: ["folder-1"],
          userId: "user-foreign",
          projectId: "proj-1",
        }),
      (err) => err.statusCode === 404 && err.errorCode === "NOT_FOUND"
    );

    assert.equal(harness.workflows.find((w) => w.id === "wf-1").folder_id, "folder-1");
  });

  it("deleteMedia removes the media record and storage, not only the relation", async () => {
    const result = await harness.mediaService.deleteMedia({
      workflowId: "wf-1",
      mediaId: "m-exclusive",
      userId: "user-1",
    });

    assert.equal(result.deleted, true);
    assert.equal(harness.deletedMediaIds.includes("m-exclusive"), true);
    assert.equal(harness.relationRows.some((r) => r.media_id === "m-exclusive"), false);
    assert.equal(harness.deletedStorageUrls.includes("https://cdn.example/exclusive.png"), true);
  });
});
}

// ─── Source: workflowMediaScopedDeletionBoundary.test.js ───
{
describe("Task A: Scoped Media Deletion & Shared-Media Lifecycle Boundary Tests", () => {
  beforeEach(() => {
    WorkflowMediaRepository.enableTestMemoryFallback();
  });

  it("TEST 1: deleteMedia for an owned media without workflow context fails safely with a 400 client error", async () => {
    let statusCode = null;
    let jsonPayload = null;

    const req = {
      params: { media_id: "media-shared-1" },
      query: {},
      body: {},
      user: { id: "user-1" },
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        jsonPayload = payload;
        return this;
      },
    };

    // The media is owned by the caller; without this override the fail-closed
    // authorization service would deny a media row that does not exist in the
    // test database, masking the workflow-context validation under test.
    const origAuth = workflowService.authService?.verifyMediaOwnership;
    try {
      if (workflowService?.authService) {
        workflowService.authService.verifyMediaOwnership = async () => true;
      }
      await workflowsControllerDeleteMedia(req, res);
    } finally {
      if (origAuth) {
        workflowService.authService.verifyMediaOwnership = origAuth;
      }
    }

    assert.equal(statusCode, 400, "Must return HTTP 400 when workflow context is omitted");
    assert.match(String(jsonPayload?.message || ""), /workflow.*required/i, "Error must state that workflow context is required");
  });

  it("TEST 1b: deleteMedia for a nonexistent media returns 404 (fail-closed, no workflow-context leak)", async () => {
    let statusCode = null;
    let jsonPayload = null;

    const req = {
      params: { media_id: "media-shared-1" },
      query: {},
      body: {},
      user: { id: "user-1" },
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        jsonPayload = payload;
        return this;
      },
    };

    await workflowsControllerDeleteMedia(req, res);

    assert.equal(statusCode, 404, "Unknown media must be denied as not found (fail-closed)");
    assert.equal(jsonPayload?.ok, false);
  });

  it("TEST 2: deleteMedia for cross-tenant / unauthorized workflow returns 404 without information leak", async () => {
    let statusCode = null;
    let jsonPayload = null;

    const req = {
      params: { media_id: "media-shared-1" },
      query: { workflow_id: "wf-tenant-b" },
      body: {},
      user: { id: "attacker-tenant-a" },
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        jsonPayload = payload;
        return this;
      },
    };

    await workflowsControllerDeleteMedia(req, res);

    assert.equal(statusCode, 404, "Cross-tenant access must return HTTP 404");
    assert.equal(jsonPayload?.ok, false);
  });

  it("TEST 3: Removing media from workflow A preserves association in workflow B and preserves storage asset", async () => {
    const repo = new WorkflowMediaRepository();
    const mediaId = "media-shared-123";
    const wfA = "wf-user1-a";
    const wfB = "wf-user1-b";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-shared-123.png";

    // Link media to both workflows
    await repo.linkMedia({ workflowId: wfA, mediaId, role: "output" });
    await repo.linkMedia({ workflowId: wfB, mediaId, role: "reference" });

    assert.equal(await repo.countLinksForMedia(mediaId), 2, "Media must be linked to 2 workflows initially");

    const deletedStorage = [];
    const mediaStore = new Map([[mediaId, { id: mediaId, url: storageUrl }]]);

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async (id) => mediaStore.get(id) || null,
        deleteById: async (id) => {
          mediaStore.delete(id);
          return { id };
        },
        findByWorkflow: async (wfId) => {
          const links = await repo.findByWorkflow(wfId);
          return links.map((l) => ({ id: l.media_id, workflow_id: wfId }));
        },
      },
      workflows: {
        findById: async (wfId) => ({ id: wfId, primary_media_id: null }),
        deleteById: async () => {},
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyWorkflowOwnership: async (wfId, uId) => uId === userId && (wfId === wfA || wfId === wfB),
      verifyMediaOwnership: async (mId, uId) => uId === userId && mId === mediaId,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    // Delete from Workflow A
    const result = await service.deleteMedia({
      mediaId,
      workflowId: wfA,
      userId,
    });

    assert.equal(result.deleted, false, "Media row must NOT be deleted while Workflow B still links to it");
    assert.equal(await repo.countLinksForMedia(mediaId), 1, "Exactly one association (Workflow B) must remain");
    
    const remainingWfB = await repo.findByWorkflow(wfB);
    assert.equal(remainingWfB.some((r) => r.media_id === mediaId), true, "Workflow B must still be linked to media");

    const remainingWfA = await repo.findByWorkflow(wfA);
    assert.equal(remainingWfA.some((r) => r.media_id === mediaId), false, "Workflow A association must be removed");

    assert.equal(mediaStore.has(mediaId), true, "Media database row must be preserved");
    assert.equal(deletedStorage.length, 0, "Supabase storage object must NOT be deleted");
  });

  it("TEST 4: Removing the last remaining association deletes media row and storage asset", async () => {
    const repo = new WorkflowMediaRepository();
    const mediaId = "media-final-unlink";
    const wfA = "wf-only-one";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-final.png";

    await repo.linkMedia({ workflowId: wfA, mediaId, role: "output" });
    assert.equal(await repo.countLinksForMedia(mediaId), 1);

    const deletedStorage = [];
    const mediaStore = new Map([[mediaId, { id: mediaId, url: storageUrl }]]);

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async (id) => mediaStore.get(id) || null,
        deleteById: async (id) => {
          mediaStore.delete(id);
          return { id };
        },
        findByWorkflow: async () => [],
      },
      workflows: {
        findById: async (wfId) => ({ id: wfId, primary_media_id: null }),
        deleteById: async () => {},
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyWorkflowOwnership: async (wfId, uId) => uId === userId && wfId === wfA,
      verifyMediaOwnership: async (mId, uId) => uId === userId && mId === mediaId,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    const result = await service.deleteMedia({
      mediaId,
      workflowId: wfA,
      userId,
    });

    assert.equal(result.deleted, true, "Media row must be reported as deleted");
    assert.equal(await repo.countLinksForMedia(mediaId), 0, "No associations remain");
    assert.equal(mediaStore.has(mediaId), false, "Media database record must be deleted");
    assert.deepEqual(deletedStorage, [storageUrl], "Storage object must be deleted for orphan");
  });
});
}

// ─── Media Status Deletion Guard (processing rejection & failed hard-delete) ───
{
describe("Media Status Deletion Guard in WorkflowMediaService & WorkflowService", () => {
  function makeStatusGuardHarness({
    mediaById = {},
    workflowMediaByWf = {},
    useBatchStatusLookup = false,
  } = {}) {
    const calls = {
      findByIdSelects: [],
      unlinkAndReap: [],
      mediaDeleteById: [],
      storageDeleteByUrl: [],
      workflowUpdateFields: [],
      workflowUpdatePrimary: [],
      workflowDeleteById: [],
    };

    const mediaStore = new Map(Object.entries(mediaById).map(([k, v]) => [k, { ...v }]));
    const wfMediaStore = new Map(
      Object.entries(workflowMediaByWf).map(([wfId, list]) => [wfId, list.map((m) => ({ ...m }))])
    );

    const db = {
      media: {
        findById: async (id, select) => {
          calls.findByIdSelects.push({ id, select });
          const m = mediaStore.get(id);
          return m ? { ...m } : null;
        },
        deleteById: async (id) => {
          calls.mediaDeleteById.push(id);
          mediaStore.delete(id);
          return { id };
        },
        findByWorkflow: async (wfId) => {
          return (wfMediaStore.get(wfId) || []).map((m) => ({ ...m }));
        },
      },
      workflows: {
        findById: async (wfId) => ({ id: wfId, primary_media_id: null, workflow_type: "GENERATION" }),
        updateFields: async (wfId, fields) => {
          calls.workflowUpdateFields.push({ wfId, fields });
          return { id: wfId, ...fields };
        },
        updatePrimaryMedia: async (wfId, mediaId) => {
          calls.workflowUpdatePrimary.push({ wfId, mediaId });
          return {};
        },
        deleteById: async (wfId) => {
          calls.workflowDeleteById.push(wfId);
          return true;
        },
      },
      workflowMedia: {
        findByMedia: async (mediaId) => {
          const links = [];
          for (const [wfId, list] of wfMediaStore.entries()) {
            if (list.some((m) => m.id === mediaId)) {
              links.push({ workflow_id: wfId, media_id: mediaId });
            }
          }
          return links;
        },
        findByWorkflow: async (wfId) => (wfMediaStore.get(wfId) || []).map((m) => ({ workflow_id: wfId, media_id: m.id })),
        unlinkAndReapOrphan: async ({ workflowId, mediaId }) => {
          calls.unlinkAndReap.push({ workflowId, mediaId });
          const list = wfMediaStore.get(workflowId) || [];
          const removed = list.find((m) => m.id === mediaId);
          wfMediaStore.set(workflowId, list.filter((m) => m.id !== mediaId));
          const stillLinkedElsewhere = [...wfMediaStore.values()].some((arr) => arr.some((m) => m.id === mediaId));
          return {
            unlinked: Boolean(removed),
            is_orphan: Boolean(removed) && !stillLinkedElsewhere,
            storage_url: removed?.url || null,
            remaining_links: stillLinkedElsewhere ? 1 : 0,
            was_primary: false,
          };
        },
        ...(useBatchStatusLookup
          ? {
              findMediaStatusesByWorkflowIds: async (wfIds) => {
                const map = new Map();
                for (const wfId of wfIds) {
                  map.set(
                    wfId,
                    (wfMediaStore.get(wfId) || []).map((m) => ({ id: m.id, status: m.status ?? null, url: m.url ?? null }))
                  );
                }
                return map;
              },
            }
          : {}),
      },
    };

    const storageService = {
      deleteByUrl: async (url) => {
        calls.storageDeleteByUrl.push(url);
      },
    };

    const authService = {
      verifyMediaOwnership: async () => true,
      verifyWorkflowOwnership: async () => true,
      verifyWorkflowOwnershipBulk: async (ids) => ids,
    };

    const mediaUploadService = { discard: async () => ({}) };
    const mediaService = new WorkflowMediaService({ db, storageService, authService, mediaUploadService });
    const wfService = new WorkflowService({ db, storageService, authService, mediaService, mediaUploadService });

    return { db, mediaService, wfService, calls, mediaStore, wfMediaStore };
  }

  it("deleteMedia rejects in-flight statuses (processing, pending, queued, uploading, in_progress, starting) with 409 MEDIA_PROCESSING and zero mutations", async () => {
    for (const status of ["processing", "pending", "queued", "uploading", "in_progress", "starting"]) {
      const mediaId = `m-${status}`;
      const wfId = `wf-${status}`;
      const h = makeStatusGuardHarness({
        mediaById: { [mediaId]: { id: mediaId, url: null, status } },
        workflowMediaByWf: { [wfId]: [{ id: mediaId, url: null, status }] },
      });

      await assert.rejects(
        () => h.mediaService.deleteMedia({ mediaId, workflowId: wfId, userId: "user-1" }),
        (err) => {
          assert.ok(err instanceof MediaConflictError, `Expected MediaConflictError for ${status}`);
          assert.equal(err.statusCode, 409);
          assert.equal(err.errorCode, "MEDIA_PROCESSING");
          return true;
        }
      );

      assert.equal(h.calls.findByIdSelects[0]?.select, "id, url, status");
      assert.equal(h.calls.unlinkAndReap.length, 0, `Must not unlink ${status} media`);
      assert.equal(h.calls.mediaDeleteById.length, 0, `Must not delete ${status} media row`);
      assert.equal(h.calls.storageDeleteByUrl.length, 0, `Must not delete storage for ${status} media`);
      assert.equal(h.calls.workflowDeleteById.length, 0, `Must not delete workflow for ${status} media`);
      assert.equal(h.mediaStore.has(mediaId), true);
    }
  });

  it("deleteMedia hard-deletes failed media with url: null and removes empty non-sidecar workflow container cleanly", async () => {
    const h = makeStatusGuardHarness({
      mediaById: { "m-failed-null": { id: "m-failed-null", url: null, status: "failed" } },
      workflowMediaByWf: { "wf-failed-1": [{ id: "m-failed-null", url: null, status: "failed" }] },
    });

    const result = await h.mediaService.deleteMedia({
      mediaId: "m-failed-null",
      workflowId: "wf-failed-1",
      userId: "user-1",
    });

    assert.equal(result.deleted, true);
    assert.equal(result.workflow_deleted, true);
    assert.deepEqual(h.calls.mediaDeleteById, ["m-failed-null"]);
    assert.deepEqual(h.calls.storageDeleteByUrl, []);
    assert.deepEqual(h.calls.workflowDeleteById, ["wf-failed-1"]);
    assert.equal(h.mediaStore.has("m-failed-null"), false);
  });

  it("deleteMedia hard-deletes failed media with non-null url and cleans up storage + empty workflow", async () => {
    const url = "https://cdn.example.com/failed-partial.png";
    const h = makeStatusGuardHarness({
      mediaById: { "m-failed-url": { id: "m-failed-url", url, status: "failed" } },
      workflowMediaByWf: { "wf-failed-2": [{ id: "m-failed-url", url, status: "failed" }] },
    });

    const result = await h.mediaService.deleteMedia({
      mediaId: "m-failed-url",
      workflowId: "wf-failed-2",
      userId: "user-1",
    });

    assert.equal(result.deleted, true);
    assert.equal(result.workflow_deleted, true);
    assert.deepEqual(h.calls.mediaDeleteById, ["m-failed-url"]);
    assert.deepEqual(h.calls.storageDeleteByUrl, [url]);
    assert.deepEqual(h.calls.workflowDeleteById, ["wf-failed-2"]);
  });

  it("deleteWorkflow and releaseWorkflowMedia reject workflows containing processing/pending media with 409 MEDIA_PROCESSING and zero mutations", async () => {
    for (const useBatchStatusLookup of [false, true]) {
      const h = makeStatusGuardHarness({
        mediaById: {
          "m-ok": { id: "m-ok", url: "https://cdn.example.com/ok.png", status: "completed" },
          "m-proc": { id: "m-proc", url: null, status: "processing" },
        },
        workflowMediaByWf: {
          "wf-in-flight": [
            { id: "m-ok", url: "https://cdn.example.com/ok.png", status: "completed" },
            { id: "m-proc", url: null, status: "processing" },
          ],
        },
        useBatchStatusLookup,
      });

      await assert.rejects(
        () => h.wfService.deleteWorkflow({ workflowId: "wf-in-flight", userId: "user-1" }),
        (err) => {
          assert.ok(err instanceof MediaConflictError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.errorCode, "MEDIA_PROCESSING");
          return true;
        }
      );

      // Zero mutations: primary_media_id was NOT cleared, no unlinks, no deletes
      assert.equal(h.calls.workflowUpdateFields.length, 0);
      assert.equal(h.calls.workflowUpdatePrimary.length, 0);
      assert.equal(h.calls.unlinkAndReap.length, 0);
      assert.equal(h.calls.mediaDeleteById.length, 0);
      assert.equal(h.calls.workflowDeleteById.length, 0);

      // Direct releaseWorkflowMedia call is also guarded
      await assert.rejects(
        () => h.mediaService.releaseWorkflowMedia({ workflowId: "wf-in-flight" }),
        (err) => err instanceof MediaConflictError && err.statusCode === 409 && err.errorCode === "MEDIA_PROCESSING"
      );
      assert.equal(h.calls.workflowUpdatePrimary.length, 0);
      assert.equal(h.calls.unlinkAndReap.length, 0);
    }
  });

  it("deleteWorkflow succeeds for failed media workflows and bulkDeleteWorkflows rejects upfront if any workflow is processing", async () => {
    const h = makeStatusGuardHarness({
      mediaById: {
        "m-failed": { id: "m-failed", url: null, status: "failed" },
        "m-pending": { id: "m-pending", url: null, status: "pending" },
      },
      workflowMediaByWf: {
        "wf-failed": [{ id: "m-failed", url: null, status: "failed" }],
        "wf-pending": [{ id: "m-pending", url: null, status: "pending" }],
      },
      useBatchStatusLookup: true,
    });

    // bulkDeleteWorkflows fails fast upfront with zero mutations when batch includes a pending workflow
    await assert.rejects(
      () => h.wfService.bulkDeleteWorkflows({ workflowIds: ["wf-failed", "wf-pending"], userId: "user-1" }),
      (err) => err instanceof MediaConflictError && err.statusCode === 409 && err.errorCode === "MEDIA_PROCESSING"
    );
    assert.equal(h.calls.workflowDeleteById.length, 0);
    assert.equal(h.calls.mediaDeleteById.length, 0);

    // Deleting the failed workflow alone hard-deletes media and workflow
    const res = await h.wfService.deleteWorkflow({ workflowId: "wf-failed", userId: "user-1" });
    assert.equal(res.workflowId, "wf-failed");
    assert.equal(res.deletedMediaCount, 1);
    assert.deepEqual(h.calls.mediaDeleteById, ["m-failed"]);
    assert.deepEqual(h.calls.workflowDeleteById, ["wf-failed"]);
  });

  it("fails closed when status-lookup DB query throws and does not fall back to N+1 findByWorkflow on empty batch result", async () => {
    let findByWorkflowCalls = 0;
    const dbErr = new Error("Transient DB connection error");

    const hFail = makeStatusGuardHarness({
      workflowMediaByWf: { "wf-err": [] },
      useBatchStatusLookup: true,
    });
    hFail.db.workflowMedia.findMediaStatusesByWorkflowIds = async () => {
      throw dbErr;
    };
    hFail.db.media.findByWorkflow = async () => {
      findByWorkflowCalls += 1;
      return [];
    };

    // deleteWorkflow, bulkDeleteWorkflows, and releaseWorkflowMedia all propagate DB errors (fail closed)
    await assert.rejects(
      () => hFail.wfService.deleteWorkflow({ workflowId: "wf-err", userId: "user-1" }),
      (err) => err === dbErr
    );
    await assert.rejects(
      () => hFail.wfService.bulkDeleteWorkflows({ workflowIds: ["wf-err"], userId: "user-1" }),
      (err) => err === dbErr
    );
    await assert.rejects(
      () => hFail.mediaService.releaseWorkflowMedia({ workflowId: "wf-err" }),
      (err) => err === dbErr
    );
    assert.equal(hFail.calls.workflowUpdateFields.length, 0);
    assert.equal(hFail.calls.workflowDeleteById.length, 0);
    assert.equal(hFail.calls.unlinkAndReap.length, 0);
    assert.equal(findByWorkflowCalls, 0);

    // When batch lookup returns an empty array for an empty workflow, assertWorkflowMediaNotInFlight /
    // _assertWorkflowsMediaNotInFlight must NOT trigger redundant N+1 findByWorkflow fallback calls
    const hEmpty = makeStatusGuardHarness({
      workflowMediaByWf: { "wf-empty-1": [], "wf-empty-2": [] },
      useBatchStatusLookup: true,
    });
    let emptyFallbackCalls = 0;
    hEmpty.db.media.findByWorkflow = async () => {
      emptyFallbackCalls += 1;
      return [];
    };

    await hEmpty.mediaService.assertWorkflowMediaNotInFlight("wf-empty-1");
    await hEmpty.wfService._assertWorkflowsMediaNotInFlight(["wf-empty-1", "wf-empty-2"]);
    assert.equal(emptyFallbackCalls, 0, "Empty batch lookup must not fall back to N+1 db.media.findByWorkflow");
  });
});
}
