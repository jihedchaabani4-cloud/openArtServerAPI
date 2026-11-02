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

function makeIngestStub(url = "https://mock-storage.local/uploaded.webp") {
    const calls = { ingestBinary: 0 };
    const stub = {
        ingestBinary: async () => {
            calls.ingestBinary += 1;
            return {
                url,
                type: "image",
                width: 1920,
                height: 1080,
                ratio: "16:9",
                format: "WEBP",
                sizeBytes: 8888,
                inspection: { type: "image" },
            };
        },
    };
    return { stub, calls };
}

function baseMockDb({ latestProject = null, latestProjectError = null, workflowDerived = null, workflowDerivedError = null } = {}) {
    const events = { workflowsCreated: [] };
    return {
        events,
        db: {
            projects: {
                findMostRecentForUser: async () => {
                    if (latestProjectError) throw latestProjectError;
                    return latestProject;
                },
                findByUser: async () => [],
            },
            workflows: {
                createWorkflow: async (wfData) => {
                    events.workflowsCreated.push({ ...wfData });
                    return { id: `wf-new-${events.workflowsCreated.length}`, ...wfData };
                },
                findById: async () => {
                    if (workflowDerivedError) throw workflowDerivedError;
                    return workflowDerived;
                },
                getWorkflow: async () => null,
                deleteById: async () => {},
            },
            workflowMedia: {
                attachReferenceMedia: async ({ workflowId, mediaId, role }) => ({
                    is_existing: false,
                    is_primary: true,
                    role,
                    media_id: mediaId,
                }),
                unlinkWorkflowMedia: async () => ({ unlinked: true }),
                getPrimaryMedia: async () => null,
                setPrimaryMedia: async () => {},
                findByMedia: async () => [],
            },
            media: {
                createMedia: async () => ({ id: "media-1" }),
                deleteById: async () => true,
            },
        },
    };
}

function makeService(mockDb, ingest, { storageService = null } = {}) {
    const mediaUploadService = {
        upload: async () => ({
            uploaded: [{
                storageKey: "user-123/uploads/uploaded.webp",
                url: "https://mock-storage.local/uploaded.webp",
                type: "image",
                width: 1920,
                height: 1080,
                ratio: "16:9",
                format: "WEBP",
                sizeBytes: 4096,
                originalName: "uploaded.png",
            }],
            failures: [],
        }),
        discard: async (keys) => {
            if (storageService?.deleteByUrl) {
                for (const _k of keys) {
                    await storageService.deleteByUrl("https://mock-storage.local/uploaded.webp");
                }
            }
            return { deletedCount: keys?.length || 0 };
        },
    };

    const workflowMediaService = new WorkflowMediaService({
        db: mockDb.db,
        storageService,
        mediaUploadService,
        authService: {
            verifyMediaOwnership: async () => true,
            verifyWorkflowOwnership: async () => true,
        },
    });

    return new AssetUploadService({
        db: mockDb.db,
        mediaUploadService,
        workflowMediaService,
        mediaService: new MediaService({ db: mockDb.db }),
        storageService,
        authService: {
            verifyMediaOwnership: async () => true,
            verifyWorkflowOwnership: async () => true,
        },
    });
}

