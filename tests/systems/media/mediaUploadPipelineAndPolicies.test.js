import { describe, it, beforeEach, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import sharp from "sharp";
import { DEFAULT_UPLOAD_POLICY, ELEMENT_REFERENCE_UPLOAD_POLICY, ELEMENT_SHEET_UPLOAD_POLICY, ELEMENT_SOURCES_UPLOAD_POLICY, CHARACTER_SHEET_UPLOAD_POLICY, CHARACTER_DETAIL_UPLOAD_POLICY, ValidationError, UploadError, QuotaError, MediaUploadService, SourceReader, SourcePolicy, resetActiveUploadsForTest, resetInFlightBytesForTest, StorageService, InMemoryStorageProvider, AssetUploadService, MediaService, WorkflowMediaRepository } from "#media/tools";
import { createUploadMiddleware, resolveMiddlewarePolicy, assetsRouter, mediaIngestRouter } from "#media/api";
import { WorkflowMediaService } from "../../../src/systems/generation/internal/services/WorkflowMediaService.js";
import dns from "node:dns/promises";
import http from "node:http";
import express from "express";
import elementRoutes from "#elements/api";
import charactersRouter from "#characters/api";
import { supabase } from "#shared/db/supabase.js";
import { assetUploadService, elementMediaService, characterService, db } from "../../../src/container.js";
import { rateLimitRedisConnection, redisConnection, workerRedisConnection } from "#shared";

// ─── Source: mediaUploadServiceAndPolicy.test.js ───
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

// Minimal MP4 ftyp + mvhd box header for magic-byte + metadata extraction
function buildMinimalMp4Buffer() {
    const ftyp = Buffer.from([
        0x00, 0x00, 0x00, 0x18,
        0x66, 0x74, 0x79, 0x70, // "ftyp"
        0x69, 0x73, 0x6f, 0x6d, // "isom"
        0x00, 0x00, 0x02, 0x00,
        0x69, 0x73, 0x6f, 0x6d,
        0x69, 0x73, 0x6f, 0x32,
    ]);
    return Buffer.concat([ftyp, Buffer.alloc(64, 0)]);
}

function createFakeStorage({ failOnUploadIndex = null, failOnDelete = false } = {}) {
    const uploaded = [];
    const deletedBatches = [];
    let uploadCallCount = 0;

    return {
        uploaded,
        deletedBatches,
        buildKey({ userId, folder = "uploads", filename } = {}) {
            return `${userId}/${folder}/${filename}`;
        },
        validateFolder(folder) {
            if (!folder || /\.\.|[\/\\]|\s/.test(folder)) {
                throw new Error(`Unsafe folder segment: ${folder}`);
            }
            return folder;
        },
        paths: {
            projectAsset(userId, folder, filename) {
                return `${userId}/${folder}/${filename}`;
            },
        },
        async upload(storageKey, buffer, options) {
            uploadCallCount += 1;
            if (failOnUploadIndex !== null && uploadCallCount === failOnUploadIndex) {
                throw new Error(`Simulated storage outage on upload #${uploadCallCount}`);
            }
            uploaded.push({ storageKey, size: buffer.length, contentType: options?.contentType });
            return `https://cdn.example.com/${storageKey}`;
        },
        async deleteFiles(paths) {
            deletedBatches.push([...paths]);
            if (failOnDelete) {
                throw new Error("Simulated storage delete failure");
            }
            return { deletedCount: paths.length, failures: [] };
        },
    };
}

describe("UploadPolicy frozen presets & error hierarchy", () => {
    it("exports frozen policies with exact current storageFolder mappings and request limits", () => {
        assert.ok(Object.isFrozen(DEFAULT_UPLOAD_POLICY));
        assert.ok(Object.isFrozen(ELEMENT_REFERENCE_UPLOAD_POLICY));
        assert.ok(Object.isFrozen(ELEMENT_SHEET_UPLOAD_POLICY));
        assert.ok(Object.isFrozen(CHARACTER_SHEET_UPLOAD_POLICY));
        assert.ok(Object.isFrozen(CHARACTER_DETAIL_UPLOAD_POLICY));

        assert.deepEqual(DEFAULT_UPLOAD_POLICY.allowedTypes, ["image", "video"]);
        assert.equal(DEFAULT_UPLOAD_POLICY.maxImageSize, 20 * 1024 * 1024);
        assert.equal(DEFAULT_UPLOAD_POLICY.maxVideoSize, 100 * 1024 * 1024);
        assert.equal(DEFAULT_UPLOAD_POLICY.maxFilesPerRequest, 1);
        assert.deepEqual(DEFAULT_UPLOAD_POLICY.storageFolder, { image: "uploads", video: "video_uploads" });

        assert.deepEqual(ELEMENT_REFERENCE_UPLOAD_POLICY.allowedTypes, ["image"]);
        assert.equal(ELEMENT_REFERENCE_UPLOAD_POLICY.maxFilesPerRequest, 6);
        assert.equal(ELEMENT_REFERENCE_UPLOAD_POLICY.storageFolder, "element-references");

        assert.deepEqual(ELEMENT_SHEET_UPLOAD_POLICY.allowedTypes, ["image"]);
        assert.equal(ELEMENT_SHEET_UPLOAD_POLICY.maxFilesPerRequest, 1);
        assert.equal(ELEMENT_SHEET_UPLOAD_POLICY.storageFolder, "element-sheets");

        assert.ok(Object.isFrozen(ELEMENT_SOURCES_UPLOAD_POLICY));
        assert.deepEqual(ELEMENT_SOURCES_UPLOAD_POLICY.allowedTypes, ["image"]);
        assert.equal(ELEMENT_SOURCES_UPLOAD_POLICY.maxFilesPerRequest, 6);
        assert.equal(ELEMENT_SOURCES_UPLOAD_POLICY.storageFolder, "element-sheets");

        assert.deepEqual(CHARACTER_SHEET_UPLOAD_POLICY.allowedTypes, ["image"]);
        assert.equal(CHARACTER_SHEET_UPLOAD_POLICY.maxFilesPerRequest, 1);
        assert.equal(CHARACTER_SHEET_UPLOAD_POLICY.storageFolder, "character-sheets");

        assert.deepEqual(CHARACTER_DETAIL_UPLOAD_POLICY.allowedTypes, ["image"]);
        assert.equal(CHARACTER_DETAIL_UPLOAD_POLICY.maxFilesPerRequest, 5);
        assert.equal(CHARACTER_DETAIL_UPLOAD_POLICY.storageFolder, "character-details");
    });

    it("provides typed ValidationError, UploadError, and QuotaError classes compatible with safePublicRouteError", () => {
        const valErr = new ValidationError("Bad type", { statusCode: 415, code: "UNSUPPORTED_MEDIA_TYPE" });
        assert.equal(valErr.statusCode, 415);
        assert.equal(valErr.code, "UNSUPPORTED_MEDIA_TYPE");
        assert.equal(valErr.errorCode, "UNSUPPORTED_MEDIA_TYPE");

        const upErr = new UploadError("Storage down");
        assert.equal(upErr.statusCode, 502);
        assert.equal(upErr.code, "STORAGE_UPLOAD_ERROR");
        assert.equal(upErr.errorCode, "STORAGE_UPLOAD_ERROR");

        const quotaErr = new QuotaError("Max 6 reached");
        assert.equal(quotaErr.statusCode, 400);
        assert.equal(quotaErr.code, "LIMIT_EXCEEDED");
        assert.equal(quotaErr.errorCode, "LIMIT_EXCEEDED");
    });
});

describe("SourceReader early per-type size cap before full buffering (Regression)", () => {
    it("rejects a >20MB image URL stream under DEFAULT_UPLOAD_POLICY (100MB video cap) BEFORE buffering the full stream", async () => {
        const originalFetch = globalThis.fetch;
        const originalValidateUrl = SourcePolicy.validateUrl;
        let bytesGenerated = 0;
        let streamAborted = false;

        // 1MB chunk: first chunk starts with valid PNG magic bytes
        const chunkSize = 1024 * 1024;
        const firstChunk = Buffer.alloc(chunkSize, 0xaa);
        VALID_PNG_1X1.copy(firstChunk, 0);
        const bodyChunk = Buffer.alloc(chunkSize, 0xbb);

        SourcePolicy.validateUrl = async (u) => new URL(u);
        globalThis.fetch = async (_url, { signal }) => {
            if (signal) {
                signal.addEventListener("abort", () => {
                    streamAborted = true;
                });
            }
            async function* generate50MbPngStream() {
                for (let i = 0; i < 50; i++) {
                    if (signal?.aborted) return;
                    const chunk = i === 0 ? firstChunk : bodyChunk;
                    bytesGenerated += chunk.length;
                    yield chunk;
                }
            }
            return {
                ok: true,
                status: 200,
                headers: new Map([["content-type", "image/png"]]),
                body: generate50MbPngStream(),
            };
        };

        try {
            await assert.rejects(
                () => SourceReader.read({ kind: "url", value: "https://example.com/huge.png" }, DEFAULT_UPLOAD_POLICY),
                (err) => {
                    assert.ok(err instanceof ValidationError);
                    assert.equal(err.statusCode, 413);
                    assert.equal(err.code, "PAYLOAD_TOO_LARGE");
                    return true;
                }
            );

            assert.ok(streamAborted, "URL stream must be aborted as soon as 20MB image cap is exceeded");
            assert.equal(
                bytesGenerated,
                21 * 1024 * 1024,
                `Must stop reading immediately after crossing 20MB (read ${bytesGenerated} bytes, never 50MB)`
            );
        } finally {
            globalThis.fetch = originalFetch;
            SourcePolicy.validateUrl = originalValidateUrl;
        }
    });

    it("rejects a >20MB Base64 image under DEFAULT_UPLOAD_POLICY BEFORE decoding the full Base64 payload", async () => {
        // Construct a ~21MB base64 string whose header decodes to PNG magic bytes without allocating a 21MB decoded Buffer in SourceReader
        const headerBytes = Buffer.alloc(48, 0);
        VALID_PNG_1X1.copy(headerBytes, 0);
        const base64Header = headerBytes.toString("base64"); // 64 chars (multiple of 4)
        // 21 MB of decoded bytes = 28 * 1024 * 1024 base64 chars
        const base64BodyLength = 28 * 1024 * 1024;
        const hugeBase64 = `data:image/png;base64,${base64Header}${"A".repeat(base64BodyLength)}`;

        const originalBufferFrom = Buffer.from;
        let maxAllocatedBufferBytes = 0;
        Buffer.from = function patchedBufferFrom(value, encodingOrOffset, length) {
            const buf = originalBufferFrom.call(Buffer, value, encodingOrOffset, length);
            if (typeof value === "string" && encodingOrOffset === "base64") {
                maxAllocatedBufferBytes = Math.max(maxAllocatedBufferBytes, buf.length);
            }
            return buf;
        };

        try {
            await assert.rejects(
                () => SourceReader.read({ kind: "base64", value: hugeBase64, mimeHint: "image/png" }, DEFAULT_UPLOAD_POLICY),
                (err) => {
                    assert.ok(err instanceof ValidationError);
                    assert.equal(err.statusCode, 413);
                    assert.equal(err.code, "PAYLOAD_TOO_LARGE");
                    return true;
                }
            );

            assert.ok(
                maxAllocatedBufferBytes <= 64,
                `SourceReader must only decode the small magic-byte header (decoded max ${maxAllocatedBufferBytes} bytes, never 21MB)`
            );
        } finally {
            Buffer.from = originalBufferFrom;
        }
    });

    it("waits for 32 header bytes when the initial URL chunk is only 8 bytes (WebP) and aborts at 20MB", async () => {
        const originalFetch = globalThis.fetch;
        const originalValidateUrl = SourcePolicy.validateUrl;
        SourcePolicy.validateUrl = async (u) => new URL(u);

        let bytesGenerated = 0;
        // WebP signature requires 12 bytes ("RIFF" + size + "WEBP"). Split across an 8-byte first chunk and 1MB second chunk.
        const chunk1 = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]); // 8 bytes ("RIFF....")
        const chunk2 = Buffer.alloc(1024 * 1024, 0);
        Buffer.from([0x57, 0x45, 0x42, 0x50]).copy(chunk2, 0); // "WEBP" at bytes 8..11
        const bodyChunk = Buffer.alloc(1024 * 1024, 0);

        globalThis.fetch = async (_url, { signal } = {}) => {
            async function* generateSplitHeaderWebpStream() {
                bytesGenerated += chunk1.length;
                yield chunk1;
                bytesGenerated += chunk2.length;
                yield chunk2;
                for (let i = 0; i < 40; i++) {
                    if (signal?.aborted) return;
                    bytesGenerated += bodyChunk.length;
                    yield bodyChunk;
                }
            }
            return {
                ok: true,
                status: 200,
                headers: new Map([["content-type", "image/webp"]]),
                body: generateSplitHeaderWebpStream(),
            };
        };

        try {
            await assert.rejects(
                () => SourceReader.read({ kind: "url", url: "https://example.com/split.webp" }, DEFAULT_UPLOAD_POLICY),
                (err) => {
                    assert.ok(err instanceof ValidationError);
                    assert.equal(err.statusCode, 413);
                    assert.equal(err.code, "PAYLOAD_TOO_LARGE");
                    return true;
                }
            );
            assert.ok(bytesGenerated <= 22 * 1024 * 1024, `Must abort right after 20MB (generated ${bytesGenerated} bytes)`);
        } finally {
            globalThis.fetch = originalFetch;
            SourcePolicy.validateUrl = originalValidateUrl;
        }
    });

    it("rejects unrecognized magic bytes on a URL stream after the first 32 bytes with 415 UNSUPPORTED_MEDIA_TYPE before buffering further chunks", async () => {
        const originalFetch = globalThis.fetch;
        const originalValidateUrl = SourcePolicy.validateUrl;
        SourcePolicy.validateUrl = async (u) => new URL(u);

        let chunksYielded = 0;
        const badHeaderChunk = Buffer.alloc(64, 0x41); // 64 bytes of 'A' (not a valid image or video signature)
        const bodyChunk = Buffer.alloc(1024 * 1024, 0x42);

        globalThis.fetch = async () => {
            async function* generateInvalidStream() {
                chunksYielded += 1;
                yield badHeaderChunk;
                for (let i = 0; i < 10; i++) {
                    chunksYielded += 1;
                    yield bodyChunk;
                }
            }
            return {
                ok: true,
                status: 200,
                headers: new Map([["content-type", "application/octet-stream"]]),
                body: generateInvalidStream(),
            };
        };

        try {
            await assert.rejects(
                () => SourceReader.read({ kind: "url", url: "https://example.com/malicious.bin" }, DEFAULT_UPLOAD_POLICY),
                (err) => {
                    assert.ok(err instanceof ValidationError);
                    assert.equal(err.statusCode, 415);
                    assert.equal(err.code, "UNSUPPORTED_MEDIA_TYPE");
                    return true;
                }
            );
            assert.equal(chunksYielded, 1, "Stream must be rejected immediately on the first chunk without buffering subsequent chunks");
        } finally {
            globalThis.fetch = originalFetch;
            SourcePolicy.validateUrl = originalValidateUrl;
        }
    });

    it("sniffs and cleanly rejects (415 or 400) a URL or Base64 source that ends with fewer than 32 bytes without hanging or passing through unchecked", async () => {
        const originalFetch = globalThis.fetch;
        const originalValidateUrl = SourcePolicy.validateUrl;
        SourcePolicy.validateUrl = async (u) => new URL(u);

        try {
            // 1. Short (< 32 bytes) invalid URL payload (10 bytes) -> 415 UNSUPPORTED_MEDIA_TYPE
            globalThis.fetch = async () => {
                async function* generateShortInvalidStream() {
                    yield Buffer.from("hello12345"); // 10 bytes (< 32 bytes)
                }
                return {
                    ok: true,
                    status: 200,
                    headers: new Map([["content-type", "image/png"]]),
                    body: generateShortInvalidStream(),
                };
            };

            await assert.rejects(
                () => SourceReader.read({ kind: "url", value: "https://example.com/short.png" }, DEFAULT_UPLOAD_POLICY),
                (err) => {
                    assert.ok(err instanceof ValidationError);
                    assert.equal(err.statusCode, 415);
                    assert.equal(err.code, "UNSUPPORTED_MEDIA_TYPE");
                    return true;
                }
            );

            // 2. Empty (0-byte) URL stream -> 400 VALIDATION_ERROR
            globalThis.fetch = async () => {
                async function* generateEmptyStream() {}
                return {
                    ok: true,
                    status: 200,
                    headers: new Map([["content-type", "image/png"]]),
                    body: generateEmptyStream(),
                };
            };

            await assert.rejects(
                () => SourceReader.read({ kind: "url", value: "https://example.com/empty.png" }, DEFAULT_UPLOAD_POLICY),
                (err) => {
                    assert.ok(err instanceof ValidationError);
                    assert.equal(err.statusCode, 400);
                    assert.equal(err.code, "VALIDATION_ERROR");
                    return true;
                }
            );

            // 3. Short (< 32 bytes) invalid Base64 payload (10 decoded bytes) -> 415 UNSUPPORTED_MEDIA_TYPE
            const shortBase64 = `data:image/png;base64,${Buffer.from("hello12345").toString("base64")}`;
            await assert.rejects(
                () => SourceReader.read({ kind: "base64", value: shortBase64, mimeHint: "image/png" }, DEFAULT_UPLOAD_POLICY),
                (err) => {
                    assert.ok(err instanceof ValidationError);
                    assert.equal(err.statusCode, 415);
                    assert.equal(err.code, "UNSUPPORTED_MEDIA_TYPE");
                    return true;
                }
            );
        } finally {
            globalThis.fetch = originalFetch;
            SourcePolicy.validateUrl = originalValidateUrl;
        }
    });
});

