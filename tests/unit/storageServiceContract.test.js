process.env.NODE_ENV = "test";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    StorageService,
    InMemoryStorageProvider,
} from "../../src/platform/storage/index.js";
import { StoragePathResolver } from "../../src/platform/storage/StoragePathResolver.js";
import { IStorageProvider } from "../../src/platform/storage/IStorageProvider.js";
import { SupabaseStorageProvider } from "../../src/platform/storage/providers/SupabaseStorageProvider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const STORAGE_DIR = path.join(REPO_ROOT, "src/platform/storage");

const VALID_PNG_BYTES = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

describe("StorageService — Architecture, Dependency Isolation & Public Contract", () => {
    it("exposes only the approved public interface methods on StorageService", () => {
        const provider = new InMemoryStorageProvider({ bucketName: "test_bucket" });
        const service = new StorageService("test_bucket", provider);

        // Approved public methods
        const expectedMethods = [
            "buildKey",
            "validateFolder",
            "extractKey",
            "extractStoragePath",
            "upload",
            "getPublicUrl",
            "delete",
            "deleteFiles",
            "deleteByUrl",
        ];
        for (const method of expectedMethods) {
            assert.equal(
                typeof service[method],
                "function",
                `Expected StorageService.${method} to be a public function`
            );
        }

        // Removed dead methods / aliases
        const removedMethods = [
            "uploadFromUrl",
            "uploadBuffer",
            "uploadStream",
            "deleteByUrls",
            "remove",
        ];
        for (const removed of removedMethods) {
            assert.equal(
                service[removed],
                undefined,
                `Expected dead method StorageService.${removed} to be removed`
            );
        }
    });

    it("removes domain-specific path methods from StoragePathResolver", () => {
        const resolver = new StoragePathResolver();
        assert.equal(typeof resolver.projectAsset, "function");
        assert.equal(typeof resolver.extractStoragePath, "function");
        assert.equal(typeof StoragePathResolver.validateFolderSegment, "function");

        for (const deadDomainMethod of ["characterSheet", "characterDetail", "element", "generation"]) {
            assert.equal(
                resolver[deadDomainMethod],
                undefined,
                `Expected domain-specific StoragePathResolver.${deadDomainMethod} to be removed`
            );
        }
    });

    it("has zero imports from media-ingestion, domain, or workflow modules", () => {
        const collectJsFiles = (dir, out = []) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) collectJsFiles(full, out);
                else if (entry.name.endsWith(".js")) out.push(full);
            }
            return out;
        };

        const storageFiles = collectJsFiles(STORAGE_DIR);
        assert.ok(storageFiles.length >= 5, "Expected storage module files to exist");

        const forbiddenImportPattern = /(?:from|import)\s+['"][^'"]*(?:media-ingestion|\/domain\/|\/workflow\/|#domain\/|#platform\/media-ingestion|#platform\/workflow)/;

        for (const file of storageFiles) {
            const content = fs.readFileSync(file, "utf8");
            const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
            assert.equal(
                forbiddenImportPattern.test(content),
                false,
                `Storage file ${rel} must not import from media-ingestion, domain, or workflow modules`
            );
        }
    });

    it("removes dead legacy storage files and flattened redundant provider directory", () => {
        assert.equal(
            fs.existsSync(path.join(STORAGE_DIR, "mediaStorageService.js")),
            false,
            "Dead mediaStorageService.js must be removed"
        );
        assert.equal(
            fs.existsSync(path.join(REPO_ROOT, "src/utils/storagePath.js")),
            false,
            "Dead src/utils/storagePath.js must be removed"
        );
        assert.equal(
            fs.existsSync(path.join(STORAGE_DIR, "storage/providers/SupabaseStorageProvider.js")),
            false,
            "Redundant nested storage/storage/providers/SupabaseStorageProvider.js must be removed"
        );
        assert.equal(
            fs.existsSync(path.join(STORAGE_DIR, "providers/SupabaseStorageProvider.js")),
            true,
            "Flattened providers/SupabaseStorageProvider.js must exist"
        );
        assert.equal(
            fs.existsSync(path.join(STORAGE_DIR, "providers/InMemoryStorageProvider.js")),
            true,
            "providers/InMemoryStorageProvider.js must exist"
        );
    });

    it("builds and validates storage keys and rejects traversal or unknown folders with 400", () => {
        const provider = new InMemoryStorageProvider({ bucketName: "test_bucket" });
        const service = new StorageService("test_bucket", provider);

        const key = service.buildKey({
            userId: "user-123",
            folder: "element-references",
            filename: "photo.webp",
        });
        assert.equal(key, "user-123/element-references/photo.webp");

        assert.equal(service.validateFolder("character-sheets"), "character-sheets");
        assert.equal(service.validateFolder(""), "uploads");

        assert.throws(
            () => service.buildKey({ userId: "user-123", folder: "../secrets", filename: "a.png" }),
            (err) => err.statusCode === 400 && err.errorCode === "VALIDATION_ERROR"
        );
        assert.throws(
            () => service.validateFolder("invalid_folder"),
            (err) => err.statusCode === 400 && err.errorCode === "VALIDATION_ERROR"
        );
    });

    it("uploads, resolves public URLs, extracts keys, and deletes single and batch objects via InMemoryStorageProvider", async () => {
        const provider = new InMemoryStorageProvider({
            bucketName: "test_bucket",
            baseUrl: "https://cdn.example.com/storage/v1/object/public",
        });
        const service = new StorageService("test_bucket", provider);

        const key = service.buildKey({ userId: "u1", folder: "uploads", filename: "img1.png" });
        const url = await service.upload(key, VALID_PNG_BYTES, { contentType: "image/png" });

        assert.equal(url, "https://cdn.example.com/storage/v1/object/public/test_bucket/u1/uploads/img1.png");
        assert.equal(await service.getPublicUrl(key), url);
        assert.equal(service.extractKey(url), "u1/uploads/img1.png");
        assert.equal(service.extractStoragePath(url), "u1/uploads/img1.png");
        assert.equal(provider.has(key), true);

        // Delete by URL removes the stored object
        await service.deleteByUrl(url);
        assert.equal(provider.has(key), false);

        // Calling deleteByUrl again or with non-matching URL is idempotent
        await service.deleteByUrl(url);
        await service.deleteByUrl(null);

        // Batch delete deduplicates keys and reports count
        const k1 = service.buildKey({ userId: "u1", folder: "uploads", filename: "a.png" });
        const k2 = service.buildKey({ userId: "u1", folder: "uploads", filename: "b.png" });
        await service.upload(k1, VALID_PNG_BYTES, { contentType: "image/png" });
        await service.upload(k2, VALID_PNG_BYTES, { contentType: "image/png" });

        const batchRes = await service.deleteFiles([k1, k2, k1, ""]);
        assert.deepEqual(batchRes, { deletedCount: 2, failures: [] });
        assert.equal(provider.has(k1), false);
        assert.equal(provider.has(k2), false);
    });

    it("SupabaseStorageProvider accepts an injected client and uses structured logging instead of console.error", async () => {
        let consoleErrorCalls = 0;
        const origConsoleError = console.error;
        console.error = () => {
            consoleErrorCalls += 1;
        };

        try {
            const fakeSupabaseClient = {
                storage: {
                    from(bucket) {
                        assert.equal(bucket, "custom_bucket");
                        return {
                            async upload() {
                                return { error: null };
                            },
                            getPublicUrl(cleanPath) {
                                return { data: { publicUrl: `https://supa.test/custom_bucket/${cleanPath}` } };
                            },
                            async remove() {
                                return { data: null, error: { message: "Bucket temporarily unavailable" } };
                            },
                        };
                    },
                },
            };

            const supaProvider = new SupabaseStorageProvider({
                bucketName: "custom_bucket",
                client: fakeSupabaseClient,
            });

            const uploadedUrl = await supaProvider.upload("/folder/test.png", VALID_PNG_BYTES, {
                contentType: "image/png",
            });
            assert.equal(uploadedUrl, "https://supa.test/custom_bucket/folder/test.png");

            const delResult = await supaProvider.deleteFiles(["/folder/test.png"]);
            assert.equal(delResult.deletedCount, 0);
            assert.equal(delResult.failures.length, 1);
            assert.equal(consoleErrorCalls, 0, "SupabaseStorageProvider must not call console.error");
        } finally {
            console.error = origConsoleError;
        }
    });

    it("StorageValidationError conforms to StorageError, AppError, and catches MZ executable sniffing", async () => {
        const { StorageError, StorageValidationError } = await import(
            "../../src/platform/storage/StorageErrors.js"
        );
        const { AppError } = await import("../../src/errors/AppError.js");

        const err = new StorageValidationError("Test validation error");
        assert.ok(err instanceof StorageError, "Expected err to be instanceof StorageError");
        assert.ok(err instanceof AppError, "Expected err to be instanceof AppError");
        assert.equal(err.code, "STORAGE_VALIDATION_ERROR");
        assert.equal(err.statusCode, 400);
        assert.equal(err.errorCode, "VALIDATION_ERROR");

        const provider = new InMemoryStorageProvider({ bucketName: "test_bucket" });
        const service = new StorageService("test_bucket", provider);

        const exeBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
        await assert.rejects(
            async () => {
                await service.upload("u1/uploads/test.exe", exeBuffer);
            },
            (thrown) => {
                assert.ok(thrown instanceof StorageValidationError);
                assert.ok(thrown instanceof StorageError);
                assert.ok(thrown instanceof AppError);
                assert.equal(thrown.statusCode, 400);
                assert.equal(thrown.code, "STORAGE_VALIDATION_ERROR");
                assert.equal(thrown.errorCode, "VALIDATION_ERROR");
                assert.match(thrown.message, /Executable binary/);
                return true;
            }
        );
    });

    it("StorageService fails closed without a provider, and createStorageService factory constructs with client", async () => {
        const { createStorageService } = await import("../../src/platform/storage/index.js");
        const { StorageError } = await import("../../src/platform/storage/StorageErrors.js");

        // Fails closed without provider
        assert.throws(
            () => new StorageService(),
            (err) => err instanceof StorageError && err.code === "STORAGE_CONFIG_ERROR"
        );
        assert.throws(
            () => new StorageService({ bucketName: "test_bucket" }),
            (err) => err instanceof StorageError && err.code === "STORAGE_CONFIG_ERROR"
        );

        // Factory fails closed without client
        assert.throws(
            () => createStorageService({}),
            (err) => err instanceof StorageError && err.code === "STORAGE_CONFIG_ERROR"
        );

        // Factory succeeds with valid client
        const fakeClient = {
            storage: {
                from() {
                    return {};
                },
            },
        };
        const createdService = createStorageService({ client: fakeClient, bucketName: "factory_bucket" });
        assert.ok(createdService instanceof StorageService);
        assert.equal(createdService.bucketName, "factory_bucket");
    });

    describe("StorageService SVG/XML sub-condition independent security coverage", () => {
        it('rejects "<svg" sub-condition independently without script markup', async () => {
            const { StorageValidationError } = await import(
                "../../src/platform/storage/StorageErrors.js"
            );
            const provider = new InMemoryStorageProvider({ bucketName: "test_bucket" });
            const service = new StorageService({ bucketName: "test_bucket", provider });
            const payload = Buffer.from('<svg width="100" height="100"><circle cx="50" cy="50" r="40"/></svg>');

            await assert.rejects(
                async () => {
                    await service.upload("u1/uploads/test-svg.png", payload);
                },
                (thrown) => {
                    assert.ok(thrown instanceof StorageValidationError);
                    assert.equal(thrown.statusCode, 400);
                    assert.match(thrown.message, /SVG \/ XML markup payload detected/i);
                    return true;
                }
            );
        });

        it('rejects "<?xml" sub-condition independently without script markup', async () => {
            const { StorageValidationError } = await import(
                "../../src/platform/storage/StorageErrors.js"
            );
            const provider = new InMemoryStorageProvider({ bucketName: "test_bucket" });
            const service = new StorageService({ bucketName: "test_bucket", provider });
            const payload = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><catalog><book id="bk101"/></catalog>');

            await assert.rejects(
                async () => {
                    await service.upload("u1/uploads/test-qxml.png", payload);
                },
                (thrown) => {
                    assert.ok(thrown instanceof StorageValidationError);
                    assert.equal(thrown.statusCode, 400);
                    assert.match(thrown.message, /SVG \/ XML markup payload detected/i);
                    return true;
                }
            );
        });

        it('rejects "<xml" sub-condition independently without script markup', async () => {
            const { StorageValidationError } = await import(
                "../../src/platform/storage/StorageErrors.js"
            );
            const provider = new InMemoryStorageProvider({ bucketName: "test_bucket" });
            const service = new StorageService({ bucketName: "test_bucket", provider });
            const payload = Buffer.from('<xml><record id="1"><value>data</value></record></xml>');

            await assert.rejects(
                async () => {
                    await service.upload("u1/uploads/test-xml.png", payload);
                },
                (thrown) => {
                    assert.ok(thrown instanceof StorageValidationError);
                    assert.equal(thrown.statusCode, 400);
                    assert.match(thrown.message, /SVG \/ XML markup payload detected/i);
                    return true;
                }
            );
        });

        it('rejects "xmlns svg namespace" sub-condition independently without script markup', async () => {
            const { StorageValidationError } = await import(
                "../../src/platform/storage/StorageErrors.js"
            );
            const provider = new InMemoryStorageProvider({ bucketName: "test_bucket" });
            const service = new StorageService({ bucketName: "test_bucket", provider });
            const payload = Buffer.from('<g xmlns="http://www.w3.org/2000/svg"><path d="M10 10"/></g>');

            await assert.rejects(
                async () => {
                    await service.upload("u1/uploads/test-xmlns.png", payload);
                },
                (thrown) => {
                    assert.ok(thrown instanceof StorageValidationError);
                    assert.equal(thrown.statusCode, 400);
                    assert.match(thrown.message, /SVG \/ XML markup payload detected/i);
                    return true;
                }
            );
        });
    });
});
