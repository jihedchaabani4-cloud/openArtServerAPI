import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as mediaToolsNamespace from "#media/tools";
import * as mediaApiNamespace from "#media/api";
import {
    MediaError,
    MediaValidationError,
    MediaNotFoundError,
    MediaConflictError,
    MediaRepository,
    WorkflowMediaRepository,
    configureMedia,
    getMediaRepository,
    getWorkflowMediaRepository,
    getStorageService,
    createPendingMedia,
    markMediaFailed,
    linkMediaToEntity,
    getMediaUrls,
    deleteMedia,
    MediaService,
    resolveMediaMetadata,
    isMediaInFlight,
    hasInFlightMedia,
    areAllWorkflowMediaFailed,
} from "#media/tools";
import { assetsRouter, mediaIngestRouter, createUploadMiddleware } from "#media/api";
import { saveTypeRegistry, SAVE_TYPES, RETENTION_POLICIES } from "../../../src/systems/media/internal/services/saveTypes.js";
import { StorageService } from "../../../src/systems/media/internal/storage/StorageService.js";
import { StoragePathResolver } from "../../../src/systems/media/internal/storage/StoragePathResolver.js";
import { InMemoryStorageProvider } from "../../../src/systems/media/internal/storage/providers/InMemoryStorageProvider.js";
import { StorageValidationError } from "../../../src/systems/media/internal/errors.js";
import { getMediaService } from "../../../src/systems/media/internal/services/serviceAccessor.js";
import { MEDIA_IN_FLIGHT_STATUSES, isMediaFailed } from "../../../src/systems/media/internal/services/MediaLifecycleService.js";
import { handleDeleteMedia, handleGetMedia } from "../../../src/systems/media/internal/controllers/mediaController.js";
import { assertOwns, IdentityForbiddenError, configureOwnershipResolvers } from "#identity/tools";
import { createOwnershipResolvers } from "../../../src/container.js";
const setIdentityDb = (targetDb) => configureOwnershipResolvers(createOwnershipResolvers(targetDb));
import { randomUUID } from "node:crypto";
import { AppError, calculateAspectRatio } from "#shared";

// ─── Source: mediaSystem.test.js ───
{
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

    describe("4. Media Public API & Tools Sealed Surface (#media/api, #media/tools)", () => {
        it("seals #media/api to exact production surface (assetsRouter, mediaIngestRouter, createUploadMiddleware)", () => {
            assert.deepEqual(
                Object.keys(mediaApiNamespace).sort(),
                ["assetsRouter", "createUploadMiddleware", "mediaIngestRouter"]
            );
            assert.equal(typeof assetsRouter, "function");
            assert.equal(typeof mediaIngestRouter, "function");
            assert.equal(typeof createUploadMiddleware, "function");

            for (const forbidden of [
                "mediaRouter",
                "resolveMiddlewarePolicy",
                "handleDeleteMedia",
                "handleGetMedia",
                "default",
            ]) {
                assert.equal(mediaApiNamespace[forbidden], undefined, `#media/api must not export ${forbidden}`);
            }
        });

        it("seals #media/tools to exact production surface (zero test hooks, storage internals, ingestion internals, or default bag)", () => {
            const expectedToolsExports = [
                "AssetUploadService",
                "CHARACTER_DETAIL_UPLOAD_POLICY",
                "CHARACTER_SHEET_UPLOAD_POLICY",
                "ELEMENT_REFERENCE_UPLOAD_POLICY",
                "ELEMENT_SHEET_UPLOAD_POLICY",
                "MEDIA_WORKFLOW_STATUS",
                "MediaConflictError",
                "MediaError",
                "MediaNotFoundError",
                "MediaQuotaError",
                "MediaRepository",
                "MediaService",
                "MediaStorageError",
                "MediaUploadError",
                "MediaUploadService",
                "MediaValidationError",
                "MediaWorkflowLifecycleService",
                "QuotaError",
                "UploadError",
                "ValidationError",
                "WorkflowMediaRepository",
                "appendMediaToWorkflow",
                "areAllWorkflowMediaFailed",
                "completeMedia",
                "configureMedia",
                "createGenerationPlaceholderAtomic",
                "createMediaInWorkflow",
                "createPendingMedia",
                "deleteMedia",
                "getMediaById",
                "getMediaRepository",
                "getMediaUrls",
                "getStorageService",
                "getWorkflowMediaRepository",
                "getWorkflowPrimaryMedia",
                "getWorkflowVisualMedia",
                "hasInFlightMedia",
                "isMediaInFlight",
                "isWorkflowReferenceQuotaError",
                "linkMediaToEntity",
                "markMediaFailed",
                "persistExternalMedia",
                "resolveMediaMetadata",
            ].sort();

            assert.deepEqual(Object.keys(mediaToolsNamespace).sort(), expectedToolsExports);

            for (const forbidden of [
                "resetActiveUploadsForTest",
                "resetInFlightBytesForTest",
                "getActiveUploadsCountForTest",
                "getInFlightBytesForTest",
                "setStorageService",
                "StorageService",
                "StoragePathResolver",
                "createStorageService",
                "IStorageProvider",
                "InMemoryStorageProvider",
                "SupabaseStorageProvider",
                "storagePathResolver",
                "StorageError",
                "StorageValidationError",
                "isStream",
                "MediaInspector",
                "SourceResolver",
                "SourceReader",
                "SourcePolicy",
                "extractImageMetadata",
                "extractVideoMetadata",
                "extractMediaMetadata",
                "createSizeLimitedMemoryStorage",
                "createPayloadTooLargeError",
                "saveTypeRegistry",
                "SAVE_TYPES",
                "RETENTION_POLICIES",
                "getSaveTypeRegistry",
                "DEFAULT_UPLOAD_POLICY",
                "GENERATED_OUTPUT_UPLOAD_POLICY",
                "ELEMENT_SOURCES_UPLOAD_POLICY",
                "UPLOAD_POLICIES",
                "WORKFLOW_MEDIA_ROLES",
                "normalizeWorkflowMediaRole",
                "inferWorkflowMediaRole",
                "linkWorkflowMediaForCreatedRow",
                "markMediaStatus",
                "WORKFLOW_REFERENCE_QUOTA_PREFIX",
                "WORKFLOW_REFERENCE_QUOTA_PATTERN",
                "formatWorkflowReferenceQuotaMessage",
                "MEDIA_IN_FLIGHT_STATUSES",
                "isMediaFailed",
                "failWorkflowPendingMedia",
                "calculateAspectRatio",
                "getMediaUploadService",
                "getMediaService",
                "default",
            ]) {
                assert.equal(mediaToolsNamespace[forbidden], undefined, `#media/tools must not export ${forbidden}`);
            }
        });
    });
});
}