describe("MediaUploadService Seam 1 Contract", () => {
    it("uploads a valid image, optimizes >2048px images to WebP, and returns post-optimization metadata + storageKey", async () => {
        const fakeStorage = createFakeStorage();
        const service = new MediaUploadService({ storageService: fakeStorage });

        // Create a 2400x1200 PNG buffer (>2048px width)
        const largePngBuffer = await sharp({
            create: {
                width: 2400,
                height: 1200,
                channels: 3,
                background: { r: 20, g: 40, b: 80 },
            },
        })
            .png()
            .toBuffer();

        const { uploaded } = await service.upload({
            files: [{ buffer: largePngBuffer, originalname: "banner.png", mimetype: "image/png" }],
            policy: ELEMENT_REFERENCE_UPLOAD_POLICY,
            maxFiles: 4,
            userId: "user-123",
        });

        assert.equal(uploaded.length, 1);
        const item = uploaded[0];
        assert.ok(item.storageKey.startsWith("user-123/element-references/"));
        assert.ok(item.storageKey.endsWith(".webp"));
        assert.equal(item.url, `https://cdn.example.com/${item.storageKey}`);
        assert.equal(item.mimeType, "image/webp");
        assert.equal(item.type, "image");
        assert.equal(item.width, 2048, "Width must be post-optimization width (2048)");
        assert.equal(item.height, 1024, "Height must be post-optimization height (1024)");
        assert.equal(item.format, "WEBP");
        assert.equal(item.ratio, "2:1");
        assert.equal(item.durationSec, null);
        assert.equal(item.originalName, "banner.png");
        assert.equal(item.size, fakeStorage.uploaded[0].size, "Returned size must match optimized stored buffer size");
    });

    it("enforces Phase 1 all-or-nothing validation: if file #2 in a batch is invalid, zero files are uploaded to storage", async () => {
        const fakeStorage = createFakeStorage();
        const service = new MediaUploadService({ storageService: fakeStorage });

        const validFile = { buffer: VALID_PNG_1X1, originalname: "ok.png", mimetype: "image/png" };
        const videoFile = { buffer: buildMinimalMp4Buffer(), originalname: "clip.mp4", mimetype: "video/mp4" };

        await assert.rejects(
            () =>
                service.upload({
                    files: [validFile, videoFile],
                    policy: CHARACTER_DETAIL_UPLOAD_POLICY, // images only!
                    maxFiles: 5,
                    userId: "user-123",
                }),
            (err) => {
                assert.ok(err instanceof ValidationError);
                assert.equal(err.statusCode, 415);
                assert.equal(err.code, "UNSUPPORTED_MEDIA_TYPE");
                return true;
            }
        );

        assert.equal(fakeStorage.uploaded.length, 0, "Zero files must be uploaded when any file in the batch fails validation");
    });

    it("distinguishes maxFilesPerRequest (400 VALIDATION_ERROR) from domain maxFiles fail-fast hint (400 LIMIT_EXCEEDED)", async () => {
        const fakeStorage = createFakeStorage();
        const service = new MediaUploadService({ storageService: fakeStorage });
        const validFile = { buffer: VALID_PNG_1X1, originalname: "ok.png", mimetype: "image/png" };

        // Exceeds policy.maxFilesPerRequest (1 on CHARACTER_SHEET_UPLOAD_POLICY)
        await assert.rejects(
            () =>
                service.upload({
                    files: [validFile, validFile],
                    policy: CHARACTER_SHEET_UPLOAD_POLICY,
                    userId: "user-123",
                }),
            (err) => {
                assert.ok(err instanceof ValidationError);
                assert.equal(err.statusCode, 400);
                assert.equal(err.code, "VALIDATION_ERROR");
                return true;
            }
        );

        // Within policy.maxFilesPerRequest (6 on ELEMENT_REFERENCE_UPLOAD_POLICY), but exceeds domain maxFiles: 1
        await assert.rejects(
            () =>
                service.upload({
                    files: [validFile, validFile],
                    policy: ELEMENT_REFERENCE_UPLOAD_POLICY,
                    maxFiles: 1,
                    userId: "user-123",
                }),
            (err) => {
                assert.ok(err instanceof ValidationError);
                assert.equal(err.statusCode, 400);
                assert.equal(err.code, "LIMIT_EXCEEDED");
                return true;
            }
        );

        assert.equal(fakeStorage.uploaded.length, 0);
    });

    it("enforces Phase 2 storage compensation: if file #2 fails storage upload, automatically discards file #1 and throws UploadError", async () => {
        const fakeStorage = createFakeStorage({ failOnUploadIndex: 2 });
        const service = new MediaUploadService({ storageService: fakeStorage });
        const validFile = { buffer: VALID_PNG_1X1, originalname: "ok.png", mimetype: "image/png" };

        await assert.rejects(
            () =>
                service.upload({
                    files: [validFile, validFile],
                    policy: ELEMENT_REFERENCE_UPLOAD_POLICY,
                    maxFiles: 6,
                    userId: "user-123",
                }),
            (err) => {
                assert.ok(err instanceof UploadError);
                assert.equal(err.statusCode, 502);
                assert.equal(err.code, "STORAGE_UPLOAD_ERROR");
                return true;
            }
        );

        assert.equal(fakeStorage.uploaded.length, 1, "First file was uploaded before second failed");
        assert.equal(fakeStorage.deletedBatches.length, 1, "discard() must be called automatically for already-uploaded keys");
        assert.deepEqual(fakeStorage.deletedBatches[0], [fakeStorage.uploaded[0].storageKey]);
    });

    it("never masks the original UploadError when discard() itself fails during Phase 2 compensation", async () => {
        const fakeStorage = createFakeStorage({ failOnUploadIndex: 2, failOnDelete: true });
        const service = new MediaUploadService({ storageService: fakeStorage });
        const validFile = { buffer: VALID_PNG_1X1, originalname: "ok.png", mimetype: "image/png" };

        await assert.rejects(
            () =>
                service.upload({
                    files: [validFile, validFile],
                    policy: ELEMENT_REFERENCE_UPLOAD_POLICY,
                    maxFiles: 6,
                    userId: "user-123",
                }),
            (err) => {
                assert.ok(err instanceof UploadError, "Must rethrow original UploadError, not the discard failure");
                assert.equal(err.statusCode, 502);
                assert.equal(err.code, "STORAGE_UPLOAD_ERROR");
                assert.match(err.message, /Simulated storage outage on upload #2/);
                return true;
            }
        );

        assert.equal(fakeStorage.deletedBatches.length, 1, "discard() was attempted");
    });

    it("discard ignores structured NoSuchKey code idempotently but throws and logs genuine storage errors including 404 bucket errors", async () => {
        let deleteFilesCalledWith = null;
        const fakeStorage = {
            ...createFakeStorage(),
            async deleteFiles(keys) {
                deleteFilesCalledWith = keys;
                return {
                    deleted: ["k1"],
                    failures: [
                        { key: "k2", code: "NoSuchKey" },
                    ],
                };
            },
        };
        const service = new MediaUploadService({ storageService: fakeStorage });
        // Must NOT throw on structured NoSuchKey
        await service.discard(["k1", "k2"]);
        assert.deepEqual(deleteFilesCalledWith, ["k1", "k2"]);

        // Must throw UploadError on genuine failures (e.g. 500 / EACCES)
        fakeStorage.deleteFiles = async () => ({
            deleted: [],
            failures: [{ key: "k4", message: "500 Internal Server Error" }],
        });
        await assert.rejects(
            service.discard(["k4"]),
            (err) => err instanceof UploadError && err.statusCode === 502
        );

        // A 404 without NoSuchKey code (e.g. from missing bucket) must be treated as a real error and thrown,
        // even when the word "bucket" is NOT in the message
        fakeStorage.deleteFiles = async () => ({
            deleted: [],
            failures: [{ key: "k3", statusCode: 404, message: "Not Found" }],
        });
        await assert.rejects(
            service.discard(["k3"]),
            (err) => err instanceof UploadError && err.statusCode === 502
        );

        // Must throw UploadError when failure indicates a missing bucket
        fakeStorage.deleteFiles = async () => ({
            deleted: [],
            failures: [{ key: "k5", message: "Bucket not found: generated_images", statusCode: 404 }],
        });
        await assert.rejects(
            service.discard(["k5"]),
            (err) => err instanceof UploadError && err.statusCode === 502
        );

        fakeStorage.deleteFiles = async () => ({
            deleted: [],
            failures: [{ key: "k6", code: "NoSuchBucket", message: "The specified bucket does not exist" }],
        });
        await assert.rejects(
            service.discard(["k6"]),
            (err) => err instanceof UploadError && err.statusCode === 502
        );
    });

    it("discard() logs and throws UploadError when Supabase remove() returns { error } through StorageService.deleteFiles", async () => {
        const { StorageService } = await import("#media/tools");
        const mockProvider = {
            async deleteFiles(paths) {
                // Simulate SupabaseStorageProvider receiving an error from supabase.storage.from().remove()
                return {
                    deletedCount: 0,
                    failures: paths.map((p) => ({ path: p, error: new Error("Bucket not found in project") })),
                };
            },
        };
        const storage = new StorageService("generated_images", mockProvider);
        const service = new MediaUploadService({ storageService: storage });

        await assert.rejects(
            service.discard(["user-1/uploads/orphan.webp"]),
            (err) => {
                assert.ok(err instanceof UploadError);
                assert.equal(err.statusCode, 502);
                assert.match(err.message, /Failed to discard 1 storage file\(s\)/);
                return true;
            }
        );
    });
});

function buildMultipartStream({ fieldName = "file", filename = "test.png", contentType = "image/png", payloadBuffer }) {
    const boundary = "----OpenArtBoundary7MA4YWxkTrZu0gW";
    const preamble = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
    const totalLength = preamble.length + payloadBuffer.length + epilogue.length;

    const req = new PassThrough();
    req.headers = {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(totalLength),
    };
    req.user = { id: "user-mw-test" };
    req.ip = "127.0.0.1";

    process.nextTick(() => {
        req.write(preamble);
        req.write(payloadBuffer);
        req.end(epilogue);
    });

    return req;
}

function invokeMiddleware(middleware, req) {
    return new Promise((resolve) => {
        const headers = {};
        const res = {
            statusCode: 200,
            headers,
            setHeader(k, v) {
                headers[k.toLowerCase()] = v;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(body) {
                resolve({ status: this.statusCode, body, headers, nextCalled: false });
                return this;
            },
        };
        req.res = res;
        middleware(req, res, (err) => {
            resolve({ status: err ? (err.statusCode || 500) : 200, err, headers, nextCalled: !err });
        });
    });
}

describe("createUploadMiddleware(policy) Seam 1 Contract (Ticket 02a)", () => {
    beforeEach(() => {
        resetActiveUploadsForTest();
        resetInFlightBytesForTest();
    });

    it("accepts a frozen UploadPolicy object directly without calling SourcePolicy.getProfile, while retaining the deprecated string purpose shim", async () => {
        const origGetProfile = SourcePolicy.getProfile;
        let getProfileCalls = 0;
        SourcePolicy.getProfile = function (...args) {
            getProfileCalls += 1;
            return origGetProfile.apply(this, args);
        };

        try {
            const mwDirect = createUploadMiddleware(ELEMENT_REFERENCE_UPLOAD_POLICY);
            assert.equal(typeof mwDirect, "function");
            assert.equal(getProfileCalls, 0, "Passing an UploadPolicy object must NOT invoke SourcePolicy.getProfile");

            const mwLegacy = createUploadMiddleware("element_reference");
            assert.equal(typeof mwLegacy, "function");
            assert.equal(getProfileCalls, 1, "Passing a legacy string purpose must invoke the deprecated SourcePolicy.getProfile shim");
        } finally {
            SourcePolicy.getProfile = origGetProfile;
        }
    });

    it("enforces stream-level magic-byte and policy allowedMimeTypes (415) across DEFAULT_UPLOAD_POLICY, ELEMENT_REFERENCE_UPLOAD_POLICY, and CHARACTER_DETAIL_UPLOAD_POLICY", async () => {
        const charMw = createUploadMiddleware(CHARACTER_DETAIL_UPLOAD_POLICY);
        const elemMw = createUploadMiddleware(ELEMENT_REFERENCE_UPLOAD_POLICY);
        const defaultMw = createUploadMiddleware(DEFAULT_UPLOAD_POLICY);

        // 1. Video bytes sent to CHARACTER_DETAIL_UPLOAD_POLICY declared as image/png (passes fileFilter, caught by stream magic-byte policy allowedMimeTypes check)
        const videoStreamReq = buildMultipartStream({
            filename: "clip.png",
            contentType: "image/png",
            payloadBuffer: buildMinimalMp4Buffer(),
        });
        const charRes = await invokeMiddleware(charMw, videoStreamReq);
        assert.equal(charRes.status, 415);
        assert.equal(charRes.body?.code, "UNSUPPORTED_MEDIA_TYPE");
        assert.match(charRes.body?.message || "", /Unsupported file type: video\/mp4/);

        // 2. Spoofed non-image bytes declared as image/png on ELEMENT_REFERENCE_UPLOAD_POLICY -> 415
        const spoofedReq = buildMultipartStream({
            filename: "spoof.png",
            contentType: "image/png",
            payloadBuffer: Buffer.alloc(64, 0x41),
        });
        const elemRes = await invokeMiddleware(elemMw, spoofedReq);
        assert.equal(elemRes.status, 415);
        assert.equal(elemRes.body?.code, "UNSUPPORTED_MEDIA_TYPE");

        // 3. Valid PNG on DEFAULT_UPLOAD_POLICY -> passes and populates req.file
        const validReq = buildMultipartStream({
            filename: "ok.png",
            contentType: "image/png",
            payloadBuffer: VALID_PNG_1X1,
        });
        const okRes = await invokeMiddleware(defaultMw, validReq);
        assert.equal(okRes.nextCalled, true);
        assert.equal(validReq.file?.detectedMimetype, "image/png");
    });

    it("enforces per-type streaming size limit (413 PAYLOAD_TOO_LARGE) when an image exceeds policy.maxImageSize under DEFAULT_UPLOAD_POLICY", async () => {
        const customSmallImagePolicy = Object.freeze({
            ...DEFAULT_UPLOAD_POLICY,
            maxImageSize: 1024, // 1 KB image cap
            maxVideoSize: 10 * 1024 * 1024, // 10 MB video cap
        });
        const mw = createUploadMiddleware(customSmallImagePolicy);

        const oversizedPng = Buffer.alloc(2048, 0);
        VALID_PNG_1X1.copy(oversizedPng, 0);

        const req = buildMultipartStream({
            filename: "big.png",
            contentType: "image/png",
            payloadBuffer: oversizedPng,
        });

        const res = await invokeMiddleware(mw, req);
        assert.equal(res.status, 413);
        assert.equal(res.body?.code, "PAYLOAD_TOO_LARGE");
    });

    it("preserves 429 TOO_MANY_CONCURRENT_UPLOADS and 503 SERVICE_UNAVAILABLE (in-flight RAM cap) when configured with an UploadPolicy", async () => {
        const mw = createUploadMiddleware(ELEMENT_REFERENCE_UPLOAD_POLICY);

        // Hold 3 active uploads open for the same user (default concurrency limit = 3)
        const boundary = "----OpenArtHoldBoundary";
        const makeOpenReq = () => {
            const req = new PassThrough();
            req.headers = {
                "content-type": `multipart/form-data; boundary=${boundary}`,
                "transfer-encoding": "chunked",
            };
            req.user = { id: "user-concurrent-1" };
            process.nextTick(() => {
                req.write(
                    `--${boundary}\r\n` +
                    `Content-Disposition: form-data; name="file"; filename="hold.png"\r\n` +
                    `Content-Type: image/png\r\n\r\n`
                );
                req.write(VALID_PNG_1X1);
            });
            return req;
        };

        const openReq1 = makeOpenReq();
        const openReq2 = makeOpenReq();
        const openReq3 = makeOpenReq();
        const p1 = invokeMiddleware(mw, openReq1);
        const p2 = invokeMiddleware(mw, openReq2);
        const p3 = invokeMiddleware(mw, openReq3);

        // Wait a tick for Busboy/Multer to enter _handleFile on all 3 streams
        await new Promise((r) => setTimeout(r, 20));

        // 4th concurrent upload for the same user -> 429 TOO_MANY_CONCURRENT_UPLOADS
        const req4 = buildMultipartStream({
            filename: "fourth.png",
            contentType: "image/png",
            payloadBuffer: VALID_PNG_1X1,
        });
        req4.user = { id: "user-concurrent-1" };
        const res4 = await invokeMiddleware(mw, req4);
        assert.equal(res4.status, 429);
        assert.equal(res4.body?.code, "TOO_MANY_CONCURRENT_UPLOADS");

        // Cleanly close the three open streams
        openReq1.end(`\r\n--${boundary}--\r\n`);
        openReq2.end(`\r\n--${boundary}--\r\n`);
        openReq3.end(`\r\n--${boundary}--\r\n`);
        await Promise.all([p1, p2, p3]);

        // Verify 503 SERVICE_UNAVAILABLE when MAX_IN_FLIGHT_UPLOAD_BYTES is exceeded
        const origMaxInFlight = process.env.MAX_IN_FLIGHT_UPLOAD_BYTES;
        process.env.MAX_IN_FLIGHT_UPLOAD_BYTES = "32";
        try {
            const lowRamMw = createUploadMiddleware(CHARACTER_DETAIL_UPLOAD_POLICY);
            const ramReq = buildMultipartStream({
                filename: "ram.png",
                contentType: "image/png",
                payloadBuffer: VALID_PNG_1X1, // > 32 bytes
            });
            const ramRes = await invokeMiddleware(lowRamMw, ramReq);
            assert.equal(ramRes.status, 503);
            assert.equal(ramRes.body?.code, "SERVICE_UNAVAILABLE");
        } finally {
            if (origMaxInFlight === undefined) delete process.env.MAX_IN_FLIGHT_UPLOAD_BYTES;
            else process.env.MAX_IN_FLIGHT_UPLOAD_BYTES = origMaxInFlight;
        }
    });

    it("applies allowedMimeTypes stream-sniffing ONLY when an UploadPolicy object is passed, preserving exact legacy string path behavior", async () => {
        for (const legacyPurpose of ["default", "element_reference", "character_reference"]) {
            const resolvedLegacy = resolveMiddlewarePolicy(legacyPurpose);
            assert.equal(resolvedLegacy.isPolicyObject, false);
            assert.equal(
                resolvedLegacy.streamAllowedMimeTypes,
                null,
                `Legacy string "${legacyPurpose}" must NOT enable streamAllowedMimeTypes in sizeLimitedStorage`
            );
        }

        for (const policyObj of [
            DEFAULT_UPLOAD_POLICY,
            ELEMENT_REFERENCE_UPLOAD_POLICY,
            CHARACTER_DETAIL_UPLOAD_POLICY,
            CHARACTER_SHEET_UPLOAD_POLICY,
        ]) {
            const resolvedPolicy = resolveMiddlewarePolicy(policyObj);
            assert.equal(resolvedPolicy.isPolicyObject, true);
            assert.deepEqual(resolvedPolicy.streamAllowedMimeTypes, policyObj.allowedMimeTypes);
        }

        // Behavioral verification: MP4 bytes declared as image/png on UploadPolicy vs legacy string
        const policyMw = createUploadMiddleware(CHARACTER_DETAIL_UPLOAD_POLICY);
        const legacyMw = createUploadMiddleware("character_reference");

        const policyRes = await invokeMiddleware(
            policyMw,
            buildMultipartStream({
                filename: "spoof.png",
                contentType: "image/png",
                payloadBuffer: buildMinimalMp4Buffer(),
            })
        );
        assert.equal(policyRes.status, 415);
        assert.equal(policyRes.body?.code, "UNSUPPORTED_MEDIA_TYPE");
        assert.match(
            policyRes.body?.message || "",
            /Unsupported file type: video\/mp4/,
            "UploadPolicy path must reject via stream-sniffed allowedMimeTypes"
        );

        const legacyRes = await invokeMiddleware(
            legacyMw,
            buildMultipartStream({
                filename: "spoof.png",
                contentType: "image/png",
                payloadBuffer: buildMinimalMp4Buffer(),
            })
        );
        assert.equal(legacyRes.status, 415);
        assert.equal(legacyRes.body?.code, "UNSUPPORTED_MEDIA_TYPE");
        assert.match(
            legacyRes.body?.message || "",
            /Declared MIME "image\/png" does not match detected file type \("video\/mp4"\)/,
            "Legacy string path must behave identically to pre-02a (declared-vs-detected check without streamAllowedMimeTypes)"
        );
    });

    it("verifies per-route equivalence between legacy string profile and target UploadPolicy (imageLimit, videoLimit, allowedMimeTypes, declared-MIME fileFilter behavior)", async () => {
        const routeMappings = [
            {
                route: "POST /api/assets/upload (routes/assets.js)",
                legacyPurpose: "default",
                targetPolicy: DEFAULT_UPLOAD_POLICY,
                allowsVideo: true,
            },
            {
                route: "POST /api/media/ingest (routes/mediaIngestRoutes.js)",
                legacyPurpose: "default",
                targetPolicy: DEFAULT_UPLOAD_POLICY,
                allowsVideo: true,
            },
            {
                route: "POST /api/v2/elements/:id/images (routes/elementRoutes.js)",
                legacyPurpose: "element_reference",
                targetPolicy: ELEMENT_REFERENCE_UPLOAD_POLICY,
                allowsVideo: false,
            },
            {
                route: "POST /api/characters/:characterId/media (routes/characters.js detail)",
                legacyPurpose: "character_reference",
                targetPolicy: CHARACTER_DETAIL_UPLOAD_POLICY,
                allowsVideo: false,
            },
            {
                route: "POST /api/characters/{create,/,character,:characterId/sheet-media} (routes/characters.js sheet)",
                legacyPurpose: "character_reference",
                targetPolicy: CHARACTER_SHEET_UPLOAD_POLICY,
                allowsVideo: false,
            },
        ];

        for (const { route, legacyPurpose, targetPolicy, allowsVideo } of routeMappings) {
            const legacyCfg = resolveMiddlewarePolicy(legacyPurpose);
            const policyCfg = resolveMiddlewarePolicy(targetPolicy);

            assert.equal(policyCfg.imageLimit, legacyCfg.imageLimit, `${route}: imageLimit must match`);
            assert.equal(policyCfg.videoLimit, legacyCfg.videoLimit, `${route}: videoLimit must match`);
            assert.equal(policyCfg.maxSizeBytes, legacyCfg.maxSizeBytes, `${route}: maxSizeBytes must match`);
            assert.deepEqual(policyCfg.allowedMimeTypes, legacyCfg.allowedMimeTypes, `${route}: allowedMimeTypes must match`);

            const legacyMw = createUploadMiddleware(legacyPurpose);
            const policyMw = createUploadMiddleware(targetPolicy);

            // Declared-MIME check 1: application/octet-stream rejected identically at fileFilter (415)
            const legacyOctetRes = await invokeMiddleware(
                legacyMw,
                buildMultipartStream({
                    filename: "raw.bin",
                    contentType: "application/octet-stream",
                    payloadBuffer: VALID_PNG_1X1,
                })
            );
            const policyOctetRes = await invokeMiddleware(
                policyMw,
                buildMultipartStream({
                    filename: "raw.bin",
                    contentType: "application/octet-stream",
                    payloadBuffer: VALID_PNG_1X1,
                })
            );
            assert.equal(legacyOctetRes.status, 415, `${route}: legacy must reject application/octet-stream`);
            assert.equal(policyOctetRes.status, 415, `${route}: policy must reject application/octet-stream`);
            assert.equal(policyOctetRes.body?.message, legacyOctetRes.body?.message);

            // Declared-MIME check 2: video/mp4 accepted on default routes, rejected at fileFilter on images-only routes
            const legacyVidRes = await invokeMiddleware(
                legacyMw,
                buildMultipartStream({
                    filename: "clip.mp4",
                    contentType: "video/mp4",
                    payloadBuffer: buildMinimalMp4Buffer(),
                })
            );
            const policyVidRes = await invokeMiddleware(
                policyMw,
                buildMultipartStream({
                    filename: "clip.mp4",
                    contentType: "video/mp4",
                    payloadBuffer: buildMinimalMp4Buffer(),
                })
            );
            if (allowsVideo) {
                assert.equal(legacyVidRes.nextCalled, true, `${route}: legacy must accept video/mp4`);
                assert.equal(policyVidRes.nextCalled, true, `${route}: policy must accept video/mp4`);
            } else {
                assert.equal(legacyVidRes.status, 415, `${route}: legacy must reject video/mp4`);
                assert.equal(policyVidRes.status, 415, `${route}: policy must reject video/mp4`);
                assert.equal(policyVidRes.body?.message, legacyVidRes.body?.message);
            }
        }
    });
});
}

// ─── Source: uploadPipelineAndPolicy.test.js ───
{
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
        const container = await import("../../../src/container.js");
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

    it("WorkflowMediaRepository & all server repositories route to supabaseAdmin to bypass RLS in background operations", async () => {
        const { supabaseAdmin } = await import("#shared/db/supabase.js");
        const { ProfileRepository } = await import("../../../src/systems/identity/internal/db/ProfileRepository.js");
        const wfMediaRepo = new WorkflowMediaRepository();

        assert.equal(wfMediaRepo.client(), supabaseAdmin, "WorkflowMediaRepository.client() must return supabaseAdmin");
        assert.equal(db.media.client(), supabaseAdmin, "MediaRepository.client() must return supabaseAdmin");
        assert.equal(db.elements.client(), supabaseAdmin, "ElementRepository.client() must return supabaseAdmin");
        assert.equal(db.workflows.client(), supabaseAdmin, "WorkflowRepository/BaseRepository.client() must return supabaseAdmin");
        assert.equal(db.projects.client(), supabaseAdmin, "ProjectRepository.client() must return supabaseAdmin");
        assert.equal(ProfileRepository.client(), supabaseAdmin, "ProfileRepository.client() must return supabaseAdmin");
    });
});
}

