import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SourcePolicy, MediaUploadService } from "#media/tools";
import { createUploadMiddleware } from "#media/api";
import { StorageService, InMemoryStorageProvider } from "#media/tools";
import { AssetUploadService } from "#media/tools";
import { MediaService } from "#media/tools";
import { WorkflowMediaRepository } from "#media/tools";
import { WorkflowMediaService } from "#generation/tools";

const VALID_PNG_BUFFER = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
]);

describe("Authoritative SourcePolicy & Upload Middleware Contract", () => {
    it("SourcePolicy defines canonical profiles with verified limits", () => {
        const defaultProfile = SourcePolicy.getProfile("default");
        assert.equal(defaultProfile.maxSizeBytes, 100 * 1024 * 1024, "Default max size is 100MB");
        assert.equal(defaultProfile.imageLimit, 20 * 1024 * 1024, "Default image limit is 20MB");
        assert.equal(defaultProfile.videoLimit, 100 * 1024 * 1024, "Default video limit is 100MB");

        const charProfile = SourcePolicy.getProfile("character_reference");
        assert.equal(charProfile.maxSizeBytes, 20 * 1024 * 1024, "Character reference max size is 20MB");
        assert.equal(charProfile.imageLimit, 20 * 1024 * 1024, "Character reference image limit is 20MB");
        assert.equal(charProfile.videoLimit, 0, "Character reference rejects video");

        const elemProfile = SourcePolicy.getProfile("element_reference");
        assert.equal(elemProfile.maxSizeBytes, 20 * 1024 * 1024, "Element reference max size is 20MB");
        assert.equal(elemProfile.imageLimit, 20 * 1024 * 1024, "Element reference image limit is 20MB");
        assert.equal(elemProfile.videoLimit, 0, "Element reference rejects video");
    });

    it("createUploadMiddleware derives limits and fileFilter directly from SourcePolicy", () => {
        const middleware = createUploadMiddleware("character_reference");
        assert.equal(typeof middleware, "function", "Must return an Express middleware function");

        const defaultMiddleware = createUploadMiddleware("default");
        assert.equal(typeof defaultMiddleware, "function", "Must return an Express middleware function for default");
    });
});

describe("MediaUploadService Stateless Platform Contract", () => {
    it("MediaUploadService performs pure binary upload without DB or workflow dependencies", async () => {
        const provider = new InMemoryStorageProvider({ bucketName: "test-bucket" });
        const storageService = new StorageService("test-bucket", provider);
        const uploadService = new MediaUploadService({ storageService });

        const { uploaded } = await uploadService.upload({
            files: [{
                buffer: VALID_PNG_BUFFER,
                originalname: "pixel.png",
                mimetype: "image/png",
            }],
            userId: "user-pure-binary",
        });

        assert.equal(uploaded.length, 1);
        assert.match(uploaded[0].storageKey, /^user-pure-binary\/uploads\/\d+_[a-f0-9]+\.png$/);
        assert.equal(provider.has(uploaded[0].storageKey), true);
        assert.equal(uploaded[0].type, "image");
        assert.equal(uploaded[0].buffer, undefined, "Large binary buffer must NOT be returned in result");
        assert.equal(uploaded[0].media, undefined, "No media record in stateless upload result");
        assert.equal(uploaded[0].workflowId, undefined, "No workflow in stateless upload result");
    });

    it("Container exposes MediaUploadService and removes legacy duplicate ingestion services", async () => {
        const container = await import("../../src/container.js");
        assert.ok(container.mediaUploadService instanceof MediaUploadService);
        assert.equal(typeof container.mediaUploadService.upload, "function");
        assert.equal(typeof container.mediaUploadService.discard, "function");
        assert.equal("binaryIngestionService" in container, false);
        assert.equal("mediaIngestionService" in container, false);
        assert.equal("legacyMediaIngestAdapter" in container, false);
    });
});

