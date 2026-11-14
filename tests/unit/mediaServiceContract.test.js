process.env.NODE_ENV = "test";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StorageService, InMemoryStorageProvider } from "#media/tools";
import { MediaRepository } from "#media/tools";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, "../..");

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
    it("contains zero raw console calls and supports direct bridge injection", async () => {
        const { MediaWorkflowLifecycleService } = await import("#media/tools");
        const source = readFileSync(
            path.join(API_ROOT, "src/systems/media/internal/services/MediaLifecycleService.js"),
            "utf8"
        );
        assert.equal(/\bconsole\.(log|warn|error|info|debug)\s*\(/.test(source), false, "MediaLifecycleService.js must not call console.*");

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
