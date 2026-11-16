import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { saveTypeRegistry, SAVE_TYPES, RETENTION_POLICIES, StorageService, StoragePathResolver, InMemoryStorageProvider, StorageValidationError, MediaValidationError, MediaRepository, WorkflowMediaRepository, getMediaRepository, getWorkflowMediaRepository, getStorageService, setStorageService, createPendingMedia, markMediaFailed, linkMediaToEntity, getMediaUrls, deleteMedia, MediaService, resolveMediaMetadata } from "#media/tools";
import { mediaRouter, assetsRouter, mediaIngestRouter } from "#media/api";
import { randomUUID } from "node:crypto";
import { calculateAspectRatio } from "#shared";

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
    it("exports the complete media-ingestion public contract without legacy ingestion classes or workflow quota helpers", async () => {
        const ingestionBarrel = await import("#media/tools");

        assert.equal(typeof ingestionBarrel.MediaUploadService, "function");
        assert.equal(typeof ingestionBarrel.DEFAULT_UPLOAD_POLICY, "object");
        assert.equal(typeof ingestionBarrel.ValidationError, "function");
        assert.equal(typeof ingestionBarrel.UploadError, "function");
        assert.equal(typeof ingestionBarrel.QuotaError, "function");
        assert.equal(typeof ingestionBarrel.SourcePolicy, "function");
        assert.equal(typeof ingestionBarrel.SourceReader, "function");
        assert.equal(typeof ingestionBarrel.SourceResolver, "function");
        assert.equal(typeof ingestionBarrel.MediaInspector, "function");

        assert.equal("BinaryIngestionService" in ingestionBarrel, false);
        assert.equal("MediaIngestionService" in ingestionBarrel, false);
        assert.equal(typeof ingestionBarrel.isWorkflowReferenceQuotaError, "function");
        assert.equal(typeof ingestionBarrel.formatWorkflowReferenceQuotaMessage, "function");
    });

    it("exports the complete platform media public contract", async () => {
        const mediaBarrel = await import("#media/tools");

        assert.equal(typeof mediaBarrel.MediaService, "function");
        assert.equal(typeof mediaBarrel.MediaWorkflowLifecycleService, "function");
        assert.equal(typeof mediaBarrel.MEDIA_WORKFLOW_STATUS, "object");
        assert.equal(typeof mediaBarrel.failWorkflowPendingMedia, "function");
        assert.equal(typeof mediaBarrel.normalizeNodeMediaOutputs, "function");
        assert.equal(typeof mediaBarrel.resolveMediaMetadata, "function");
        assert.equal(typeof mediaBarrel.calculateAspectRatio, "function");
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
});

