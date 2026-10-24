process.env.NODE_ENV = "test";

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AssetUploadService } from "../../src/domain/asset/AssetUploadService.js";
import { MediaService } from "../../src/platform/media/MediaService.js";
import { WorkflowMediaRepository } from "../../src/db/WorkflowMediaRepository.js";
import { WorkflowMediaService } from "../../src/platform/workflow/WorkflowMediaService.js";

const VALID_PNG_BUFFER = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
);

function makeIngestStub(url = "https://mock-storage.local/characterize.webp") {
    const calls = { ingestBinary: 0, upload: 0 };
    const stub = {
        calls,
        ingestBinary: async () => {
            calls.ingestBinary += 1;
            return {
                url,
                type: "image",
                width: 1920,
                height: 1080,
                ratio: "16:9",
                format: "WEBP",
                sizeBytes: 4096,
                originalName: "characterize.png",
                inspection: { type: "image" },
            };
        },
        upload: async () => {
            calls.upload += 1;
            return [
                {
                    storageKey: "user-1/uploads/characterize.webp",
                    url,
                    type: "image",
                    width: 1920,
                    height: 1080,
                    ratio: "16:9",
                    format: "WEBP",
                    sizeBytes: 4096,
                },
            ];
        },
    };
    return stub;
}

function makeCharacterizeHarness() {
    const workflows = new Map();
    const media = new Map();
    const workflowMedia = [];
    const projects = new Map();
    const folders = new Map();

    const db = {
        projects: {
            findMostRecentForUser: async (userId) => {
                for (const p of projects.values()) {
                    if (p.user_id === userId) return p;
                }
                return null;
            },
            findByUser: async (userId, projectId) => {
                const p = projects.get(projectId);
                return p && p.user_id === userId ? [p] : [];
            },
            findById: async (id) => projects.get(id) || null,
        },
        folders: {
            findOwnedInProject: async (folderId, projectId, userId) => {
                const f = folders.get(folderId);
                return f && f.project_id === projectId && f.user_id === userId ? f : null;
            },
        },
        workflows: {
            createWorkflow: async (wfData) => {
                const id = `wf-${workflows.size + 1}`;
                const row = {
                    id,
                    primary_media_id: null,
                    ...wfData,
                };
                workflows.set(id, row);
                return row;
            },
            findById: async (id) => workflows.get(id) || null,
            getWorkflow: async (id) => workflows.get(id) || null,
            deleteById: async (id) => {
                workflows.delete(id);
                return { deleted: true };
            },
        },
        media: {
            createMedia: async (mediaData) => {
                const id = `media-${media.size + 1}`;
                const row = { id, ...mediaData };
                media.set(id, row);
                return row;
            },
            findById: async (id) => media.get(id) || null,
            deleteById: async (id) => {
                media.delete(id);
                return { deleted: true };
            },
        },
        workflowMedia: {
            linkMedia: async (params) => {
                const row = {
                    workflow_id: params.workflowId,
                    media_id: params.mediaId,
                    role: params.role || "detail",
                    is_primary: Boolean(params.is_primary ?? params.isPrimary ?? false),
                    metadata: params.metadata || {},
                };
                workflowMedia.push(row);
                return row;
            },
            attachReferenceMedia: async ({ workflowId, mediaId, role, maxAllowed, autoPrimary = true }) => {
                const autoPrimaryEffective = autoPrimary === undefined || autoPrimary === null ? true : Boolean(autoPrimary);
                let is_primary = false;
                if (autoPrimaryEffective) {
                    const hasPrimary = workflowMedia.some((w) => w.workflow_id === workflowId && w.is_primary);
                    is_primary = !hasPrimary;
                }
                const row = {
                    workflow_id: workflowId,
                    media_id: mediaId,
                    role: role || "detail",
                    is_primary,
                    is_existing: false,
                };
                workflowMedia.push(row);
                return row;
            },
            unlink: async ({ workflowId, mediaId, role }) => {
                const idx = workflowMedia.findIndex(
                    (w) => w.workflow_id === workflowId && w.media_id === mediaId && (!role || w.role === role)
                );
                if (idx >= 0) workflowMedia.splice(idx, 1);
                return { unlinked: idx >= 0 };
            },
            unlinkWorkflowMedia: async ({ workflowId, mediaId, role }) => {
                const idx = workflowMedia.findIndex(
                    (w) => w.workflow_id === workflowId && w.media_id === mediaId && (!role || w.role === role)
                );
                if (idx >= 0) workflowMedia.splice(idx, 1);
                return { unlinked: idx >= 0 };
            },
        },
    };

    const ingest = makeIngestStub();

    const mediaUploadService = {
        upload: async () => ({
            uploaded: [{
                storageKey: "user-1/uploads/test.webp",
                url: "https://mock-storage.local/characterize.webp",
                type: "image",
                width: 1920,
                height: 1080,
                ratio: "16:9",
                format: "WEBP",
                sizeBytes: 8888,
                originalName: "test.png",
            }],
            failures: [],
        }),
        discard: async () => ({ deletedCount: 0 }),
    };

    const authService = {
        verifyMediaOwnership: async (mediaId, userId) => {
            const m = media.get(mediaId);
            return Boolean(m && (!m.user_id || m.user_id === userId));
        },
        verifyWorkflowOwnership: async (wfId, userId) => {
            const w = workflows.get(wfId);
            return Boolean(w && w.user_id === userId);
        },
    };

    const workflowMediaService = new WorkflowMediaService({
        db,
        storageService: {},
        mediaUploadService,
        authService,
    });

    const service = new AssetUploadService({
        db,
        mediaUploadService,
        workflowMediaService,
        binaryIngestionService: ingest,
        mediaService: new MediaService({ db }),
        workflowAuthService: authService,
    });

    return { service, db, ingest, workflows, media, workflowMedia, projects, folders };
}