describe("Canonical Primary-Media Persistence & WorkflowMedia Contract", () => {
    it("Standalone upload directly persists workflow_media with role: 'original', is_primary: true on insert without redundant secondary call", async () => {
        WorkflowMediaRepository.enableTestMemoryFallback();
        WorkflowMediaRepository.clearMemory();

        let workflowInsertData = null;
        let redundantSecondaryCalled = false;

        const mockWorkflowsRepo = {
            createWorkflow: async (wfData) => {
                workflowInsertData = { ...wfData };
                return { id: "wf-canonical-1", ...wfData };
            },
            updatePrimaryMedia: async () => {
                redundantSecondaryCalled = true;
            },
        };

        const workflowMediaRepo = new WorkflowMediaRepository();
        let mediaTableCreatedRow = null;
        const mockMediaRepo = {
            createMedia: async (mediaData) => {
                mediaTableCreatedRow = { id: "media-canonical-1", ...mediaData };
                return mediaTableCreatedRow;
            },
        };

        const mockDb = {
            workflows: mockWorkflowsRepo,
            media: mockMediaRepo,
            workflowMedia: workflowMediaRepo,
            projects: {
                findByUser: async () => [{ id: "proj-canonical", user_id: "user-123" }],
            },
        };

        const mediaService = new MediaService({ db: mockDb });

        const mockUploadService = {
            upload: async () => ({
                uploaded: [{
                    storageKey: "user-123/uploads/canonical.webp",
                    url: "https://mock-storage.local/canonical.webp",
                    mimeType: "image/webp",
                    size: 8888,
                    type: "image",
                    width: 1920,
                    height: 1080,
                    ratio: "16:9",
                    format: "WEBP",
                    durationSec: null,
                    originalName: "photo.png",
                }],
                failures: [],
            }),
            discard: async () => ({ deletedCount: 0 }),
        };

        const mockWfMediaService = new WorkflowMediaService({
            db: mockDb,
            storageService: {},
            authService: {
                verifyWorkflowOwnership: async () => true,
                verifyMediaOwnership: async () => true,
            },
            mediaUploadService: mockUploadService,
        });

        const assetService = new AssetUploadService({
            db: mockDb,
            mediaUploadService: mockUploadService,
            workflowMediaService: mockWfMediaService,
            authService: mockWfMediaService.authService,
            mediaService,
        });

        const result = await assetService.uploadAsset({
            source: { buffer: VALID_PNG_BUFFER, originalname: "photo.png", mimetype: "image/png" },
            userId: "user-123",
            projectId: "proj-canonical",
            displayName: "Canonical Upload",
        });

        // 1. Assert return DTO
        assert.equal(result.isNew, true);
        assert.equal(result.mediaId, "media-canonical-1");
        assert.equal(result.workflowId, "wf-canonical-1");

        // 2. Assert workflow creation never wrote to removed primary_media_id column
        assert.strictEqual(workflowInsertData.primary_media_id, undefined, "Must NOT write to workflow.primary_media_id");
        assert.equal(workflowInsertData.workflow_type, "UPLOAD");

        // 3. Assert media row never received is_primary (removed column on media table)
        assert.strictEqual(mediaTableCreatedRow.is_primary, undefined, "media table must NOT have is_primary column written");

        // 4. Assert canonical workflow_media relation was persisted directly on createMedia with role: 'original' and is_primary: true
        const primaryMedia = await workflowMediaRepo.getPrimaryMedia("wf-canonical-1");
        assert.ok(primaryMedia, "A primary media record must exist in workflow_media");
        assert.equal(primaryMedia.workflow_id, "wf-canonical-1");
        assert.equal(primaryMedia.media_id, "media-canonical-1");
        assert.equal(primaryMedia.role, "original", "Standalone upload must have role: 'original'");
        assert.equal(primaryMedia.is_primary, true, "Persisted relation must have is_primary: true directly on insert");

        // 5. Assert redundant secondary update was not triggered
        assert.equal(redundantSecondaryCalled, false, "Redundant secondary updatePrimaryMedia must not be called");
    });

    it("ElementMediaService calls mediaUploadService.upload and links role: detail via workflowMediaService", async () => {
        const linkCalls = [];

        const mockDb = {
            media: {
                createMedia: async (data) => ({ id: "media-elem-1", ...data }),
            },
            workflowMedia: {
                linkMedia: async (payload) => {
                    linkCalls.push(payload);
                    return payload;
                },
            },
            workflows: {
                updatePrimaryMedia: async () => ({}),
            },
        };

        const { ElementMediaService } = await import("#elements/tools");
        let uploadCalled = false;
        const mockUploadService = {
            upload: async ({ files }) => {
                uploadCalled = true;
                return {
                    uploaded: files.map((f, i) => ({
                        id: "media-elem-" + (i + 1),
                        url: "https://storage.example.com/binary.png",
                        storageKey: "binary.png",
                        step_id: "upload",
                    })),
                };
            },
            discard: async () => ({}),
        };
        const mockWorkflowMediaService = {
            attachMediaItems: async ({ workflowId, items, role }) => {
                for (const item of items) {
                    linkCalls.push({
                        workflowId,
                        mediaId: item.uploadedFile.id,
                        role,
                    });
                }
                return {
                    attached: items.map((it) => ({
                        media: it.uploadedFile,
                        is_primary: true,
                    })),
                };
            },
        };
        const mockAuthService = {
            verifyWorkflowOwnership: async () => true,
        };

        const elemMediaService = new ElementMediaService({
            db: mockDb,
            storageService: {},
            mediaUploadService: mockUploadService,
            workflowMediaService: mockWorkflowMediaService,
            authService: mockAuthService,
        });

        const result = await elemMediaService.ingestElementSources({
            workflowId: "elem-wf-1",
            sourceImages: ["https://example.com/source.png"],
            projectId: "proj-1",
            userId: "user-1",
        });

        assert.ok(uploadCalled, "ElementMediaService must call mediaUploadService.upload");
        assert.equal(linkCalls.length, 1, "Must link to workflow_media");
        assert.equal(linkCalls[0].role, "detail", "Element relationship role must be canonically 'detail'");
        assert.equal(result.mediaRecords[0].id, "media-elem-1");
    });

    it("WorkflowMediaRepository & BaseRepository route to supabaseAdmin to bypass RLS in server operations", async () => {
        const repo = new WorkflowMediaRepository();
        const client = repo.client();
        const { supabaseAdmin } = await import("#shared/db/supabase.js");
        assert.equal(client, supabaseAdmin, "WorkflowMediaRepository.client() must return supabaseAdmin");
    });
});