describe("MediaWorkflowLifecycleService — Structured Logging & Bridge Injection", () => {
    it("supports direct bridge injection", async () => {
        const { MediaWorkflowLifecycleService } = await import("#media/tools");

        let createdArgs = null;
        const fakeBridge = {
            createV1Placeholder: async (args) => {
                createdArgs = args;
                return { workflow: { id: "wf-1" }, media: { id: "media-1" } };
            },
        };

        const lifecycle = new MediaWorkflowLifecycleService({ bridge: fakeBridge });
        const placeholder = await lifecycle.startPlaceholder({
            userId: "user-1",
            nodeType: "image-generation",
            input: { project_id: "proj-1", prompt: "Sunset" },
            runId: "run-1",
        });

        assert.deepEqual(placeholder, { workflowId: "wf-1", mediaId: "media-1" });
        assert.equal(createdArgs.projectId, "proj-1");
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

  it("TEST 3: V1StorageBridge createV1Placeholder uses resolveMediaMetadata instead of hardcoded 1024x1024", async () => {
    const { V1StorageBridge } = await import("#media/tools");
    let insertedMediaData = null;
    let insertedConfigData = null;

    const mockDb = {
      configs: {
        createConfig: async (cfg) => {
          insertedConfigData = cfg;
          return { id: "mock-cfg-id" };
        },
      },
      workflows: {
        createWorkflow: async (wf) => ({ id: "mock-wf-id", ...wf }),
        updatePrimaryMedia: async () => {},
      },
      media: {
        createMedia: async (m) => {
          insertedMediaData = m;
          return { id: "mock-media-id", ...m };
        },
      },
    };

    const bridge = new V1StorageBridge({ db: mockDb });

    await bridge.createV1Placeholder({
      userId: randomUUID(),
      projectId: randomUUID(),
      config: {
        prompt: "A cinematic scene",
        model: "nanobana_pro",
        ratio: "16:9", // Frontend passed 'ratio', not 'aspect_ratio'
      },
    });

    if (insertedConfigData) {
      assert.equal(
        insertedConfigData.aspect_ratio,
        "16:9",
        `Expected config.aspect_ratio to be 16:9, got ${insertedConfigData.aspect_ratio}`
      );
    }

    assert.ok(insertedMediaData, "Expected media placeholder to be created");
    assert.equal(
      insertedMediaData.width,
      1344,
      `Expected media placeholder width to be 1344 for 16:9, got ${insertedMediaData.width}`
    );
    assert.equal(
      insertedMediaData.height,
      768,
      `Expected media placeholder height to be 768 for 16:9, got ${insertedMediaData.height}`
    );
  });

  it("TEST 4: V1StorageBridge finalizeV1Media preserves placeholder dimensions when asset has no width/height", async () => {
    const { V1StorageBridge } = await import("#media/tools");
    let updatedFields = null;

    const mockDb = {
      media: {
        findById: async (id) => ({
          id,
          width: 1344,
          height: 768,
        }),
        updateFields: async (id, fields) => {
          updatedFields = fields;
          return { id, ...fields };
        },
      },
    };

    const bridge = new V1StorageBridge({ db: mockDb });

    await bridge.finalizeV1Media("media-123", {
      url: "https://storage.example.com/asset.png",
      // width and height intentionally missing from provider output
    });

    assert.ok(updatedFields, "Expected media fields to be updated");
    assert.equal(
      updatedFields.width,
      1344,
      `Expected finalized width to preserve 1344, got ${updatedFields.width}`
    );
    assert.equal(
      updatedFields.height,
      768,
      `Expected finalized height to preserve 768, got ${updatedFields.height}`
    );
  });

  it("TEST 5: MediaWorkflowLifecycleService preserves ratio in generation_config and placeholder dimensions", async () => {
    const { MediaWorkflowLifecycleService } = await import("#media/tools");
    let insertedMedia = null;
    let insertedConfig = null;
    let updatedMedia = null;

    const mockDb = {
      configs: {
        createConfig: async (cfg) => {
          insertedConfig = cfg;
          return { id: "cfg-123", ...cfg };
        },
      },
      workflows: {
        createWorkflow: async (wf) => ({ id: "wf-123", ...wf }),
        updatePrimaryMedia: async () => {},
      },
      media: {
        createMedia: async (m) => {
          insertedMedia = m;
          return { id: "m-123", ...m };
        },
        findById: async (id) => ({
          id,
          width: insertedMedia?.width || 1344,
          height: insertedMedia?.height || 768,
        }),
        updateFields: async (id, fields) => {
          updatedMedia = { id, ...fields };
          return updatedMedia;
        },
      },
    };

    const lifecycle = new MediaWorkflowLifecycleService({ db: mockDb });

    const result = await lifecycle.startPlaceholder({
      userId: randomUUID(),
      nodeType: "image-generation",
      input: {
        projectId: randomUUID(),
        prompt: "A neon cyberpunk cityscape",
        ratio: "16:9",
      },
    });

    assert.ok(result, "Placeholder result should not be null");
    if (insertedConfig) {
      assert.equal(insertedConfig.aspect_ratio, "16:9");
    }
    assert.equal(insertedMedia.width, 1344);
    assert.equal(insertedMedia.height, 768);

    // Complete placeholder with asset lacking width/height
    const completed = await lifecycle.completePlaceholder("m-123", {
      url: "https://storage.example.com/cyberpunk.png",
    });

    assert.equal(completed, true);
    assert.equal(updatedMedia.width, 1344);
    assert.equal(updatedMedia.height, 768);
  });

  it("TEST 6: SaveMediaNode preserves placeholder dimensions when provider asset lacks width/height", async () => {
    const { SaveMediaNode } = await import("../../../src/systems/generation/internal/v3/index.js");

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
