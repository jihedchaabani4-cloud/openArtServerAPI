process.env.NODE_ENV = "test";

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import assetsRouter from "../../routes/assets.js";
import mediaIngestRouter from "../../routes/mediaIngestRoutes.js";
import elementRoutes from "../../routes/elementRoutes.js";
import charactersRouter from "../../routes/characters.js";
import { supabase } from "../../lib/supabase.js";
import { assetUploadService, elementMediaService, characterService, db } from "../../src/container.js";
import {
    createUploadMiddleware,
    resolveMiddlewarePolicy,
} from "../../src/middleware/uploadMiddleware.js";
import {
    CHARACTER_SHEET_UPLOAD_POLICY,
    CHARACTER_DETAIL_UPLOAD_POLICY,
} from "../../src/platform/media-ingestion/UploadPolicy.js";
import {
    rateLimitRedisConnection,
    redisConnection,
    workerRedisConnection,
} from "../../src/queue/redis.js";
import {
    resetActiveUploadsForTest,
    resetInFlightBytesForTest,
} from "../../src/middleware/sizeLimitedStorage.js";

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

async function sendMultipartRequest(baseUrl, path, { filename, contentType, payloadBuffer, fields = {}, token = "test-user-02b" }) {
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