// ─── Source: ssrfSourcePolicyBoundary.test.js ───
{
const VALID_1PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

describe("SSRF Mitigation & SourcePolicy Boundary Tests (Task T4)", () => {
  let storageService;
  let mediaUploadService;
  let mockProvider;
  let originalFetch;
  let originalDnsLookup;

  before(() => {
    mockProvider = {
      upload: async (path, body, options) => {
        return `https://storage.example.com/${path}`;
      },
      delete: async () => {},
      deleteFiles: async () => ({ deletedCount: 1, failures: [] }),
      getPublicUrl: async (path) => `https://storage.example.com/${path}`,
    };

    storageService = new StorageService("test-bucket", mockProvider);
    mediaUploadService = new MediaUploadService({ storageService });
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalDnsLookup = dns.lookup;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    dns.lookup = originalDnsLookup;
  });

  // ── TEST 1: Direct Private IPv4 literals are rejected ──
  it("TEST 1: Rejects private IPv4 addresses (127.0.0.1, 10.x, 192.168.x, 169.254.x)", async () => {
    const targets = [
      "http://127.0.0.1/admin",
      "http://10.0.0.1/internal",
      "http://192.168.1.1/secret",
      "http://169.254.169.254/latest/meta-data/",
    ];

    for (const url of targets) {
      await assert.rejects(
        async () => {
          await mediaUploadService.upload({ files: [url], userId: "user-1" });
        },
        /(SSRF|forbidden|restricted|prohibited|invalid)/i,
        `Expected ${url} to be blocked by SSRF defense`
      );
    }
  });

  // ── TEST 2: Localhost and internal hostnames are rejected ──
  it("TEST 2: Rejects localhost, .local, and .internal domains", async () => {
    const targets = [
      "http://localhost:8080/data",
      "http://service.local/api",
      "http://metadata.internal/creds",
    ];

    for (const url of targets) {
      await assert.rejects(
        async () => {
          await mediaUploadService.upload({ files: [url], userId: "user-1" });
        },
        /(SSRF|forbidden|restricted|local)/i,
        `Expected ${url} to be blocked by SSRF defense`
      );
    }
  });

  // ── TEST 3: Hostname that resolves via DNS to a private IP is rejected ──
  it("TEST 3: Rejects public-looking hostname that resolves to a private IP (DNS rebinding)", async () => {
    dns.lookup = async (hostname) => {
      if (hostname === "evil.example.com") {
        return [{ address: "127.0.0.1", family: 4 }];
      }
      return [{ address: "93.184.216.34", family: 4 }];
    };

    await assert.rejects(
      async () => {
        await mediaUploadService.upload({
          files: ["http://evil.example.com/exploit.png"],
          userId: "user-1",
        });
      },
      /(SSRF|restricted IP|SSRF protection)/i,
      "Expected evil.example.com resolving to 127.0.0.1 to be blocked"
    );
  });

  // ── TEST 4: Redirect from public URL to internal private IP is rejected ──
  it("TEST 4: Rejects redirect from a public URL to a private IP address", async () => {
    dns.lookup = async (hostname) => {
      return [{ address: "93.184.216.34", family: 4 }];
    };

    globalThis.fetch = async (url, options = {}) => {
      // First hop: public host redirects to private IP
      if (url.includes("public.example.com")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:8080/metadata" },
        });
      }
      return new Response(Buffer.from("leak"), { status: 200 });
    };

    await assert.rejects(
      async () => {
        await mediaUploadService.upload({
          files: ["http://public.example.com/redirect"],
          userId: "user-1",
        });
      },
      /(SSRF|forbidden|restricted|private)/i,
      "Expected redirect to 127.0.0.1 to be blocked"
    );
  });

  // ── TEST 5: Non-http/https protocols are rejected ──
  it("TEST 5: Rejects non-HTTP(S) protocols like file:// or ftp://", async () => {
    const prohibited = [
      "file:///etc/passwd",
      "ftp://example.com/image.png",
      "gopher://127.0.0.1:70",
    ];

    for (const url of prohibited) {
      await assert.rejects(
        async () => {
          await mediaUploadService.upload({ files: [url], userId: "user-1" });
        },
        /(protocol|Only HTTP|Unsupported source format|invalid)/i,
        `Expected protocol in ${url} to be rejected by MediaUploadService`
      );
      await assert.rejects(
        async () => {
          await SourceReader.read({ kind: "url", value: url });
        },
        /(protocol|Only HTTP|invalid)/i,
        `Expected protocol in ${url} to be rejected by SourceReader / SourcePolicy`
      );
    }
  });

  // ── TEST 6: Oversize body is rejected ──
  it("TEST 6: Rejects remote file that exceeds maximum allowed size", async () => {
    dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];

    globalThis.fetch = async () => {
      // Declares 150MB content length, default limit is 100MB
      return new Response(Buffer.alloc(1024), {
        status: 200,
        headers: {
          "content-length": String(150 * 1024 * 1024),
          "content-type": "image/png",
        },
      });
    };

    await assert.rejects(
      async () => {
        await mediaUploadService.upload({
          files: ["https://public.example.com/huge.png"],
          userId: "user-1",
        });
      },
      /(too large|exceeds maximum|limit)/i,
      "Expected oversize file to be rejected"
    );
  });

  // ── TEST 7: Prohibited MIME type is rejected ──
  it("TEST 7: Rejects remote file with disallowed MIME type", async () => {
    dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];

    globalThis.fetch = async () => {
      return new Response(Buffer.from("<script>alert(1)</script>"), {
        status: 200,
        headers: {
          "content-type": "text/html",
        },
      });
    };

    await assert.rejects(
      async () => {
        await mediaUploadService.upload({
          files: ["https://public.example.com/file.html"],
          userId: "user-1",
          policy: CHARACTER_DETAIL_UPLOAD_POLICY, // only images allowed
        });
      },
      /(format|MIME|not allowed|HTML \/ Script)/i,
      "Expected non-image MIME type to be rejected for character_reference"
    );
  });

  // ── TEST 8: Valid public image URL succeeds ──
  it("TEST 8: Legitimate public image URL succeeds and uploads to storage", async () => {
    dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];

    globalThis.fetch = async () => {
      return new Response(VALID_1PX_PNG, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(VALID_1PX_PNG.length),
        },
      });
    };

    const { uploaded } = await mediaUploadService.upload({
      files: ["https://public.example.com/image.png"],
      userId: "user-1",
    });
    assert.strictEqual(uploaded.length, 1);
    assert.match(uploaded[0].url, /^https:\/\/storage\.example\.com\/user-1\/uploads\/.+\.png$/);
  });
});
}