describe("AssetUploadService — fail-closed default project resolution", () => {
    let origEnable;
    beforeEach(() => {
        WorkflowMediaRepository.clearMemory();
    });

    it("rejects with 400 when the user has no project, before ingesting the file", async () => {
        const mockDb = baseMockDb({ latestProject: null });
        const ingest = makeIngestStub();
        const service = makeService(mockDb, ingest);
        let flowRepo = null;
        try {
            flowRepo = new WorkflowMediaRepository();
        } catch {}

        await assert.rejects(
            async () => service.uploadAsset({ source: { buffer: VALID_PNG_BUFFER }, userId: "user-123" }),
            (err) => err.statusCode === 400 && err.errorCode === "VALIDATION_ERROR"
        );
        assert.equal(ingest.calls.ingestBinary, 0, "file must not be ingested when the default project is absent");
        assert.equal(mockDb.events.workflowsCreated.length, 0, "no workflow may be created without a project");
    });

    it("propagates project repository failures instead of treating them as 'no project'", async () => {
        const mockDb = baseMockDb({ latestProjectError: new Error("supabase connection reset") });
        const ingest = makeIngestStub();
        const service = makeService(mockDb, ingest);

        await assert.rejects(
            async () => service.uploadAsset({ source: { buffer: VALID_PNG_BUFFER }, userId: "user-123" }),
            /supabase connection reset/
        );
        assert.equal(ingest.calls.ingestBinary, 0);
        assert.equal(mockDb.events.workflowsCreated.length, 0);
    });

    it("uses the most recent project as the default target when no project_id is supplied", async () => {
        WorkflowMediaRepository.enableTestMemoryFallback?.();
        WorkflowMediaRepository.clearMemory?.();

        const mockDb = baseMockDb({ latestProject: { id: "proj-latest", user_id: "user-123" } });
        const ingest = makeIngestStub();
        const service = makeService(mockDb, ingest);

        const result = await service.uploadAsset({
            source: { buffer: VALID_PNG_BUFFER },
            userId: "user-123",
            displayName: "Default target",
        });
        assert.equal(result.isNew, true);
        assert.equal(mockDb.events.workflowsCreated[0]?.project_id, "proj-latest");
    });

    it("deletes the just-uploaded storage object when media persistence fails", async () => {
        const mediaCreateFailures = new Error("media insert failed");
        const mockDb = baseMockDb({ latestProject: { id: "proj-latest", user_id: "user-123" } });
        mockDb.db.media._throwError = mediaCreateFailures;
        mockDb.db.media.createMedia = async () => {
            throw mediaCreateFailures;
        };
        const ingest = makeIngestStub();
        const deletedUrls = [];
        const storageService = {
            deleteByUrl: async (url) => {
                deletedUrls.push(url);
                return true;
            },
        };
        const service = makeService(mockDb, ingest, { storageService });

        await assert.rejects(
            async () => service.uploadAsset({ source: { buffer: VALID_PNG_BUFFER }, userId: "user-123" }),
            /media insert failed/
        );
        assert.deepEqual(deletedUrls, ["https://mock-storage.local/uploaded.webp"]);
    });

    it("deletes the just-uploaded storage object when workflow creation fails", async () => {
        const mockDb = baseMockDb({ latestProject: { id: "proj-latest", user_id: "user-123" } });
        mockDb.db.workflows.createWorkflow = async () => {
            throw new Error("workflow insert failed");
        };
        const ingest = makeIngestStub();
        const deletedUrls = [];
        const service = makeService(mockDb, ingest, {
            storageService: { deleteByUrl: async (url) => { deletedUrls.push(url); } },
        });

        await assert.rejects(
            async () => service.uploadAsset({ source: { buffer: VALID_PNG_BUFFER }, userId: "user-123" }),
            /workflow insert failed/
        );
        assert.deepEqual(deletedUrls, ["https://mock-storage.local/uploaded.webp"]);
    });

    it("propagates a failing project derivation from the target workflow instead of persisting with no project", async () => {
        const mockDb = baseMockDb({ workflowDerivedError: new Error("workflow lookup failed") });
        const ingest = makeIngestStub();
        const deletedUrls = [];
        const service = makeService(mockDb, ingest, {
            storageService: { deleteByUrl: async (url) => { deletedUrls.push(url); } },
        });

        await assert.rejects(
            async () => service.uploadAsset({
                source: { buffer: VALID_PNG_BUFFER },
                userId: "user-123",
                workflowId: "wf-existing",
            }),
            /workflow lookup failed/
        );
        assert.deepEqual(deletedUrls, ["https://mock-storage.local/uploaded.webp"]);
        assert.equal(mockDb.events.workflowsCreated.length, 0);
    });
});
