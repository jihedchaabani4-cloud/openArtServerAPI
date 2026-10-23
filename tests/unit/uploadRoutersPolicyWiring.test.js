process.env.NODE_ENV = "test";

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import assetsRouter from "../../routes/assets.js";
import { supabase } from "../../lib/supabase.js";
import { assetUploadService } from "../../src/container.js";
import { createUploadMiddleware } from "../../src/middleware/uploadMiddleware.js";
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

function buildLegacyReferenceApp(purpose, mountPath, routePath) {
    const app = express();
    const legacyUpload = createUploadMiddleware(purpose);
    app.post(`${mountPath}${routePath}`, legacyUpload, (req, res) => {
        res.status(200).json({ ok: true, size: req.file?.size });
    });
    return app;
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

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;

        const legacyDefaultApp = buildLegacyReferenceApp("default", "/api/assets", "/upload");
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

                // (d) Declared application/octet-stream -> 415 UNSUPPORTED_MEDIA_TYPE
                const octetRes = await sendMultipartRequest(baseUrl, "/api/assets/upload", {
                    filename: "raw.bin",
                    contentType: "application/octet-stream",
                    payloadBuffer: VALID_PNG_1X1,
                });
                const legacyOctetRes = await sendMultipartRequest(legacyDefaultBaseUrl, "/api/assets/upload", {
                    filename: "raw.bin",
                    contentType: "application/octet-stream",
                    payloadBuffer: VALID_PNG_1X1,
                });
                assert.equal(octetRes.status, 415);
                assert.equal(octetRes.status, legacyOctetRes.status);
                assert.equal(octetRes.body?.code, "UNSUPPORTED_MEDIA_TYPE");
                assert.equal(octetRes.body?.code, legacyOctetRes.body?.code);
            } finally {
                assetUploadService.uploadAsset = origUploadAsset;
            }
        });
    });
});
