process.env.NODE_ENV = "test";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StoragePathResolver, storagePathResolver } from "../../src/platform/storage/StoragePathResolver.js";
import { StorageService, InMemoryStorageProvider } from "../../src/platform/storage/index.js";
import { MediaUploadService } from "../../src/platform/media-ingestion/index.js";

const resolver = storagePathResolver || new StoragePathResolver();

describe("StoragePathResolver.projectAsset — folder segment contract", () => {
    it("preserves internal folder segment names inside the user's namespace", () => {
        assert.equal(
            resolver.projectAsset("user-1", "element-sheets", "170.png"),
            "user-1/element-sheets/170.png"
        );
        assert.equal(
            resolver.projectAsset("user-1", "character-details", "a1b2.mov"),
            "user-1/character-details/a1b2.mov"
        );
    });

    it("falls back to the uploads default when folder is missing or blank", () => {
        assert.equal(resolver.projectAsset("user-1", undefined, "f.png"), "user-1/uploads/f.png");
        assert.equal(resolver.projectAsset("user-1", null, "f.png"), "user-1/uploads/f.png");
        assert.equal(resolver.projectAsset("user-1", "   ", "f.png"), "user-1/uploads/f.png");
        assert.equal(resolver.projectAsset("user-1", "\n", "f.png"), "user-1/uploads/f.png");
    });

    it("rejects traversal attempts with a client-facing 400", () => {
        for (const evil of ["../evil", "..", "../../victim", "a/../../b", "%2e%2e"]) {
            assert.throws(
                () => resolver.projectAsset("user-1", evil, "f.png"),
                (err) => {
                    assert.equal(err.statusCode, 400);
                    // Routes read err.errorCode for the public API contract.
                    assert.equal(err.errorCode, "VALIDATION_ERROR");
                    return true;
                },
                `expected traversal "${evil}" to be rejected`
            );
        }
    });

    it("rejects path separators so a folder stays a single key segment", () => {
        for (const evil of ["a/b", "a\\b", "./x", ".\\x"]) {
            assert.throws(
                () => resolver.projectAsset("user-1", evil, "f.png"),
                (err) => err.errorCode === "VALIDATION_ERROR",
                `expected "${evil}" to be rejected`
            );
        }
    });

    it("rejects unexpected non-segment values (spaces, wildcards, embedded newlines)", () => {
        for (const evil of ["my folder", "*", "x\ny", "э"]) {
            assert.throws(
                () => resolver.projectAsset("user-1", evil, "f.png"),
                (err) => err.errorCode === "VALIDATION_ERROR",
                `expected "${evil}" to be rejected`
            );
        }
    });

    it("never emits a key containing traversal segments, even via the cleaned userId", () => {
        const key = resolver.projectAsset("../../nobody", "uploads", "f.png");
        assert.equal(key, "nobody/uploads/f.png");
        assert.ok(!key.includes(".."));
    });
});

describe("MediaUploadService — fail-fast folder rejection", () => {
    it("rejects an unsafe folder with 400 before reading or uploading the file", async () => {
        const provider = new InMemoryStorageProvider({ bucketName: "test-bucket" });
        const realStorage = new StorageService("test-bucket", provider);
        const storageService = {
            validateFolder: (folder) => realStorage.validateFolder(folder),
            buildKey: () => {
                throw new Error("buildKey must not be reached");
            },
            upload: async () => {
                throw new Error("storage upload must not be reached");
            },
            deleteFiles: async () => ({ deletedCount: 0, failures: [] }),
        };
        const service = new MediaUploadService({ storageService });
        const source = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

        await assert.rejects(
            async () => service.upload({ files: [source], userId: "user-1", folder: "../evil" }),
            (err) => err.statusCode === 400 && err.errorCode === "VALIDATION_ERROR"
        );
    });
});