// ─── Source: uploadRoutersPolicyWiring.test.js ───
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

function buildMinimalHeicBuffer() {
    const buf = Buffer.alloc(64, 0);
    buf.writeUInt32BE(24, 0);
    buf.write("ftyp", 4, "ascii");
    buf.write("heic", 8, "ascii");
    buf.writeUInt32BE(0, 12);
    buf.write("heicmif1", 16, "ascii");
    return buf;
}

function buildMinimalMp4Buffer() {
    const buf = Buffer.alloc(64, 0);
    buf.writeUInt32BE(24, 0);
    buf.write("ftyp", 4, "ascii");
    buf.write("isom", 8, "ascii");
    buf.writeUInt32BE(512, 12);
    buf.write("isomiso2", 16, "ascii");
    return buf;
}

function buildMinimalJpegBuffer() {
    const buf = Buffer.alloc(64, 0);
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).copy(buf, 0);
    buf[62] = 0xff;
    buf[63] = 0xd9;
    return buf;
}

const GARBAGE_BYTES_64 = Buffer.alloc(64, 0x41);

function buildOversizedPngBuffer() {
    const buf = Buffer.alloc(20 * 1024 * 1024 + 1024, 0);
    VALID_PNG_1X1.copy(buf, 0);
    return buf;
}

