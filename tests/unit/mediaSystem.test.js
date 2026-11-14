import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
    saveTypeRegistry,
    SAVE_TYPES,
    RETENTION_POLICIES,
    StorageService,
    StoragePathResolver,
    InMemoryStorageProvider,
    StorageValidationError,
    MediaValidationError,
    MediaRepository,
    WorkflowMediaRepository,
    getMediaRepository,
    getWorkflowMediaRepository,
    getStorageService,
    setStorageService,
    createPendingMedia,
    markMediaFailed,
    linkMediaToEntity,
    getMediaUrls,
    deleteMedia,
} from "#media/tools";
import { mediaRouter, assetsRouter, mediaIngestRouter } from "#media/api";

describe("System 4: Media & Storage — System Unit Tests", () => {
    describe("1. SaveTypeRegistry (Rule 11)", () => {
        it("contains standard save types with declarative policies", () => {
            const defaultType = saveTypeRegistry.get(SAVE_TYPES.DEFAULT);
            assert.ok(defaultType);
            assert.equal(defaultType.storageFolder, "uploads");
            assert.equal(defaultType.retention, RETENTION_POLICIES.PERMANENT);
            assert.ok(defaultType.allowedMimeTypes.includes("image/png"));

            const sheetType = saveTypeRegistry.get(SAVE_TYPES.CHARACTER_SHEET);
            assert.ok(sheetType);
            assert.equal(sheetType.storageFolder, "character-sheets");
            assert.ok(sheetType.allowedMimeTypes.includes("image/jpeg"));
            assert.ok(!sheetType.allowedMimeTypes.includes("video/mp4"));

            const elementRef = saveTypeRegistry.get(SAVE_TYPES.ELEMENT_REFERENCE);
            assert.ok(elementRef);
            assert.equal(elementRef.storageFolder, "element-references");
        });

        it("validates payload against MIME and size rules", () => {
            const validResult = saveTypeRegistry.validate(SAVE_TYPES.CHARACTER_SHEET, {
                mimeType: "image/png",
                sizeBytes: 1024 * 1024,
            });
            assert.equal(validResult.valid, true);

            const invalidMime = saveTypeRegistry.validate(SAVE_TYPES.CHARACTER_SHEET, {
                mimeType: "video/mp4",
                sizeBytes: 1024,
            });
            assert.equal(invalidMime.valid, false);
            assert.match(invalidMime.error, /MIME type "video\/mp4" is not allowed/);

            const oversized = saveTypeRegistry.validate(SAVE_TYPES.CHARACTER_SHEET, {
                mimeType: "image/png",
                sizeBytes: 50 * 1024 * 1024, // 50MB > 20MB limit
            });
            assert.equal(oversized.valid, false);
            assert.match(oversized.error, /exceeds maximum of/);
        });

        it("supports dynamic registration of new custom save types", () => {
            saveTypeRegistry.register("custom_sticker", {
                storageFolder: "stickers",
                allowedMimeTypes: ["image/webp"],
                maxSizeBytes: 5 * 1024 * 1024,
                retention: RETENTION_POLICIES.TEMPORARY_30D,
            });

            assert.equal(saveTypeRegistry.has("custom_sticker"), true);
            const stickerConfig = saveTypeRegistry.get("custom_sticker");
            assert.equal(stickerConfig.storageFolder, "stickers");
            assert.equal(stickerConfig.retention, RETENTION_POLICIES.TEMPORARY_30D);
        });
    });

    describe("2. Storage Provider & StorageService", () => {
        let memProvider;
        let storageService;

        beforeEach(() => {
            memProvider = new InMemoryStorageProvider({
                bucketName: "test-bucket",
                baseUrl: "https://cdn.example.com",
            });
            storageService = new StorageService("test-bucket", memProvider);
        });

        it("uploads and resolves public CDN URLs via InMemoryStorageProvider", async () => {
            const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic bytes
            const url = await storageService.upload("user123/uploads/image.png", buffer, {
                contentType: "image/png",
            });

            assert.equal(url, "https://cdn.example.com/test-bucket/user123/uploads/image.png");
            assert.equal(memProvider.has("user123/uploads/image.png"), true);
        });

        it("validates storage folders and builds canonical keys", () => {
            const key = storageService.buildKey({
                userId: "user_abc-123",
                folder: "character-sheets",
                filename: "pose.png",
            });
            assert.equal(key, "user_abc-123/character-sheets/pose.png");
        });

        it("rejects invalid storage folders with StorageValidationError", () => {
            assert.throws(() => {
                storageService.validateFolder("../malicious/traversal");
            }, StorageValidationError);
        });

        it("extracts storage key from full CDN URLs", () => {
            const extracted = storageService.extractKey("https://cdn.example.com/test-bucket/user123/uploads/pic.png");
            assert.equal(extracted, "user123/uploads/pic.png");
        });

        it("deletes single and batch files cleanly", async () => {
            const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG
            await storageService.upload("file1.jpg", buf, { contentType: "image/jpeg" });
            await storageService.upload("file2.jpg", buf, { contentType: "image/jpeg" });

            assert.equal(memProvider.has("file1.jpg"), true);
            assert.equal(memProvider.has("file2.jpg"), true);

            const result = await storageService.deleteFiles(["file1.jpg", "file2.jpg"]);
            assert.equal(result.deletedCount, 2);
            assert.equal(memProvider.has("file1.jpg"), false);
            assert.equal(memProvider.has("file2.jpg"), false);
        });
    });

    describe("3. Media Tools Gateway (#media/tools)", () => {
        beforeEach(() => {
            WorkflowMediaRepository.enableTestMemoryFallback();
            WorkflowMediaRepository.clearMemory();
        });

        it("validates input when creating pending media", async () => {
            await assert.rejects(
                () => createPendingMedia({}),
                MediaValidationError
            );
        });

        it("validates input when marking media failed", async () => {
            await assert.rejects(
                () => markMediaFailed({}),
                MediaValidationError
            );
        });

        it("links media to workflow with role", async () => {
            const link = await linkMediaToEntity({
                mediaId: "media-uuid-1",
                workflowId: "wf-uuid-1",
                role: "sheet",
                isPrimary: true,
            });

            assert.equal(link.mediaId, "media-uuid-1");
            assert.equal(link.workflowId, "wf-uuid-1");
            assert.equal(link.role, "sheet");
            assert.equal(link.isPrimary, true);
        });

        it("handles empty array in getMediaUrls safely", async () => {
            const urls = await getMediaUrls([]);
            assert.deepEqual(urls, []);
        });

        it("validates mediaId when deleting media", async () => {
            await assert.rejects(
                () => deleteMedia({}),
                MediaValidationError
            );
        });
    });

    describe("4. Media Public API Routers (#media/api)", () => {
        it("exports valid Express routers for all canonical entry points", () => {
            assert.ok(mediaRouter);
            assert.equal(typeof mediaRouter, "function");
            assert.ok(assetsRouter);
            assert.equal(typeof assetsRouter, "function");
            assert.ok(mediaIngestRouter);
            assert.equal(typeof mediaIngestRouter, "function");
        });
    });
});