describe("AssetUploadService — Characterization Tests (Ticket 04 Pre-Check)", () => {
    beforeEach(() => {
        WorkflowMediaRepository.clearMemory();
    });

    it("1. New-workflow case: creates container workflow, leaves workflows.primary_media_id as NULL, sets workflow_media(role: 'original', is_primary: true), and media(step_id: 'upload')", async () => {
        const h = makeCharacterizeHarness();
        const projectId = "00000000-0000-0000-0000-000000000001";
        h.projects.set(projectId, { id: projectId, user_id: "user-1" });

        const result = await h.service.uploadAsset({
            source: { buffer: VALID_PNG_BUFFER },
            userId: "user-1",
            projectId,
            displayName: "Characterize Asset",
        });

        assert.equal(result.isNew, true);
        assert.ok(result.workflowId, "Must return workflowId");

        const wf = h.workflows.get(result.workflowId);
        assert.ok(wf, "Workflow must exist in DB");
        assert.equal(wf.workflow_type, "UPLOAD");
        // Characterization invariant: workflows.primary_media_id is NULL (not written by legacy createWorkflow/createMedia)
        assert.equal(wf.primary_media_id, null, "workflows.primary_media_id is NULL in current behavior");

        const mediaRow = h.media.get(result.mediaId);
        assert.ok(mediaRow, "Media must exist in DB");
        assert.equal(mediaRow.step_id, "upload", "media.step_id must be 'upload'");

        const link = h.workflowMedia.find((w) => w.workflow_id === result.workflowId && w.media_id === result.mediaId);
        assert.ok(link, "workflow_media link must exist");
        assert.equal(link.role, "original", "workflow_media.role must be 'original'");
        assert.equal(link.is_primary, true, "workflow_media.is_primary must be true");
    });

    it("2. Existing-workflow case: preserves existing workflow, does NOT touch primary_media_id, sets workflow_media(role: 'output', is_primary: false), and media(step_id: 'upload')", async () => {
        const h = makeCharacterizeHarness();
        const projectId = "00000000-0000-0000-0000-000000000001";
        const existingWfId = "00000000-0000-0000-0000-000000000010";
        const existingPrimaryId = "00000000-0000-0000-0000-000000000099";

        h.projects.set(projectId, { id: projectId, user_id: "user-1" });
        h.workflows.set(existingWfId, {
            id: existingWfId,
            user_id: "user-1",
            project_id: projectId,
            primary_media_id: existingPrimaryId,
            workflow_type: "GENERATION",
        });
        h.workflowMedia.push({
            workflow_id: existingWfId,
            media_id: existingPrimaryId,
            role: "output",
            is_primary: true,
        });

        const initialWfCount = h.workflows.size;

        const result = await h.service.uploadAsset({
            source: { buffer: VALID_PNG_BUFFER },
            userId: "user-1",
            projectId,
            workflowId: existingWfId,
        });

        assert.equal(result.isNew, true);
        assert.equal(result.workflowId, existingWfId);
        assert.equal(h.workflows.size, initialWfCount, "No new workflow may be created when workflowId is provided");

        const wf = h.workflows.get(existingWfId);
        assert.equal(wf.primary_media_id, existingPrimaryId, "workflows.primary_media_id must be untouched");

        const mediaRow = h.media.get(result.mediaId);
        assert.equal(mediaRow.step_id, "upload", "media.step_id must be 'upload'");

        const link = h.workflowMedia.find((w) => w.workflow_id === existingWfId && w.media_id === result.mediaId);
        assert.ok(link, "workflow_media link must exist");
        assert.equal(link.role, "output", "workflow_media.role must be 'output' for existing workflow attachment");
        assert.equal(link.is_primary, false, "workflow_media.is_primary must be false");
    });

    // Option (b) verified: p_auto_primary suppresses primary promotion when attaching to existing workflows,
    // preserving the legacy invariant that an existing workflow without a primary cover remains without primary.
    it("2b. Existing-workflow case with NO primary cover: characterizes old vs new behavior when attaching to a primary-less workflow", async () => {
        const h = makeCharacterizeHarness();
        const projectId = "00000000-0000-0000-0000-000000000001";
        const primaryLessWfId = "00000000-0000-0000-0000-000000000020";

        h.projects.set(projectId, { id: projectId, user_id: "user-1" });
        h.workflows.set(primaryLessWfId, {
            id: primaryLessWfId,
            user_id: "user-1",
            project_id: projectId,
            primary_media_id: null,
            workflow_type: "GENERATION",
        });

        const result = await h.service.uploadAsset({
            source: { buffer: VALID_PNG_BUFFER },
            userId: "user-1",
            projectId,
            workflowId: primaryLessWfId,
        });

        assert.equal(result.isNew, true);
        assert.equal(result.workflowId, primaryLessWfId);

        const link = h.workflowMedia.find((w) => w.workflow_id === primaryLessWfId && w.media_id === result.mediaId);
        assert.ok(link, "workflow_media link must exist");
        assert.equal(link.role, "output");
        assert.equal(link.is_primary, false, "Option (b): is_primary is false when attaching to an existing workflow, even without primary cover");
    });

    it("3. Pre-flight validation: missing/invalid project_id fails before storage upload is called", async () => {
        const h = makeCharacterizeHarness();
        // Zero projects in DB

        await assert.rejects(
            async () => {
                await h.service.uploadAsset({
                    source: { buffer: VALID_PNG_BUFFER },
                    userId: "user-1",
                    projectId: "00000000-0000-0000-0000-000000000999", // foreign
                });
            },
            (err) => err.statusCode === 404 && err.errorCode === "NOT_FOUND"
        );

        assert.equal(h.ingest.calls.ingestBinary, 0, "Storage upload must NEVER be called when project validation fails");
        assert.equal(h.ingest.calls.upload, 0, "Storage upload must NEVER be called when project validation fails");
    });

    it("4. Pre-flight validation: invalid/foreign folderId fails before storage upload is called", async () => {
        const h = makeCharacterizeHarness();
        const projectId = "00000000-0000-0000-0000-000000000001";
        h.projects.set(projectId, { id: projectId, user_id: "user-1" });

        // Malformed UUID folderId
        await assert.rejects(
            async () => {
                await h.service.uploadAsset({
                    source: { buffer: VALID_PNG_BUFFER },
                    userId: "user-1",
                    projectId,
                    folderId: "not-a-valid-uuid",
                });
            },
            (err) => err.statusCode === 400 && err.errorCode === "VALIDATION_ERROR"
        );
        assert.equal(h.ingest.calls.ingestBinary, 0, "Storage upload must not be called on invalid folder UUID");

        // Foreign folderId
        const foreignFolderId = "00000000-0000-0000-0000-000000000888";
        await assert.rejects(
            async () => {
                await h.service.uploadAsset({
                    source: { buffer: VALID_PNG_BUFFER },
                    userId: "user-1",
                    projectId,
                    folderId: foreignFolderId,
                });
            },
            (err) => err.statusCode === 404 && err.errorCode === "NOT_FOUND"
        );
        assert.equal(h.ingest.calls.ingestBinary, 0, "Storage upload must not be called on foreign folder");
    });
});