// ─── Source: mediaServiceContract.test.js ───
{
process.env.NODE_ENV = "test";


const VALID_PNG_1X1 = Buffer.from([
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

function makeInMemoryMediaRepo({ failWith = null } = {}) {
    const rows = new Map();
    let seq = 0;

    return {
        rows,
        async createMedia(payload) {
            if (failWith) throw failWith;
            seq += 1;
            const row = {
                id: `media-${seq}`,
                project_id: payload.project_id ?? null,
                step_id: payload.step_id ?? "upload",
                url: payload.url,
                width: payload.width ?? 1024,
                height: payload.height ?? 1024,
                status: payload.status ?? "success",
                error_message: payload.error_message ?? null,
                ...payload,
            };
            rows.set(row.id, row);
            return row;
        },
        async findById(id) {
            if (failWith) throw failWith;
            return rows.get(id) ?? null;
        },
        async findByIds(ids) {
            if (failWith) throw failWith;
            return (ids || []).map((id) => rows.get(id)).filter(Boolean);
        },
        async findByUrl(url) {
            if (failWith) throw failWith;
            for (const row of rows.values()) {
                if (row.url === url) return row;
            }
            return null;
        },
        async findByProject(projectId, limit = 30, offset = 0) {
            if (failWith) throw failWith;
            const matching = [...rows.values()].filter((r) => r.project_id === projectId);
            return matching.slice(offset, offset + limit);
        },
        async findMediaOwnershipRecord(mediaId) {
            if (failWith) throw failWith;
            const row = rows.get(mediaId);
            if (!row) return null;
            return { id: row.id, project: { user_id: row.owner_user_id ?? null } };
        },
        async listAll({ projectId = null, limit = 500 } = {}) {
            if (failWith) throw failWith;
            const all = [...rows.values()].filter((r) => !projectId || r.project_id === projectId);
            return all.slice(0, limit).map(({ id, url, project_id }) => ({ id, url, project_id }));
        },
        async updateFields(id, fields) {
            if (failWith) throw failWith;
            const existing = rows.get(id);
            if (!existing) throw new Error(`Media ${id} not found`);
            const updated = { ...existing, ...fields };
            rows.set(id, updated);
            return updated;
        },
        async deleteById(id) {
            if (failWith) throw failWith;
            return rows.delete(id);
        },
    };
}

describe("Platform Media & Media-Ingestion Public Barrels", () => {
    it("exports sealed media-ingestion contract without leaking low-level ingestion internals or legacy classes", async () => {
        const ingestionBarrel = await import("#media/tools");

        assert.equal(typeof ingestionBarrel.MediaUploadService, "function");
        assert.equal(typeof ingestionBarrel.ValidationError, "function");
        assert.equal(typeof ingestionBarrel.UploadError, "function");
        assert.equal(typeof ingestionBarrel.QuotaError, "function");
        assert.equal(typeof ingestionBarrel.isWorkflowReferenceQuotaError, "function");

        assert.equal("BinaryIngestionService" in ingestionBarrel, false);
        assert.equal("MediaIngestionService" in ingestionBarrel, false);
        assert.equal("SourcePolicy" in ingestionBarrel, false);
        assert.equal("SourceReader" in ingestionBarrel, false);
        assert.equal("SourceResolver" in ingestionBarrel, false);
        assert.equal("MediaInspector" in ingestionBarrel, false);
    });

    it("exports the sealed platform media public contract", async () => {
        const mediaBarrel = await import("#media/tools");

        assert.equal(typeof mediaBarrel.MediaService, "function");
        assert.equal(typeof mediaBarrel.MediaWorkflowLifecycleService, "function");
        assert.equal(typeof mediaBarrel.MEDIA_WORKFLOW_STATUS, "object");
        assert.equal(typeof mediaBarrel.isMediaInFlight, "function");
        assert.equal(typeof mediaBarrel.hasInFlightMedia, "function");
        assert.equal(typeof mediaBarrel.areAllWorkflowMediaFailed, "function");
        assert.equal(typeof mediaBarrel.MediaConflictError, "function");
        assert.equal(typeof mediaBarrel.resolveMediaMetadata, "function");
    });
});

describe("MediaUploadService — StorageService Phase 1 Contract & Boundary Isolation", () => {
    it("throws on construction when storageService lacks required Phase 1 contract methods", async () => {
        const { MediaUploadService } = await import("#media/tools");

        assert.throws(() => new MediaUploadService(), /storageService/);
        assert.throws(() => new MediaUploadService({ storageService: {} }), /storageService/);
        assert.throws(
            () => new MediaUploadService({ storageService: { upload: () => {}, deleteFiles: () => {} } }),
            /buildKey|validateFolder/
        );
    });

    it("uploads via storageService.buildKey and storageService.validateFolder without touching storageService.paths", async () => {
        const { MediaUploadService } = await import("#media/tools");
        const provider = new InMemoryStorageProvider({ bucketName: "test-bucket" });
        const realStorage = new StorageService("test-bucket", provider);

        const strictStorageProxy = {
            upload: (...args) => realStorage.upload(...args),
            deleteFiles: (...args) => realStorage.deleteFiles(...args),
            buildKey: (...args) => realStorage.buildKey(...args),
            validateFolder: (...args) => realStorage.validateFolder(...args),
            get paths() {
                throw new Error("MediaUploadService must not access deprecated storageService.paths");
            },
        };

        const uploadService = new MediaUploadService({ storageService: strictStorageProxy });
        const { uploaded } = await uploadService.upload({
            files: [{ buffer: VALID_PNG_1X1, originalname: "avatar.png", mimetype: "image/png" }],
            userId: "user-42",
        });

        assert.equal(uploaded.length, 1);
        assert.match(uploaded[0].storageKey, /^user-42\/uploads\/\d+_[a-f0-9]+\.png$/);
        assert.equal(provider.has(uploaded[0].storageKey), true);

        await uploadService.discard([uploaded[0].storageKey]);
        await uploadService.discard([uploaded[0].storageKey]); // idempotent second call
        assert.equal(provider.has(uploaded[0].storageKey), false);
    });
});

describe("MediaService — Canonical public.media Ownership & Error Propagation", () => {
    it("throws on construction when neither mediaRepo nor db.media is provided", async () => {
        const { MediaService } = await import("#media/tools");

        assert.throws(() => new MediaService(), /mediaRepo|db\.media/);
        assert.throws(() => new MediaService({ db: {} }), /mediaRepo|db\.media/);
    });

    it("creates, queries, updates, and deletes public.media records without touching workflow_media", async () => {
        const { MediaService } = await import("#media/tools");
        const mediaRepo = makeInMemoryMediaRepo();
        let workflowMediaTouched = false;

        const service = new MediaService({
            db: {
                media: mediaRepo,
                workflowMedia: new Proxy({}, {
                    get() {
                        workflowMediaTouched = true;
                        throw new Error("MediaService must never access db.workflowMedia");
                    },
                }),
            },
        });

        const created = await service.createMedia({
            projectId: "proj-1",
            stepId: "upload",
            url: "https://cdn.example.com/u1/uploads/img.png",
            width: 800,
            height: 600,
            workflowId: "accidental-wf-id",
            role: "original",
            is_primary: true,
        });

        assert.equal(workflowMediaTouched, false, "MediaService must never write to workflow_media");
        assert.equal(created.project_id, "proj-1");
        assert.equal(created.width, 800);
        assert.equal(created.height, 600);
        assert.equal("workflowId" in created, false);
        assert.equal("workflow_id" in created, false);
        assert.equal("role" in created, false);
        assert.equal("is_primary" in created, false);

        const found = await service.findById(created.id);
        assert.equal(found.id, created.id);

        const byUrl = await service.findByUrl("https://cdn.example.com/u1/uploads/img.png");
        assert.equal(byUrl.id, created.id);

        const listed = await service.listAll({ projectId: "proj-1", limit: 10 });
        assert.equal(listed.length, 1);
        assert.equal(listed[0].id, created.id);

        const failed = await service.updateStatus(created.id, "failed", "Provider timeout");
        assert.equal(failed.status, "failed");
        assert.equal(failed.error_message, "Provider timeout");

        const deleted = await service.deleteById(created.id);
        assert.equal(deleted, true);
        assert.equal(await service.findById(created.id), null);
    });

    it("propagates database errors on read methods instead of silently returning null or empty arrays", async () => {
        const { MediaService } = await import("#media/tools");
        const mediaRepo = makeInMemoryMediaRepo({ failWith: new Error("db connection lost") });
        const service = new MediaService({ mediaRepo });

        await assert.rejects(() => service.findById("m-1"), /db connection lost/);
        await assert.rejects(() => service.findByIds(["m-1"]), /db connection lost/);
        await assert.rejects(() => service.findOwnershipRecord("m-1"), /db connection lost/);
    });

    it("getOwnedMedia enforces fail-closed ownership and returns formatted DTO only for owned media", async () => {
        const mediaRepo = makeInMemoryMediaRepo();
        const created = await mediaRepo.createMedia({
            project_id: "proj-alice",
            owner_user_id: "user-alice",
            step_id: "image_generation",
            url: "https://cdn.example.com/alice/out.png",
            width: 1280,
            height: 720,
            status: "success",
            error_message: null,
            create_time: "2026-01-01T12:00:00.000Z",
        });

        // 1. Default fail-closed ownership path (via mediaRepo.findMediaOwnershipRecord)
        const defaultService = new MediaService({ mediaRepo });

        const dto = await defaultService.getOwnedMedia({ mediaId: created.id, userId: "user-alice" });
        assert.deepEqual(dto, {
            id: created.id,
            url: "https://cdn.example.com/alice/out.png",
            width: 1280,
            height: 720,
            status: "success",
            stepId: "image_generation",
            projectId: "proj-alice",
            createTime: "2026-01-01T12:00:00.000Z",
            errorMessage: null,
        });

        // Foreign/unowned media fails closed with 404 MediaNotFoundError
        await assert.rejects(
            () => defaultService.getOwnedMedia({ mediaId: created.id, userId: "user-bob" }),
            (err) => err instanceof MediaNotFoundError && err.statusCode === 404
        );

        // Missing media returns 404 MediaNotFoundError
        await assert.rejects(
            () => defaultService.getOwnedMedia({ mediaId: "missing-media-id", userId: "user-alice" }),
            (err) => err instanceof MediaNotFoundError && err.statusCode === 404
        );

        // Empty mediaId throws 404 MediaNotFoundError
        await assert.rejects(
            () => defaultService.getOwnedMedia({ mediaId: "  ", userId: "user-alice" }),
            (err) => err instanceof MediaNotFoundError && err.statusCode === 404
        );

        // Missing userId fails closed with 401
        await assert.rejects(
            () => defaultService.getOwnedMedia({ mediaId: created.id, userId: null }),
            (err) => err instanceof AppError && err.statusCode === 401
        );

        // 2. Injected #identity/tools assertOwns integration
        setIdentityDb({
            media: mediaRepo,
            projects: {
                findByUser: async (userId, projectId) =>
                    userId === "user-alice" && projectId === "proj-alice"
                        ? [{ id: "proj-alice", user_id: "user-alice" }]
                        : [],
            },
        });

        try {
            const identityService = new MediaService({ mediaRepo, assertOwnsFn: assertOwns });
            const ownedViaIdentity = await identityService.getOwnedMedia({
                mediaId: created.id,
                userId: "user-alice",
            });
            assert.equal(ownedViaIdentity.id, created.id);

            await assert.rejects(
                () => identityService.getOwnedMedia({ mediaId: created.id, userId: "user-bob" }),
                (err) => err instanceof AppError && err.statusCode === 404
            );

            // When assertOwnsFn succeeds but repo row is gone, throws 404 MediaNotFoundError
            const serviceWithStub = new MediaService({
                mediaRepo,
                assertOwnsFn: async () => ({ id: "ghost-id" }),
            });
            await assert.rejects(
                () => serviceWithStub.getOwnedMedia({ mediaId: "ghost-id", userId: "user-alice" }),
                (err) => err instanceof MediaNotFoundError && err.statusCode === 404
            );
        } finally {
            setIdentityDb(null);
        }
    });

    it("handleGetMedia routes through MediaService: returns 200 DTO for owned, 403/404 for foreign, 404 for missing", async () => {
        const previousMediaService = getMediaService();
        const mediaRepo = makeInMemoryMediaRepo();
        const created = await mediaRepo.createMedia({
            project_id: "proj-owner",
            step_id: "upload",
            url: "https://cdn.example.com/owner/pic.png",
            width: 512,
            height: 512,
            status: "success",
            error_message: null,
            create_time: "2026-02-01T00:00:00.000Z",
        });

        const ownershipCalls = [];
        const testService = new MediaService({
            mediaRepo,
            assertOwnsFn: async (resourceType, mediaId, userId) => {
                ownershipCalls.push({ resourceType, mediaId, userId });
                if (userId === "user-forbidden") {
                    throw new IdentityForbiddenError("Forbidden");
                }
                if (userId !== "user-owner" || mediaId !== created.id) {
                    throw new AppError("Media not found", 404);
                }
                return created;
            },
        });

        configureMedia({ mediaService: testService });

        const invoke = async (req) => {
            let statusCode = 200;
            let body = null;
            const res = {
                status(code) {
                    statusCode = code;
                    return this;
                },
                json(payload) {
                    body = payload;
                    return this;
                },
            };
            await handleGetMedia(req, res);
            return { statusCode, body };
        };

        try {
            // 1. Owned media -> 200 DTO
            const owned = await invoke({ params: { id: created.id }, user: { id: "user-owner" } });
            assert.equal(owned.statusCode, 200);
            assert.equal(owned.body.ok, true);
            assert.deepEqual(owned.body.media, {
                id: created.id,
                url: "https://cdn.example.com/owner/pic.png",
                width: 512,
                height: 512,
                status: "success",
                stepId: "upload",
                projectId: "proj-owner",
                createTime: "2026-02-01T00:00:00.000Z",
                errorMessage: null,
            });

            // 2. Foreign/unowned media -> 404 fail-closed
            const foreign = await invoke({ params: { id: created.id }, user: { id: "user-intruder" } });
            assert.equal(foreign.statusCode, 404);
            assert.equal(foreign.body.ok, false);
            assert.equal(foreign.body.errorCode, "NOT_FOUND");
            assert.equal(foreign.body.media, undefined);

            // 3. Explicit 403 forbidden error -> 403 fail-closed
            const forbidden = await invoke({ params: { id: created.id }, user: { id: "user-forbidden" } });
            assert.equal(forbidden.statusCode, 403);
            assert.equal(forbidden.body.ok, false);
            assert.equal(forbidden.body.media, undefined);

            // 4. Missing media -> 404
            const missing = await invoke({ params: { id: "non-existent" }, user: { id: "user-owner" } });
            assert.equal(missing.statusCode, 404);
            assert.equal(missing.body.ok, false);
            assert.equal(missing.body.errorCode, "NOT_FOUND");

            // 5. Missing id param -> 404
            const noId = await invoke({ params: {}, user: { id: "user-owner" } });
            assert.equal(noId.statusCode, 404);
            assert.equal(noId.body.ok, false);
            assert.equal(noId.body.errorCode, "NOT_FOUND");

            assert.equal(ownershipCalls.length, 4);
            assert.deepEqual(ownershipCalls[0], {
                resourceType: "media",
                mediaId: created.id,
                userId: "user-owner",
            });
        } finally {
            configureMedia({ mediaService: previousMediaService });
        }
    });
});

describe("MediaRepository — Ownership, Listing, and Stale Placeholder Queries", () => {
    it("findMediaOwnershipRecord returns the media row with project owner and propagates DB errors", async () => {
        const repo = new MediaRepository();
        repo.client = () => ({
            from: (table) => {
                assert.equal(table, "media");
                return {
                    select: () => ({
                        eq: (_col, val) => ({
                            maybeSingle: async () => {
                                if (val === "err-id") return { data: null, error: new Error("supabase timeout") };
                                if (val === "missing-id") return { data: null, error: null };
                                return { data: { id: val, project: { user_id: "owner-1" } }, error: null };
                            },
                        }),
                    }),
                };
            },
        });

        assert.equal(await repo.findMediaOwnershipRecord(null), null);
        assert.equal(await repo.findMediaOwnershipRecord("missing-id"), null);
        assert.deepEqual(await repo.findMediaOwnershipRecord("m-1"), {
            id: "m-1",
            project: { user_id: "owner-1" },
        });
        await assert.rejects(() => repo.findMediaOwnershipRecord("err-id"), /supabase timeout/);
    });

    it("listAll and findStalePlaceholders build scoped queries against media table", async () => {
        const repo = new MediaRepository();
        const filters = [];

        repo.client = () => ({
            from: (table) => {
                assert.equal(table, "media");
                const builder = {
                    select: (cols) => {
                        filters.push(["select", cols]);
                        return builder;
                    },
                    eq: (col, val) => {
                        filters.push(["eq", col, val]);
                        return builder;
                    },
                    in: (col, vals) => {
                        filters.push(["in", col, vals]);
                        return builder;
                    },
                    lt: (col, val) => {
                        filters.push(["lt", col, val]);
                        return builder;
                    },
                    limit: (n) => {
                        filters.push(["limit", n]);
                        return builder;
                    },
                    then: (resolve) => resolve({ data: [{ id: "m-1", url: "https://x/1.png", project_id: "p-1" }], error: null }),
                };
                return builder;
            },
        });

        const items = await repo.listAll({ projectId: "p-1", limit: 25 });
        assert.equal(items.length, 1);
        assert.deepEqual(filters, [
            ["select", "id, url, project_id"],
            ["eq", "project_id", "p-1"],
            ["limit", 25],
        ]);

        filters.length = 0;
        const stale = await repo.findStalePlaceholders("2026-01-01T00:00:00.000Z");
        assert.equal(stale.length, 1);
        assert.deepEqual(filters, [
            ["select", "id, status, create_time, project_id"],
            ["in", "status", ["processing", "pending"]],
            ["lt", "create_time", "2026-01-01T00:00:00.000Z"],
        ]);
    });

    it("findMediaStatusesByWorkflowIds batch-fetches, groups, deduplicates, and propagates DB errors", async () => {
        const repo = new MediaRepository();
        let queryCount = 0;
        let queriedTable = null;
        let queriedIn = null;

        repo.client = () => ({
            from: (table) => {
                queryCount += 1;
                queriedTable = table;
                return {
                    select: () => ({
                        in: async (col, vals) => {
                            queriedIn = { col, vals };
                            if (vals.includes("wf-err")) {
                                return { data: null, error: new Error("batch status failure") };
                            }
                            return {
                                data: [
                                    { workflow_id: "wf-1", media_id: "m-1", media: { id: "m-1", status: "processing", url: null } },
                                    { workflow_id: "wf-1", media_id: "m-1", media: { id: "m-1", status: "processing", url: null } },
                                    { workflow_id: "wf-2", media_id: "m-2", media: [{ id: "m-2", status: "failed", url: null }] },
                                    { workflow_id: "wf-2", media_id: "m-3", media: { id: "m-3", status: "success", url: "https://cdn/3.png" } },
                                ],
                                error: null,
                            };
                        },
                    }),
                };
            },
        });

        const empty = await repo.findMediaStatusesByWorkflowIds([]);
        assert.equal(empty.size, 0);
        assert.equal(queryCount, 0);

        const result = await repo.findMediaStatusesByWorkflowIds(["wf-1", "wf-2", "wf-empty", "wf-1"]);
        assert.equal(queryCount, 1);
        assert.equal(queriedTable, "workflow_media");
        assert.deepEqual(queriedIn, { col: "workflow_id", vals: ["wf-1", "wf-2", "wf-empty"] });
        assert.deepEqual(result.get("wf-1"), [{ id: "m-1", status: "processing", url: null }]);
        assert.deepEqual(result.get("wf-2"), [
            { id: "m-2", status: "failed", url: null },
            { id: "m-3", status: "success", url: "https://cdn/3.png" },
        ]);
        assert.deepEqual(result.get("wf-empty"), []);

        await assert.rejects(() => repo.findMediaStatusesByWorkflowIds(["wf-err"]), /batch status failure/);
    });

    it("hasInFlightMediaByProjectId queries in-flight statuses with limit(1) and propagates errors", async () => {
        const repo = new MediaRepository();
        const filters = [];

        repo.client = () => ({
            from: (table) => {
                assert.equal(table, "media");
                let projectIdVal = null;
                const builder = {
                    select: (cols) => {
                        filters.push(["select", cols]);
                        return builder;
                    },
                    eq: (col, val) => {
                        filters.push(["eq", col, val]);
                        projectIdVal = val;
                        return builder;
                    },
                    in: (col, vals) => {
                        filters.push(["in", col, vals]);
                        return builder;
                    },
                    limit: (n) => {
                        filters.push(["limit", n]);
                        return builder;
                    },
                    then: (resolve) => {
                        if (projectIdVal === "proj-err") {
                            return resolve({ data: null, error: new Error("project check failed") });
                        }
                        if (projectIdVal === "proj-busy") {
                            return resolve({ data: [{ id: "m-busy" }], error: null });
                        }
                        return resolve({ data: [], error: null });
                    },
                };
                return builder;
            },
        });

        assert.equal(await repo.hasInFlightMediaByProjectId(null), false);
        assert.equal(filters.length, 0);

        assert.equal(await repo.hasInFlightMediaByProjectId("proj-busy"), true);
        assert.deepEqual(filters, [
            ["select", "id"],
            ["eq", "project_id", "proj-busy"],
            ["in", "status", [...MEDIA_IN_FLIGHT_STATUSES]],
            ["limit", 1],
        ]);

        assert.equal(await repo.hasInFlightMediaByProjectId("proj-idle"), false);
        await assert.rejects(() => repo.hasInFlightMediaByProjectId("proj-err"), /project check failed/);
    });
});

describe("WorkflowMediaRepository — Batch Media Status Lookup", () => {
    it("findMediaStatusesByWorkflowIds works in DB mode and in test memory mode", async () => {
        const dbRepo = new WorkflowMediaRepository();
        dbRepo.client = () => ({
            from: (table) => {
                assert.equal(table, "workflow_media");
                return {
                    select: () => ({
                        in: async (_col, vals) => {
                            if (vals.includes("wf-db-err")) {
                                return { data: null, error: new Error("wf status db error") };
                            }
                            return {
                                data: [
                                    { workflow_id: "wf-a", media_id: "m-a1", media: { id: "m-a1", status: "failed", url: null } },
                                    { workflow_id: "wf-a", media_id: "m-a1", media: { id: "m-a1", status: "failed", url: null } },
                                    { workflow_id: "wf-b", media_id: "m-b1", media: { id: "m-b1", status: "queued", url: null } },
                                ],
                                error: null,
                            };
                        },
                    }),
                };
            },
        });

        const map = await dbRepo.findMediaStatusesByWorkflowIds(["wf-a", "wf-b", "wf-c"]);
        assert.deepEqual(map.get("wf-a"), [{ id: "m-a1", status: "failed", url: null }]);
        assert.deepEqual(map.get("wf-b"), [{ id: "m-b1", status: "queued", url: null }]);
        assert.deepEqual(map.get("wf-c"), []);
        await assert.rejects(() => dbRepo.findMediaStatusesByWorkflowIds(["wf-db-err"]), /wf status db error/);

        // Test memory mode (preserve prior global test memory mode state)
        const prevMemoryMode = WorkflowMediaRepository.useMemoryFallback;
        WorkflowMediaRepository.enableTestMemoryFallback();
        WorkflowMediaRepository.clearMemory();
        try {
            const memRepo = new WorkflowMediaRepository();
            await memRepo.linkMedia({ workflowId: "wf-mem-1", mediaId: "m-mem-1", role: "output" });
            await memRepo.linkMedia({ workflowId: "wf-mem-1", mediaId: "m-mem-1", role: "detail" });
            WorkflowMediaRepository.getMemoryStore()[0].status = "processing";

            const memMap = await memRepo.findMediaStatusesByWorkflowIds(["wf-mem-1", "wf-mem-empty"]);
            assert.deepEqual(memMap.get("wf-mem-1"), [{ id: "m-mem-1", status: "processing", url: null }]);
            assert.deepEqual(memMap.get("wf-mem-empty"), []);
        } finally {
            WorkflowMediaRepository.clearMemory();
            WorkflowMediaRepository.useMemoryFallback = prevMemoryMode;
        }
    });
});

describe("Media Deletion Status Predicates, MediaConflictError & deleteMedia Guard", () => {
    it("exports frozen MEDIA_IN_FLIGHT_STATUSES and evaluates in-flight/failed predicates accurately", () => {
        assert.ok(Object.isFrozen(MEDIA_IN_FLIGHT_STATUSES));
        assert.deepEqual(MEDIA_IN_FLIGHT_STATUSES, [
            "processing",
            "pending",
            "queued",
            "uploading",
            "in_progress",
            "starting",
        ]);

        for (const st of MEDIA_IN_FLIGHT_STATUSES) {
            assert.equal(isMediaInFlight(st), true, `expected ${st} to be in-flight`);
            assert.equal(isMediaInFlight(`  ${st.toUpperCase()}  `), true);
            assert.equal(isMediaInFlight({ status: st }), true);
            assert.equal(isMediaFailed(st), false);
        }

        // Terminal, empty, and missing statuses MUST NOT be treated as in-flight (protects minimal test mocks)
        for (const nonFlight of ["success", "completed", "failed", "saved", "", "   ", null, undefined, {}, { id: "m1" }, { status: null }, { status: undefined }]) {
            assert.equal(isMediaInFlight(nonFlight), false, `expected ${JSON.stringify(nonFlight)} not to be in-flight`);
        }

        assert.equal(isMediaFailed("failed"), true);
        assert.equal(isMediaFailed("  FAILED "), true);
        assert.equal(isMediaFailed({ status: "failed" }), true);
        assert.equal(isMediaFailed({ status: "success" }), false);
        assert.equal(isMediaFailed({}), false);
        assert.equal(isMediaFailed(null), false);

        assert.equal(hasInFlightMedia([]), false);
        assert.equal(hasInFlightMedia(null), false);
        assert.equal(hasInFlightMedia([{ status: "failed" }, { status: "success" }]), false);
        assert.equal(hasInFlightMedia([{ status: "failed" }, { status: "processing" }]), true);

        assert.equal(areAllWorkflowMediaFailed([]), false);
        assert.equal(areAllWorkflowMediaFailed(null), false);
        assert.equal(areAllWorkflowMediaFailed([{ status: "failed" }]), true);
        assert.equal(areAllWorkflowMediaFailed([{ status: "failed" }, { status: "FAILED" }]), true);
        assert.equal(areAllWorkflowMediaFailed([{ status: "failed" }, { status: "success" }]), false);
        assert.equal(areAllWorkflowMediaFailed([{ status: "failed" }, {}]), false);
    });

    it("MediaConflictError provides 409 MEDIA_PROCESSING defaults and maps cleanly through handleDeleteMedia", async () => {
        const defaultErr = new MediaConflictError();
        assert.ok(defaultErr instanceof MediaConflictError);
        assert.ok(defaultErr instanceof MediaError);
        assert.ok(defaultErr instanceof AppError);
        assert.equal(defaultErr.statusCode, 409);
        assert.equal(defaultErr.code, "MEDIA_PROCESSING");
        assert.equal(defaultErr.errorCode, "MEDIA_PROCESSING");
        assert.equal(defaultErr.category, "USER_FAULT");
        assert.equal(defaultErr.message, "Cannot delete media while it is still processing");
        assert.equal(defaultErr.safeMessage, "Cannot delete media while it is still processing");

        const customErr = new MediaConflictError("Custom busy message", { context: { mediaId: "m-1" } });
        assert.equal(customErr.statusCode, 409);
        assert.equal(customErr.message, "Custom busy message");
        assert.deepEqual(customErr.context, { mediaId: "m-1" });

        // Verify HTTP controller response mapping via #media/api handleDeleteMedia
        configureMedia({
            workflowService: {
                deleteMedia: async () => {
                    throw new MediaConflictError();
                },
            },
        });

        let statusOut = null;
        let jsonOut = null;
        const mockReq = { params: { id: "m-proc" }, user: { id: "user-1" } };
        const mockRes = {
            status(code) {
                statusOut = code;
                return this;
            },
            json(payload) {
                jsonOut = payload;
                return this;
            },
        };

        await handleDeleteMedia(mockReq, mockRes);
        assert.equal(statusOut, 409);
        assert.equal(jsonOut.ok, false);
        assert.equal(jsonOut.errorCode, "MEDIA_PROCESSING");
        assert.equal(jsonOut.error, "Cannot delete media while it is still processing");
    });

    it("deleteMedia tool rejects in-flight media with MediaConflictError and allows failed/terminal/untyped media", async () => {
        const previousRepo = getMediaRepository();
        const deletedCalls = [];
        const records = new Map([
            ["m-processing", { id: "m-processing", status: "processing", url: null }],
            ["m-pending", { id: "m-pending", status: "pending", url: null }],
            ["m-queued", { id: "m-queued", status: "queued", url: null }],
            ["m-failed", { id: "m-failed", status: "failed", url: null }],
            ["m-success", { id: "m-success", status: "success", url: "https://cdn/ok.png" }],
            ["m-minimal", { id: "m-minimal" }],
        ]);

        configureMedia({
            mediaRepo: {
                findById: async (id) => records.get(id) ?? null,
                deleteByIdAndWorkflow: async (mediaId, workflowId) => {
                    deletedCalls.push({ mediaId, workflowId });
                },
            },
        });

        try {
            for (const id of ["m-processing", "m-pending", "m-queued"]) {
                await assert.rejects(
                    () => deleteMedia({ mediaId: id, workflowId: "wf-1" }),
                    (err) => err instanceof MediaConflictError && err.statusCode === 409 && err.errorCode === "MEDIA_PROCESSING"
                );
            }
            assert.equal(deletedCalls.length, 0, "deleteByIdAndWorkflow must not be called for in-flight media");

            for (const id of ["m-failed", "m-success", "m-minimal"]) {
                const res = await deleteMedia({ mediaId: id, workflowId: "wf-1" });
                assert.deepEqual(res, { deleted: true, mediaId: id });
            }
            assert.deepEqual(
                deletedCalls.map((c) => c.mediaId),
                ["m-failed", "m-success", "m-minimal"]
            );
        } finally {
            configureMedia({ mediaRepo: previousRepo });
        }
    });
});
}

// ─── Source: mediaServiceWorkflowMedia.test.js ───
{
describe("MediaService — strict public.media ownership boundary", () => {
  it("persists canonical media rows to public.media and never writes to workflow_media", async () => {
    const mediaInserts = [];
    let workflowMediaTouched = false;
    const service = new MediaService({
      db: {
        media: {
          createMedia: async (payload) => {
            mediaInserts.push(payload);
            return {
              id: "media-1",
              ...payload,
            };
          },
        },
        workflowMedia: {
          linkMedia: async () => {
            workflowMediaTouched = true;
            throw new Error("MediaService must not write to workflow_media");
          },
        },
      },
    });

    const media = await service.createMedia({
      workflowId: "workflow-1",
      projectId: "project-1",
      stepId: "image_generation",
      url: "https://cdn.example.com/out.png",
      width: 1024,
      height: 1024,
    });

    assert.equal(media.id, "media-1");
    assert.equal(workflowMediaTouched, false);
    assert.equal(mediaInserts.length, 1);
    assert.equal("workflow_id" in mediaInserts[0], false);
    assert.equal("workflowId" in mediaInserts[0], false);
  });
});
}

// ─── Source: mediaRatioAndDimensionPreservationBoundary.test.js ───
{
describe("D2.6 — Media Ratio & Dimension Preservation Boundary Tests", () => {
  it("TEST 1: resolveMediaMetadata extracts 16:9 from root ratio, root aspect_ratio, and parameters", () => {
    // 1a. Root ratio
    const fromRootRatio = resolveMediaMetadata({ ratio: "16:9" });
    assert.equal(fromRootRatio.aspect_ratio, "16:9");
    assert.equal(fromRootRatio.width, 1344);
    assert.equal(fromRootRatio.height, 768);

    // 1b. Root aspect_ratio
    const fromRootAspect = resolveMediaMetadata({ aspect_ratio: "16:9" });
    assert.equal(fromRootAspect.aspect_ratio, "16:9");
    assert.equal(fromRootAspect.width, 1344);
    assert.equal(fromRootAspect.height, 768);

    // 1c. Nested in parameters.ratio
    const fromParamsRatio = resolveMediaMetadata({ parameters: { ratio: "16:9" } });
    assert.equal(fromParamsRatio.aspect_ratio, "16:9");
    assert.equal(fromParamsRatio.width, 1344);
    assert.equal(fromParamsRatio.height, 768);

    // 1d. Nested in parameters.aspect_ratio
    const fromParamsAspect = resolveMediaMetadata({ parameters: { aspect_ratio: "16:9" } });
    assert.equal(fromParamsAspect.aspect_ratio, "16:9");
    assert.equal(fromParamsAspect.width, 1344);
    assert.equal(fromParamsAspect.height, 768);

    // 1e. 9:16 portrait
    const portrait = resolveMediaMetadata({ ratio: "9:16" });
    assert.equal(portrait.aspect_ratio, "9:16");
    assert.equal(portrait.width, 768);
    assert.equal(portrait.height, 1344);
  });

  it("TEST 2: calculateAspectRatio accurately snaps common aspect ratios without falling back to 1:1", () => {
    assert.equal(calculateAspectRatio(1920, 1080), "16:9");
    assert.equal(calculateAspectRatio(1280, 720), "16:9");
    assert.equal(calculateAspectRatio(1344, 768), "16:9");
    assert.equal(calculateAspectRatio(720, 1280), "9:16");
    assert.equal(calculateAspectRatio(1080, 1920), "9:16");
    assert.equal(calculateAspectRatio(1024, 1024), "1:1");
    assert.equal(calculateAspectRatio(1200, 800), "3:2");
    assert.equal(calculateAspectRatio(800, 600), "4:3");
  });

  it("TEST 6: SaveMediaNode preserves placeholder dimensions when provider asset lacks width/height", async () => {
    const { SaveMediaNode } = await import("../../../src/systems/workflow-engine/internal/nodes/index.js");
    const { completeMedia } = await import("#media/tools");

    let updatedMedia = null;
    const mockDb = {
      media: {
        findById: async (id) => ({
          id,
          workflow_id: "wf-test-run",
          status: "processing",
          width: 1344,
          height: 768,
        }),
        updateMedia: async (id, fields) => {
          updatedMedia = { id, ...fields };
          return updatedMedia;
        },
      },
    };

    await SaveMediaNode.execute(
      {
        media_id: "placeholder-1",
        asset_url: "https://cdn.example.com/video.mp4",
        metadata: {}, // width and height omitted
      },
      {
        db: mockDb,
        completeMedia,
      }
    );

    assert.ok(updatedMedia, "Expected updateMedia to be called");
    assert.equal(updatedMedia.width, 1344);
    assert.equal(updatedMedia.height, 768);
  });

  it("TEST 7: CharacterMediaService uploadDetailMedia preserves ingested 16:9 dimensions via resolveMediaMetadata", async () => {
    const { CharacterMediaService } = await import("#characters/tools");

    let createdMediaRow = null;
    const mockDb = {
      workflows: {
        getWorkflow: async () => ({ id: "wf-char", project_id: "proj-1", user_id: "user-1" }),
      },
      media: {
        createMedia: async (m) => {
          createdMediaRow = m;
          return { id: "media-detail-1", ...m };
        },
      },
    };

    const mockUploadService = {
      upload: async () => ({
        uploaded: [{
          url: "https://storage.example.com/character-16-9.png",
          width: 1344,
          height: 768,
          ratio: "16:9",
          storageKey: "user-1/character-details/detail.png",
        }],
      }),
      discard: async () => ({}),
    };
    const mockWorkflowMediaService = {
      attachMediaItems: async ({ items }) => {
        const uploadedFile = items[0].uploadedFile;
        createdMediaRow = {
          id: "media-detail-1",
          url: uploadedFile.url,
          width: uploadedFile.width,
          height: uploadedFile.height,
        };
        return { attached: [{ media: createdMediaRow }] };
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

    const res = await service.uploadDetailMedia({
      characterId: "char-123",
      imageUrl: "https://example.com/input.png",
      userId: "user-1",
    });

    assert.ok(res.ok);
    assert.equal(createdMediaRow.width, 1344);
    assert.equal(createdMediaRow.height, 768);
  });

  it("TEST 8: ElementMediaService fallback createMedia uses resolveMediaMetadata for non-1024 dimensions", async () => {
    const { ElementMediaService } = await import("#elements/tools");

    let createdMediaRow = null;
    const mockDb = {
      elements: {
        resolveRecord: async (id) => ({ id, workflow_id: "wf-elem", project_id: "proj-1" }),
        update: async () => {},
      },
      media: {
        createMedia: async (m) => {
          createdMediaRow = m;
          return { id: "elem-media-1", ...m };
        },
      },
      workflows: {
        updatePrimaryMedia: async () => {},
      },
    };

    const mockUploadService = {
      upload: async ({ files }) => {
        const file = files[0];
        return {
          uploaded: [{
            url: file.url,
            width: file.width,
            height: file.height,
            format: "PNG",
            storageKey: "user-1/element-references/ref.png",
          }],
        };
      },
    };
    const mockWorkflowMediaService = {
      attachMediaItems: async ({ items }) => {
        const uploadedFile = items[0].uploadedFile;
        createdMediaRow = await mockDb.media.createMedia({
          url: uploadedFile.url,
          width: uploadedFile.width,
          height: uploadedFile.height,
        });
        return { attached: [{ media: createdMediaRow }] };
      },
    };
    const mockAuthService = {
      verifyWorkflowOwnership: async () => true,
    };

    // Instantiate with migrated upload and attach services
    const service = new ElementMediaService({
      db: mockDb,
      storageService: {},
      mediaUploadService: mockUploadService,
      workflowMediaService: mockWorkflowMediaService,
      authService: mockAuthService,
    });

    await service.addReferenceMedia({
      elementId: "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d",
      projectId: "proj-1",
      userId: "user-1",
      source: {
        url: "https://example.com/ref.png",
        width: 1344,
        height: 768,
      },
    });

    assert.ok(createdMediaRow, "Expected media row to be created");
    assert.equal(createdMediaRow.width, 1344);
    assert.equal(createdMediaRow.height, 768);
  });
});
}
after(() => {
  setTimeout(() => process.exit(0), 100);
});
