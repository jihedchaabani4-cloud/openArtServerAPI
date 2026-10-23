import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
    DEFAULT_UPLOAD_POLICY,
    ELEMENT_REFERENCE_UPLOAD_POLICY,
    ELEMENT_SHEET_UPLOAD_POLICY,
    CHARACTER_SHEET_UPLOAD_POLICY,
    CHARACTER_DETAIL_UPLOAD_POLICY,
} from "../../src/platform/media-ingestion/UploadPolicy.js";
import {
    ValidationError,
    UploadError,
    QuotaError,
} from "../../src/platform/media-ingestion/MediaUploadErrors.js";
import { MediaUploadService } from "../../src/platform/media-ingestion/MediaUploadService.js";
import { SourceReader } from "../../src/platform/media-ingestion/SourceReader.js";
import { SourcePolicy } from "../../src/platform/media-ingestion/SourcePolicy.js";

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
});
