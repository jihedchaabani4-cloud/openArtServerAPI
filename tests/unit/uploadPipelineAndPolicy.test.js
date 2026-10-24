import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SourcePolicy } from "../../src/platform/media-ingestion/SourcePolicy.js";
import { createUploadMiddleware } from "../../src/middleware/uploadMiddleware.js";
import { BinaryIngestionService } from "../../src/platform/media-ingestion/BinaryIngestionService.js";
import { MediaIngestionService } from "../../src/platform/media-ingestion/MediaIngestionService.js";
import { AssetUploadService } from "../../src/domain/asset/AssetUploadService.js";
import { MediaService } from "../../src/platform/media/MediaService.js";
import { WorkflowMediaRepository } from "../../src/db/WorkflowMediaRepository.js";
import { WorkflowMediaService } from "../../src/platform/workflow/WorkflowMediaService.js";

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

describe("BinaryIngestionService & MediaIngestionService Decoupled Contracts", () => {
    it("BinaryIngestionService performs pure binary ingestion without DB or workflow dependencies", async () => {
        let storageUploadCalled = false;
        const mockStorage = {
            paths: {
                projectAsset: () => "mock/path/binary.webp",
            },
            upload: async () => {
                storageUploadCalled = true;
                return "https://cdn.example.com/mock/path/binary.webp";
            },
        };

        const binaryService = new BinaryIngestionService({ storageService: mockStorage });

        const result = await binaryService.ingestBinary({
            source: {
                buffer: VALID_PNG_BUFFER,
                originalname: "pixel.png",
                mimetype: "image/png",
            },
            userId: "user-pure-binary",
            purpose: "default",
        });

        assert.ok(storageUploadCalled, "Storage upload should have been called");
        assert.equal(result.url, "https://cdn.example.com/mock/path/binary.webp");
        assert.equal(result.type, "image");
        assert.equal(result.buffer, undefined, "Large binary buffer must NOT be returned in result");
        assert.equal(result.media, undefined, "No media record in binary result");
        assert.equal(result.workflowId, undefined, "No workflow in binary result");
    });

    it("Platform MediaIngestionService operates purely without domain dependencies", async () => {
        const mockBinary = {
            ingestBinary: async () => ({
                url: "https://cdn.example.com/sheet.webp",
                type: "image",
                width: 1024,
                height: 1024,
                ratio: "1:1",
                format: "WEBP",
                sizeBytes: 4096,
                inspection: { type: "image" },
            }),
        };

        const mediaIngestion = new MediaIngestionService({
            binaryIngestionService: mockBinary,
        });

        const result = await mediaIngestion.ingest({
            source: { buffer: VALID_PNG_BUFFER, mimetype: "image/png" },
            userId: "user-123",
        });

        assert.equal(result.isNew, true);
        assert.equal(result.media, null, "Platform ingest produces no media record without domain orchestrator");
        assert.equal(result.url, "https://cdn.example.com/sheet.webp");
    });

    it("Platform MediaIngestionService instance in container is untouched and independent of domain orchestration", async () => {
        const { mediaIngestionService } = await import("../../src/container.js");
        const propDesc = Object.getOwnPropertyDescriptor(mediaIngestionService, "ingest");
        assert.equal(propDesc, undefined, "mediaIngestionService must NOT have own getter/setter for ingest");
        assert.equal(typeof mediaIngestionService.ingest, "function", "mediaIngestionService.ingest must be the prototype platform method");
        assert.equal(typeof mediaIngestionService.ingestBinary, "function", "mediaIngestionService.ingestBinary must be platform method");
    });

    it("legacyMediaIngestAdapter preserves both contracts (binary-only skipMediaCreate and assetUploadService delegation)", async () => {
        const { legacyMediaIngestAdapter, assetUploadService, binaryIngestionService } = await import("../../src/container.js");
        const origUploadAsset = assetUploadService.uploadAsset;
        const origIngestBinary = binaryIngestionService.ingestBinary;

        let uploadAssetCalled = false;
        let ingestBinaryCalled = false;

        assetUploadService.uploadAsset = async (opts) => {
            uploadAssetCalled = true;
            return {
                media: { id: "media-bridged-1" },
                mediaId: "media-bridged-1",
                workflowId: "wf-bridged-1",
                url: "https://cdn.example.com/bridged.webp",
                isNew: true,
            };
        };

        binaryIngestionService.ingestBinary = async (opts) => {
            ingestBinaryCalled = true;
            return {
                url: "https://cdn.example.com/binary-only.webp",
                type: "image",
                width: 100,
                height: 100,
            };
        };

        try {
            // Contract 1: ordinary legacy ingest(options) delegates to assetUploadService.uploadAsset
            const resDefault = await legacyMediaIngestAdapter.ingest({
                source: { buffer: VALID_PNG_BUFFER, mimetype: "image/png" },
                userId: "user-bridge",
                purpose: "default",
            });
            assert.ok(uploadAssetCalled, "Ordinary legacy ingest must delegate to assetUploadService.uploadAsset");
            assert.equal(resDefault.mediaId, "media-bridged-1");

            // Contract 2: skipMediaCreate: true delegates to binaryIngestionService.ingestBinary
            const resSkip = await legacyMediaIngestAdapter.ingest({
                source: { buffer: VALID_PNG_BUFFER, mimetype: "image/png" },
                skipMediaCreate: true,
                workflowId: "wf-skip-1",
            });
            assert.ok(ingestBinaryCalled, "skipMediaCreate: true must delegate to binaryIngestionService.ingestBinary");
            assert.equal(resSkip.media, null);
            assert.equal(resSkip.mediaId, null);
            assert.equal(resSkip.workflowId, "wf-skip-1");
            assert.equal(resSkip.url, "https://cdn.example.com/binary-only.webp");
        } finally {
            assetUploadService.uploadAsset = origUploadAsset;
            binaryIngestionService.ingestBinary = origIngestBinary;
        }
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

        const mockBinaryIngest = {
            ingestBinary: async () => ({
                url: "https://mock-storage.local/canonical.webp",
                type: "image",
                width: 1920,
                height: 1080,
                ratio: "16:9",
                format: "WEBP",
                sizeBytes: 8888,
                inspection: { type: "image" },
            }),
        };

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

    it("ElementMediaService calls ingestBinary and owns media record & role: detail linking", async () => {
        let ingestBinaryCalled = false;
        let mediaCreated = false;
        const linkCalls = [];

        const mockIngestionService = {
            ingestBinary: async () => {
                ingestBinaryCalled = true;
                return {
                    url: "https://cdn.example.com/elem.webp",
                    type: "image",
                    width: 800,
                    height: 600,
                    sizeBytes: 5000,
                };
            },
        };

        const mockDb = {
            media: {
                createMedia: async (data) => {
                    mediaCreated = true;
                    return { id: "media-elem-1", ...data };
                },
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

        const { ElementMediaService } = await import("../../src/domain/element/ElementMediaService.js");
        const elemMediaService = new ElementMediaService({
            db: mockDb,
            storageService: {},
            mediaIngestionService: mockIngestionService,
        });

        const result = await elemMediaService.ingestElementSources({
            workflowId: "elem-wf-1",
            sourceImages: ["https://example.com/source.png"],
            projectId: "proj-1",
            userId: "user-1",
        });

        assert.ok(ingestBinaryCalled, "ElementMediaService must call ingestBinary");
        assert.ok(mediaCreated, "ElementMediaService must own db.media.createMedia");
        assert.equal(linkCalls.length, 1, "Must link to workflow_media");
        assert.equal(linkCalls[0].role, "detail", "Element relationship role must be canonically 'detail'");
        assert.equal(result.mediaRecords[0].id, "media-elem-1");
    });

    it("WorkflowMediaRepository & BaseRepository route to supabaseAdmin to bypass RLS in server operations", async () => {
        const repo = new WorkflowMediaRepository();
        const client = repo.client();
        const { supabaseAdmin } = await import("../../lib/supabase.js");
        assert.equal(client, supabaseAdmin, "WorkflowMediaRepository.client() must return supabaseAdmin");
    });
});