function encodeMultipartBody({ fieldName = "file", filename = "upload.png", contentType = "image/png", payloadBuffer, fields = {} }) {
    const boundary = "----OpenArtRouteTestBoundary987654";
    const parts = [];

    for (const [k, v] of Object.entries(fields)) {
        parts.push(
            Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="${k}"\r\n\r\n` +
                `${v}\r\n`,
                "utf8"
            )
        );
    }

    parts.push(
        Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
            `Content-Type: ${contentType}\r\n\r\n`,
            "utf8"
        )
    );
    parts.push(payloadBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));

    return {
        boundary,
        bodyBuffer: Buffer.concat(parts),
    };
}

async function sendMultipartRequest(baseUrl, path, { filename, contentType, payloadBuffer, fields = {}, token = "test-user-02b" }) { // gate:allow-secret
    const { boundary, bodyBuffer } = encodeMultipartBody({
        filename,
        contentType,
        payloadBuffer,
        fields,
    });

    const url = new URL(path, baseUrl);
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname + url.search,
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": `multipart/form-data; boundary=${boundary}`,
                    "Content-Length": bodyBuffer.length,
                },
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    let body = null;
                    try {
                        body = JSON.parse(text);
                    } catch {
                        body = { raw: text };
                    }
                    resolve({ status: res.statusCode, body });
                });
            }
        );
        req.on("error", reject);
        req.end(bodyBuffer);
    });
}

function buildLegacyReferenceApp() {
    const legacyApp = express();
    const legacyDefaultUpload = createUploadMiddleware("default");
    const legacyElementUpload = createUploadMiddleware("element_reference");
    const legacyCharacterUpload = createUploadMiddleware("character_reference");

    legacyApp.post("/api/assets/upload", legacyDefaultUpload, (req, res) => {
        res.status(200).json({ ok: true, size: req.file?.size });
    });
    legacyApp.post("/api/media/ingest", legacyDefaultUpload, (req, res) => {
        res.status(200).json({ ok: true, size: req.file?.size });
    });
    legacyApp.post("/api/v2/elements/:id/images", legacyElementUpload, (req, res) => {
        res.status(201).json({ status: "created", media: { id: "legacy-elem-media" } });
    });
    for (const charPath of [
        "/api/characters/create",
        "/api/characters",
        "/api/characters/character",
        "/api/characters/:characterId/media",
        "/api/characters/:characterId/sheet-media",
        "/api/characters/:characterId/upload",
    ]) {
        legacyApp.post(charPath, legacyCharacterUpload, (req, res) => {
            res.status(200).json({ ok: true, size: req.file?.size });
        });
    }
    return legacyApp;
}

async function assertDeclaredMimeMismatchAndOctetStreamParity(baseUrl, legacyBaseUrl, path, fields = {}) {
    // (d1) Declared application/octet-stream with real PNG bytes -> 415 UNSUPPORTED_MEDIA_TYPE
    const octetPngRes = await sendMultipartRequest(baseUrl, path, {
        filename: "raw.bin",
        contentType: "application/octet-stream",
        payloadBuffer: VALID_PNG_1X1,
        fields,
    });
    const legacyOctetPngRes = await sendMultipartRequest(legacyBaseUrl, path, {
        filename: "raw.bin",
        contentType: "application/octet-stream",
        payloadBuffer: VALID_PNG_1X1,
        fields,
    });
    assert.equal(octetPngRes.status, 415, `${path}: application/octet-stream with real PNG bytes must return 415`);
    assert.equal(octetPngRes.status, legacyOctetPngRes.status);
    assert.equal(octetPngRes.body?.code, "UNSUPPORTED_MEDIA_TYPE");
    assert.equal(octetPngRes.body?.code, legacyOctetPngRes.body?.code);
    assert.equal(octetPngRes.body?.message, "Unsupported file type: application/octet-stream");
    assert.equal(octetPngRes.body?.message, legacyOctetPngRes.body?.message);

    // (d2) Declared application/octet-stream with garbage bytes -> 415 UNSUPPORTED_MEDIA_TYPE
    const octetGarbageRes = await sendMultipartRequest(baseUrl, path, {
        filename: "garbage.bin",
        contentType: "application/octet-stream",
        payloadBuffer: GARBAGE_BYTES_64,
        fields,
    });
    const legacyOctetGarbageRes = await sendMultipartRequest(legacyBaseUrl, path, {
        filename: "garbage.bin",
        contentType: "application/octet-stream",
        payloadBuffer: GARBAGE_BYTES_64,
        fields,
    });
    assert.equal(octetGarbageRes.status, 415, `${path}: application/octet-stream with garbage bytes must return 415`);
    assert.equal(octetGarbageRes.status, legacyOctetGarbageRes.status);
    assert.equal(octetGarbageRes.body?.code, "UNSUPPORTED_MEDIA_TYPE");
    assert.equal(octetGarbageRes.body?.code, legacyOctetGarbageRes.body?.code);
    assert.equal(octetGarbageRes.body?.message, "Unsupported file type: application/octet-stream");
    assert.equal(octetGarbageRes.body?.message, legacyOctetGarbageRes.body?.message);

    // (e) Declared image/png with real JPEG bytes (both allowed types, declared != detected) -> 415 UNSUPPORTED_MEDIA_TYPE
    const jpegBytes = buildMinimalJpegBuffer();
    const mismatchRes = await sendMultipartRequest(baseUrl, path, {
        filename: "mismatch.png",
        contentType: "image/png",
        payloadBuffer: jpegBytes,
        fields,
    });
    const legacyMismatchRes = await sendMultipartRequest(legacyBaseUrl, path, {
        filename: "mismatch.png",
        contentType: "image/png",
        payloadBuffer: jpegBytes,
        fields,
    });
    assert.equal(mismatchRes.status, 415, `${path}: declared image/png with real JPEG bytes must return 415`);
    assert.equal(mismatchRes.status, legacyMismatchRes.status);
    assert.equal(mismatchRes.body?.code, "UNSUPPORTED_MEDIA_TYPE");
    assert.equal(mismatchRes.body?.code, legacyMismatchRes.body?.code);
    assert.equal(
        mismatchRes.body?.message,
        'Declared MIME "image/png" does not match detected file type ("image/jpeg").'
    );
    assert.equal(mismatchRes.body?.message, legacyMismatchRes.body?.message);
}

describe("Ticket 02b — Upload Routers Policy Wiring & Route-Level Parity Tests", () => {
    let server;
    let baseUrl;
    let legacyDefaultServer;
    let legacyDefaultBaseUrl;
    let origGetUser;

    before(async () => {
        origGetUser = supabase?.auth?.getUser;
        if (supabase?.auth) {
            supabase.auth.getUser = async (token) => {
                if (token && token.startsWith("test-user")) {
                    return { data: { user: { id: token } }, error: null };
                }
                return { data: { user: null }, error: new Error("Invalid token") };
            };
        }

        const app = express();
        app.use(express.json());
        app.use("/api/assets", assetsRouter);
        app.use("/api/media", mediaIngestRouter);
        app.use("/api/v2/elements", elementRoutes);
        app.use("/api/characters", charactersRouter);

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;

        const legacyDefaultApp = buildLegacyReferenceApp();
        legacyDefaultServer = http.createServer(legacyDefaultApp);
        await new Promise((resolve) => legacyDefaultServer.listen(0, "127.0.0.1", resolve));
        legacyDefaultBaseUrl = `http://127.0.0.1:${legacyDefaultServer.address().port}`;
    });

    after(async () => {
        if (supabase?.auth && origGetUser) {
            supabase.auth.getUser = origGetUser;
        }
        await Promise.allSettled([
            rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect()),
            redisConnection?.quit().catch(() => redisConnection?.disconnect()),
            workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect()),
        ]);
        if (server) await new Promise((resolve) => server.close(resolve));
        if (legacyDefaultServer) await new Promise((resolve) => legacyDefaultServer.close(resolve));
    });

    beforeEach(() => {
        resetActiveUploadsForTest();
        resetInFlightBytesForTest();
    });

    describe("1. routes/assets.js — POST /api/assets/upload (DEFAULT_UPLOAD_POLICY)", () => {
        it("matches legacy status and error code across valid image, spoofed MIME, oversized file, and application/octet-stream while enforcing DEFAULT_UPLOAD_POLICY stream sniffing", async () => {
            const origUploadAsset = assetUploadService.uploadAsset;
            assetUploadService.uploadAsset = async ({ source }) => ({
                url: "https://cdn.example.com/uploads/asset.png",
                mediaId: "media-asset-1",
                workflowId: "wf-asset-1",
                type: "image",
                width: 1,
                height: 1,
                ratio: "1:1",
                sizeBytes: source?.size || 67,
            });

            try {
                // (a) Valid image -> 200 OK
                const validRes = await sendMultipartRequest(baseUrl, "/api/assets/upload", {
                    filename: "valid.png",
                    contentType: "image/png",
                    payloadBuffer: VALID_PNG_1X1,
                });
                const legacyValidRes = await sendMultipartRequest(legacyDefaultBaseUrl, "/api/assets/upload", {
                    filename: "valid.png",
                    contentType: "image/png",
                    payloadBuffer: VALID_PNG_1X1,
                });
                assert.equal(validRes.status, 200);
                assert.equal(validRes.status, legacyValidRes.status);
                assert.equal(validRes.body?.ok, true);

                // (b) Spoofed MIME (disallowed HEIC magic bytes declared as image/png) -> 415 UNSUPPORTED_MEDIA_TYPE
                const spoofRes = await sendMultipartRequest(baseUrl, "/api/assets/upload", {
                    filename: "spoof.png",
                    contentType: "image/png",
                    payloadBuffer: buildMinimalHeicBuffer(),
                });
                const legacySpoofRes = await sendMultipartRequest(legacyDefaultBaseUrl, "/api/assets/upload", {
                    filename: "spoof.png",
                    contentType: "image/png",
                    payloadBuffer: buildMinimalHeicBuffer(),
                });
                assert.equal(spoofRes.status, 415);
                assert.equal(spoofRes.status, legacySpoofRes.status);
                assert.equal(spoofRes.body?.code, "UNSUPPORTED_MEDIA_TYPE");
                assert.equal(spoofRes.body?.code, legacySpoofRes.body?.code);
                assert.match(
                    spoofRes.body?.message || "",
                    /Unsupported file type: image\/heic/,
                    "routes/assets.js must be wired to DEFAULT_UPLOAD_POLICY"
                );

                // (c) Oversized image (> 20MB) -> 413 PAYLOAD_TOO_LARGE
                const oversizedBuf = buildOversizedPngBuffer();
                const overRes = await sendMultipartRequest(baseUrl, "/api/assets/upload", {
                    filename: "huge.png",
                    contentType: "image/png",
                    payloadBuffer: oversizedBuf,
                });
                const legacyOverRes = await sendMultipartRequest(legacyDefaultBaseUrl, "/api/assets/upload", {
                    filename: "huge.png",
                    contentType: "image/png",
                    payloadBuffer: oversizedBuf,
                });
                assert.equal(overRes.status, 413);
                assert.equal(overRes.status, legacyOverRes.status);
                assert.equal(overRes.body?.code, "PAYLOAD_TOO_LARGE");
                assert.equal(overRes.body?.code, legacyOverRes.body?.code);

                // (d1) application/octet-stream with real PNG bytes, (d2) application/octet-stream with garbage bytes,
                // (e) declared image/png with real JPEG bytes
                await assertDeclaredMimeMismatchAndOctetStreamParity(
                    baseUrl,
                    legacyDefaultBaseUrl,
                    "/api/assets/upload"
                );
            } finally {
                assetUploadService.uploadAsset = origUploadAsset;
            }
        });
    });

    describe("2. routes/mediaIngestRoutes.js — POST /api/media/ingest (DEFAULT_UPLOAD_POLICY)", () => {
        it("matches legacy status and error code across valid image, spoofed MIME, oversized file, and application/octet-stream while enforcing DEFAULT_UPLOAD_POLICY stream sniffing", async () => {
            const origUploadAsset = assetUploadService.uploadAsset;
            assetUploadService.uploadAsset = async () => ({
                url: "https://cdn.example.com/uploads/ingested.png",
                mediaId: "media-ingest-1",
                workflowId: "wf-ingest-1",
                type: "image",
                width: 1,
                height: 1,
                ratio: "1:1",
                format: "PNG",
                isNew: true,
                media: { id: "media-ingest-1" },
            });

            try {
                // (a) Valid image -> 200 OK
                const validRes = await sendMultipartRequest(baseUrl, "/api/media/ingest", {
                    filename: "valid.png",
                    contentType: "image/png",
                    payloadBuffer: VALID_PNG_1X1,
                });
                const legacyValidRes = await sendMultipartRequest(legacyDefaultBaseUrl, "/api/media/ingest", {
                    filename: "valid.png",
                    contentType: "image/png",
                    payloadBuffer: VALID_PNG_1X1,
                });
                assert.equal(validRes.status, 200);
                assert.equal(validRes.status, legacyValidRes.status);
                assert.equal(validRes.body?.ok, true);

                // (b) Spoofed MIME (disallowed HEIC magic bytes declared as image/png) -> 415 UNSUPPORTED_MEDIA_TYPE
                const spoofRes = await sendMultipartRequest(baseUrl, "/api/media/ingest", {
                    filename: "spoof.png",
                    contentType: "image/png",
                    payloadBuffer: buildMinimalHeicBuffer(),
                });
                const legacySpoofRes = await sendMultipartRequest(legacyDefaultBaseUrl, "/api/media/ingest", {
                    filename: "spoof.png",
                    contentType: "image/png",
                    payloadBuffer: buildMinimalHeicBuffer(),
                });
                assert.equal(spoofRes.status, 415);
                assert.equal(spoofRes.status, legacySpoofRes.status);
                assert.equal(spoofRes.body?.code, "UNSUPPORTED_MEDIA_TYPE");
                assert.equal(spoofRes.body?.code, legacySpoofRes.body?.code);
                assert.match(
                    spoofRes.body?.message || "",
                    /Unsupported file type: image\/heic/,
                    "routes/mediaIngestRoutes.js must be wired to DEFAULT_UPLOAD_POLICY"
                );

                // (c) Oversized image (> 20MB) -> 413 PAYLOAD_TOO_LARGE
                const oversizedBuf = buildOversizedPngBuffer();
                const overRes = await sendMultipartRequest(baseUrl, "/api/media/ingest", {
                    filename: "huge.png",
                    contentType: "image/png",
                    payloadBuffer: oversizedBuf,
                });
                const legacyOverRes = await sendMultipartRequest(legacyDefaultBaseUrl, "/api/media/ingest", {
                    filename: "huge.png",
                    contentType: "image/png",
                    payloadBuffer: oversizedBuf,
                });
                assert.equal(overRes.status, 413);
                assert.equal(overRes.status, legacyOverRes.status);
                assert.equal(overRes.body?.code, "PAYLOAD_TOO_LARGE");
                assert.equal(overRes.body?.code, legacyOverRes.body?.code);

                // (d1) application/octet-stream with real PNG bytes, (d2) application/octet-stream with garbage bytes,
                // (e) declared image/png with real JPEG bytes
                await assertDeclaredMimeMismatchAndOctetStreamParity(
                    baseUrl,
                    legacyDefaultBaseUrl,
                    "/api/media/ingest"
                );
            } finally {
                assetUploadService.uploadAsset = origUploadAsset;
            }
        });

        it("strips client-supplied folder from req.body and logs warning when deprecated purpose is provided", async () => {
            const origUploadAsset = assetUploadService.uploadAsset;
            let capturedOptions = null;
            assetUploadService.uploadAsset = async (opts) => {
                capturedOptions = opts;
                return {
                    url: "https://cdn.example.com/uploads/ingested.png",
                    mediaId: "media-ingest-1",
                    workflowId: "wf-ingest-1",
                    type: "image",
                    width: 1,
                    height: 1,
                    ratio: "1:1",
                    format: "PNG",
                    isNew: true,
                    media: { id: "media-ingest-1" },
                };
            };

            try {
                const res = await sendMultipartRequest(baseUrl, "/api/media/ingest", {
                    filename: "valid.png",
                    contentType: "image/png",
                    payloadBuffer: VALID_PNG_1X1,
                    fields: {
                        folder: "element-references",
                        purpose: "element_reference",
                        project_id: "proj-1",
                    },
                });

                assert.equal(res.status, 200);
                assert.ok(capturedOptions, "assetUploadService.uploadAsset must be called");
                assert.equal(capturedOptions.folder, undefined, "routes/mediaIngestRoutes must NOT pass client folder to uploadAsset");
                assert.equal(capturedOptions.projectId, "proj-1");
            } finally {
                assetUploadService.uploadAsset = origUploadAsset;
            }
        });

        it("sanitizes purpose in warning log: strips control characters and truncates to 64 chars", async () => {
            const origUploadAsset = assetUploadService.uploadAsset;
            assetUploadService.uploadAsset = async () => ({
                url: "https://cdn.example.com/uploads/ingested.png",
                mediaId: "media-ingest-2",
                workflowId: "wf-ingest-2",
                type: "image",
                width: 1,
                height: 1,
                ratio: "1:1",
                format: "PNG",
                isNew: true,
                media: { id: "media-ingest-2" },
            });

            try {
                const maliciousPurpose = "malicious_\x00\r\n\x1b[31mevil_preset_" + "A".repeat(100);
                const res = await sendMultipartRequest(baseUrl, "/api/media/ingest", {
                    filename: "valid.png",
                    contentType: "image/png",
                    payloadBuffer: VALID_PNG_1X1,
                    fields: {
                        purpose: maliciousPurpose,
                        project_id: "proj-1",
                    },
                });

                assert.equal(res.status, 200);
                assert.equal(res.body?.ok, true);
            } finally {
                assetUploadService.uploadAsset = origUploadAsset;
            }
        });
    });

    describe("3. routes/elementRoutes.js — POST /api/v2/elements/:id/images (ELEMENT_REFERENCE_UPLOAD_POLICY + preUploadElementCapacityGuard ordering)", () => {
        const ELEMENT_ID = "00000000-0000-0000-0000-000000000001";

        it("runs preUploadElementCapacityGuard BEFORE upload middleware (fail-fast before Multer parses stream) and enforces ELEMENT_REFERENCE_UPLOAD_POLICY", async () => {
            const origAssertUploadAllowed = elementMediaService.assertUploadAllowed;
            const origAddReferenceMedia = elementMediaService.addReferenceMedia;
            const origElementsRepo = db.elements;

            const callOrder = [];
            let guardShouldRejectFull = false;

            db.elements = {
                ...origElementsRepo,
                findById: async (id) => ({ id, user_id: "test-user-02b", project_id: "proj-1", workflow_id: "wf-elem-1" }),
                resolveRecord: async (id) => ({ id, user_id: "test-user-02b", project_id: "proj-1", workflow_id: "wf-elem-1" }),
            };

            elementMediaService.assertUploadAllowed = async ({ elementId, userId }) => {
                callOrder.push("preUploadElementCapacityGuard");
                if (guardShouldRejectFull) {
                    const err = new Error("Maximum 6 reference images allowed per element");
                    err.statusCode = 400;
                    err.errorCode = "LIMIT_EXCEEDED";
                    throw err;
                }
                return { allowed: true, currentCount: 0, maxAllowed: 6, remainingSlots: 6, workflowId: elementId };
            };

            elementMediaService.addReferenceMedia = async ({ file }) => {
                assert.ok(file?.buffer, "Multer upload.single('file') must populate req.file before addImageToElement");
                callOrder.push("upload->addImageToElement");
                return { media: { id: "media-elem-1", url: "https://cdn.example.com/elem.png" } };
            };

            try {
                // 1. Order check when Element is full: sending application/octet-stream (which Multer would reject with 415)
                // must return 400 LIMIT_EXCEEDED from preUploadElementCapacityGuard BEFORE Multer runs
                guardShouldRejectFull = true;
                const fullRes = await sendMultipartRequest(baseUrl, `/api/v2/elements/${ELEMENT_ID}/images`, {
                    filename: "raw.bin",
                    contentType: "application/octet-stream",
                    payloadBuffer: VALID_PNG_1X1,
                });
                assert.equal(fullRes.status, 400, "preUploadElementCapacityGuard must short-circuit with 400 before Multer 415");
                assert.equal(fullRes.body?.code, "LIMIT_EXCEEDED");
                assert.deepEqual(callOrder, ["preUploadElementCapacityGuard"]);

                // 2. (a) Valid image -> 201 Created and exact middleware execution order
                guardShouldRejectFull = false;
                callOrder.length = 0;
                const validRes = await sendMultipartRequest(baseUrl, `/api/v2/elements/${ELEMENT_ID}/images`, {
                    filename: "valid.png",
                    contentType: "image/png",
                    payloadBuffer: VALID_PNG_1X1,
                });
                const legacyValidRes = await sendMultipartRequest(legacyDefaultBaseUrl, `/api/v2/elements/${ELEMENT_ID}/images`, {
                    filename: "valid.png",
                    contentType: "image/png",
                    payloadBuffer: VALID_PNG_1X1,
                });
                assert.equal(validRes.status, 201);
                assert.equal(validRes.status, legacyValidRes.status);
                assert.deepEqual(callOrder, ["preUploadElementCapacityGuard", "upload->addImageToElement"]);

                // 3. (b) Spoofed MIME (MP4 video bytes declared as image/png) -> 415 UNSUPPORTED_MEDIA_TYPE
                const spoofRes = await sendMultipartRequest(baseUrl, `/api/v2/elements/${ELEMENT_ID}/images`, {
                    filename: "spoof.png",
                    contentType: "image/png",
                    payloadBuffer: buildMinimalMp4Buffer(),
                });
                const legacySpoofRes = await sendMultipartRequest(legacyDefaultBaseUrl, `/api/v2/elements/${ELEMENT_ID}/images`, {
                    filename: "spoof.png",
                    contentType: "image/png",
                    payloadBuffer: buildMinimalMp4Buffer(),
                });
                assert.equal(spoofRes.status, 415);
                assert.equal(spoofRes.status, legacySpoofRes.status);
                assert.equal(spoofRes.body?.code, "UNSUPPORTED_MEDIA_TYPE");
                assert.equal(spoofRes.body?.code, legacySpoofRes.body?.code);
                assert.match(
                    spoofRes.body?.message || "",
                    /Unsupported file type: video\/mp4/,
                    "routes/elementRoutes.js must be wired to ELEMENT_REFERENCE_UPLOAD_POLICY"
                );

                // 4. (c) Oversized image (> 20MB) -> 413 PAYLOAD_TOO_LARGE
                const oversizedBuf = buildOversizedPngBuffer();
                const overRes = await sendMultipartRequest(baseUrl, `/api/v2/elements/${ELEMENT_ID}/images`, {
                    filename: "huge.png",
                    contentType: "image/png",
                    payloadBuffer: oversizedBuf,
                });
                const legacyOverRes = await sendMultipartRequest(legacyDefaultBaseUrl, `/api/v2/elements/${ELEMENT_ID}/images`, {
                    filename: "huge.png",
                    contentType: "image/png",
                    payloadBuffer: oversizedBuf,
                });
                assert.equal(overRes.status, 413);
                assert.equal(overRes.status, legacyOverRes.status);
                assert.equal(overRes.body?.code, "PAYLOAD_TOO_LARGE");
                assert.equal(overRes.body?.code, legacyOverRes.body?.code);

                // 5. (d1) application/octet-stream with real PNG bytes, (d2) application/octet-stream with garbage bytes,
                // (e) declared image/png with real JPEG bytes
                await assertDeclaredMimeMismatchAndOctetStreamParity(
                    baseUrl,
                    legacyDefaultBaseUrl,
                    `/api/v2/elements/${ELEMENT_ID}/images`
                );
            } finally {
                elementMediaService.assertUploadAllowed = origAssertUploadAllowed;
                elementMediaService.addReferenceMedia = origAddReferenceMedia;
                db.elements = origElementsRepo;
            }
        });
    });

    describe("4. routes/characters.js — sheet vs detail UploadPolicy wiring & middleware parity guard", () => {
        const CHAR_ID = "00000000-0000-0000-0000-000000000009";

        it("fails if CHARACTER_SHEET_UPLOAD_POLICY and CHARACTER_DETAIL_UPLOAD_POLICY ever differ in any field consumed by createUploadMiddleware (imageLimit, videoLimit, maxSizeBytes, allowedMimeTypes)", () => {
            const sheetCfg = resolveMiddlewarePolicy(CHARACTER_SHEET_UPLOAD_POLICY);
            const detailCfg = resolveMiddlewarePolicy(CHARACTER_DETAIL_UPLOAD_POLICY);

            assert.equal(sheetCfg.imageLimit, detailCfg.imageLimit, "sheet and detail must share identical imageLimit");
            assert.equal(sheetCfg.videoLimit, detailCfg.videoLimit, "sheet and detail must share identical videoLimit");
            assert.equal(sheetCfg.maxSizeBytes, detailCfg.maxSizeBytes, "sheet and detail must share identical maxSizeBytes");
            assert.deepEqual(
                sheetCfg.allowedMimeTypes,
                detailCfg.allowedMimeTypes,
                "sheet and detail must share identical allowedMimeTypes"
            );

            // Verify router mounts one middleware instance per policy:
            // /create, /, /character, /:characterId/sheet-media, and /:characterId/upload share uploadSheet;
            // /:characterId/media mounts the separate uploadDetail instance.
            const routeMiddlewareByPath = new Map();
            for (const layer of charactersRouter.stack) {
                if (layer.route && layer.route.methods?.post) {
                    routeMiddlewareByPath.set(layer.route.path, layer.route.stack[0]?.handle);
                }
            }
            const sheetMwHandle = routeMiddlewareByPath.get("/create");
            const detailMwHandle = routeMiddlewareByPath.get("/:characterId/media");
            assert.equal(typeof sheetMwHandle, "function");
            assert.equal(typeof detailMwHandle, "function");
            assert.notEqual(
                sheetMwHandle,
                detailMwHandle,
                "/:characterId/media must use a dedicated uploadDetail middleware instance distinct from uploadSheet"
            );
            for (const sheetRoutePath of ["/create", "/", "/character", "/:characterId/sheet-media", "/:characterId/upload"]) {
                assert.equal(
                    routeMiddlewareByPath.get(sheetRoutePath),
                    sheetMwHandle,
                    `${sheetRoutePath} must use the uploadSheet (CHARACTER_SHEET_UPLOAD_POLICY) middleware instance`
                );
            }
        });

        it("wires all 6 character upload endpoints to CHARACTER_SHEET_UPLOAD_POLICY / CHARACTER_DETAIL_UPLOAD_POLICY and matches legacy status and error codes", async () => {
            const origCreateCharacter = characterService.createCharacter;
            const origAddMedia = characterService.addMediaToCharacter;
            const origSetSheet = characterService.setCharacterSheetMedia;

            characterService.createCharacter = async ({ file }) => {
                assert.ok(file?.buffer, "createCharacter must receive req.file from uploadSheet");
                return { characterId: CHAR_ID, media: { id: "media-char-sheet" } };
            };
            characterService.addMediaToCharacter = async ({ file }) => {
                assert.ok(file?.buffer, "addMediaToCharacter must receive req.file from uploadDetail");
                return { media: { id: "media-char-detail" } };
            };
            characterService.setCharacterSheetMedia = async ({ file }) => {
                assert.ok(file?.buffer, "setCharacterSheetMedia must receive req.file from uploadSheet");
                return { media: { id: "media-char-sheet-replace" } };
            };

            const endpoints = [
                { path: "/api/characters/create", fields: { project_id: "proj-1", name: "Hero" } },
                { path: "/api/characters", fields: { project_id: "proj-1", name: "Hero" } },
                { path: "/api/characters/character", fields: { project_id: "proj-1", name: "Hero" } },
                { path: `/api/characters/${CHAR_ID}/media`, fields: { projectId: "proj-1" } },
                { path: `/api/characters/${CHAR_ID}/sheet-media`, fields: { projectId: "proj-1" } },
                { path: `/api/characters/${CHAR_ID}/upload`, fields: { projectId: "proj-1", type: "sheet" } },
            ];

            try {
                for (const { path, fields } of endpoints) {
                    // (a) Valid image -> 200 OK
                    const validRes = await sendMultipartRequest(baseUrl, path, {
                        filename: "valid.png",
                        contentType: "image/png",
                        payloadBuffer: VALID_PNG_1X1,
                        fields,
                    });
                    const legacyValidRes = await sendMultipartRequest(legacyDefaultBaseUrl, path, {
                        filename: "valid.png",
                        contentType: "image/png",
                        payloadBuffer: VALID_PNG_1X1,
                        fields,
                    });
                    assert.equal(validRes.status, 200, `${path}: valid image must return 200`);
                    assert.equal(validRes.status, legacyValidRes.status);
                    assert.equal(validRes.body?.ok, true);

                    // (b) Spoofed MIME (MP4 bytes declared as image/png) -> 415 UNSUPPORTED_MEDIA_TYPE
                    const spoofRes = await sendMultipartRequest(baseUrl, path, {
                        filename: "spoof.png",
                        contentType: "image/png",
                        payloadBuffer: buildMinimalMp4Buffer(),
                        fields,
                    });
                    const legacySpoofRes = await sendMultipartRequest(legacyDefaultBaseUrl, path, {
                        filename: "spoof.png",
                        contentType: "image/png",
                        payloadBuffer: buildMinimalMp4Buffer(),
                        fields,
                    });
                    assert.equal(spoofRes.status, 415, `${path}: spoofed MIME must return 415`);
                    assert.equal(spoofRes.status, legacySpoofRes.status);
                    assert.equal(spoofRes.body?.code, "UNSUPPORTED_MEDIA_TYPE");
                    assert.equal(spoofRes.body?.code, legacySpoofRes.body?.code);
                    assert.match(
                        spoofRes.body?.message || "",
                        /Unsupported file type: video\/mp4/,
                        `${path} must be wired to CHARACTER_SHEET_UPLOAD_POLICY / CHARACTER_DETAIL_UPLOAD_POLICY`
                    );

                    // (d1) application/octet-stream with real PNG bytes, (d2) application/octet-stream with garbage bytes,
                    // (e) declared image/png with real JPEG bytes
                    await assertDeclaredMimeMismatchAndOctetStreamParity(
                        baseUrl,
                        legacyDefaultBaseUrl,
                        path,
                        fields
                    );
                }

                // (c) Oversized image (> 20MB) on sheet route (/create) and detail route (/:characterId/media) -> 413 PAYLOAD_TOO_LARGE
                const oversizedBuf = buildOversizedPngBuffer();
                for (const path of ["/api/characters/create", `/api/characters/${CHAR_ID}/media`]) {
                    const overRes = await sendMultipartRequest(baseUrl, path, {
                        filename: "huge.png",
                        contentType: "image/png",
                        payloadBuffer: oversizedBuf,
                        fields: { project_id: "proj-1", name: "Hero" },
                    });
                    const legacyOverRes = await sendMultipartRequest(legacyDefaultBaseUrl, path, {
                        filename: "huge.png",
                        contentType: "image/png",
                        payloadBuffer: oversizedBuf,
                        fields: { project_id: "proj-1", name: "Hero" },
                    });
                    assert.equal(overRes.status, 413, `${path}: >20MB image must return 413`);
                    assert.equal(overRes.status, legacyOverRes.status);
                    assert.equal(overRes.body?.code, "PAYLOAD_TOO_LARGE");
                    assert.equal(overRes.body?.code, legacyOverRes.body?.code);
                }
            } finally {
                characterService.createCharacter = origCreateCharacter;
                characterService.addMediaToCharacter = origAddMedia;
                characterService.setCharacterSheetMedia = origSetSheet;
            }
        });
    });
});
}
