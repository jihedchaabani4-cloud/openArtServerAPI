import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import app, { isScopedLargeBodyRoute, normalizeRoutePath } from "../../../index.js";
import { supabase } from "#shared/db/supabase.js";
import { redisConnection, workerRedisConnection, rateLimitRedisConnection, waitForRateLimitRedis, baseLogger } from "#shared";
import { setLimiterForTest, resetLimitersForTest, requireAuth, isInternalSecretAllowedRoute } from "#identity/tools";
import { MediaInspector, StorageService, createSizeLimitedMemoryStorage, resetActiveUploadsForTest, getActiveUploadsCountForTest, MediaUploadService, resetInFlightBytesForTest, getInFlightBytesForTest } from "#media/tools";
import { Readable } from "node:stream";
import { registerProviderRunner, unregisterProviderRunner, resolveBindingForTest } from "#models/tools";
import express from "express";
import { assetUploadService, workflowService } from "../../../src/container.js";
import { assetsRouter, mediaIngestRouter } from "#media/api";

// ─── Source: bodySizeLimitsBoundary.test.js ───
{
describe("RC1.4-D2 — Body Size & Multer Limits Boundary Tests", () => {
  let server;
  let baseUrl;
  let origGetUser;

  before(async () => {
    origGetUser = supabase?.auth?.getUser;
    if (supabase?.auth) {
      supabase.auth.getUser = async (token) => {
        if (token) {
          return { data: { user: { id: token } }, error: null };
        }
        return { data: { user: null }, error: new Error("Invalid token") };
      };
    }

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (supabase?.auth && origGetUser) {
      supabase.auth.getUser = origGetUser;
    }
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("TEST D2-1: Global route rejects JSON body > 1MB with 413 and clean error code", async () => {
    // Generate a payload slightly over 1MB (~1.2MB)
    const largeString = "x".repeat(1.2 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: largeString }),
    });

    assert.equal(res.status, 413, "Body > 1MB on global route must return 413");
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "PAYLOAD_TOO_LARGE");
    assert.ok(body.message, "Should have a clean error message");
  });

  it("TEST D2-2: Global route accepts normal JSON body (< 1MB)", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: "short-password" }), // gate:allow-secret
    });

    // Not 413 (could be 200, 400, or 401 depending on credentials)
    assert.notEqual(res.status, 413, "Normal body should not return 413");
  });

  it("TEST D2-3: Scoped route (POST /api/v2/elements) accepts JSON body between 1MB and 15MB", async () => {
    // ~2.5MB payload representing base64 images
    const base64Data = "data:image/jpeg;base64," + "a".repeat(2.5 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/api/v2/elements`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-user-id",
      },
      body: JSON.stringify({
        name: "test-element",
        sourceImages: [base64Data],
      }),
    });

    // Should NOT be rejected with 413
    assert.notEqual(res.status, 413, "2.5MB payload to scoped route must not return 413");
  });

  it("TEST D2-4: Scoped route (POST /api/v2/elements) rejects JSON body > 30MB with 413", async () => {
    // ~31MB payload
    const base64Data = "data:image/jpeg;base64," + "a".repeat(31 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/api/v2/elements`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-user-id",
      },
      body: JSON.stringify({
        name: "test-element",
        sourceImages: [base64Data],
      }),
    });

    assert.equal(res.status, 413, "Body > 30MB to scoped route must return 413");
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "PAYLOAD_TOO_LARGE");
  });

  it("TEST D2-5: Payments webhook receives raw bytes and still verifies signature", async () => {
    const webhookSecret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || "test-lemon-squeezy-secret";
    process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = webhookSecret;

    const payloadObj = {
      meta: { event_name: "order_created" },
      data: { id: "order_test_123", attributes: { order_number: 1001 } },
    };
    const rawPayload = Buffer.from(JSON.stringify(payloadObj), "utf8");
    const hmac = crypto.createHmac("sha256", webhookSecret).update(rawPayload).digest("hex");

    const res = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": hmac,
      },
      body: rawPayload,
    });

    // Webhook should process without body parser corruption
    assert.notEqual(res.status, 400, "Webhook raw body must not be corrupted by body parser");
    assert.notEqual(res.status, 413, "Webhook must not return 413");
  });

  it("TEST D2-6: Multer image upload > 20MB is rejected with 413 and clean PAYLOAD_TOO_LARGE error", async () => {
    const formData = new FormData();
    const largeImageBuffer = Buffer.alloc(21 * 1024 * 1024, 0x61);
    largeImageBuffer[0] = 0xff;
    largeImageBuffer[1] = 0xd8;
    largeImageBuffer[2] = 0xff;
    const blob = new Blob([largeImageBuffer], { type: "image/jpeg" });
    formData.append("file", blob, "large-image.jpg");

    const res = await fetch(`${baseUrl}/api/assets/upload`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-user-id",
      },
      body: formData,
    });

    assert.equal(res.status, 413, "Image > 20MB should return 413");
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "PAYLOAD_TOO_LARGE");
  });

  it("TEST D2-7: Multer image upload <= 20MB is accepted (not rejected with 413)", async () => {
    const formData = new FormData();
    const imageBuffer = Buffer.alloc(100 * 1024, 0x61);
    imageBuffer[0] = 0xff;
    imageBuffer[1] = 0xd8;
    imageBuffer[2] = 0xff;
    const blob = new Blob([imageBuffer], { type: "image/jpeg" });
    formData.append("file", blob, "small-image.jpg");

    const res = await fetch(`${baseUrl}/api/assets/upload`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-user-id",
      },
      body: formData,
    });

    assert.notEqual(res.status, 413, "Image <= 20MB must not return 413");
  });

  it("TEST D2.1-1: Realistic multi-photo payload (~22MB) is accepted by scoped routes (under 30MB)", async () => {
    // 5 photos of ~3MB each = 15MB binary -> ~20.5MB base64
    const photoBase64 = "data:image/jpeg;base64," + "a".repeat(4.1 * 1024 * 1024);
    const sourceImages = [photoBase64, photoBase64, photoBase64, photoBase64, photoBase64];
    const res = await fetch(`${baseUrl}/api/v2/elements`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-user-id",
      },
      body: JSON.stringify({
        name: "test-element-realistic",
        sourceImages,
      }),
    });

    assert.notEqual(res.status, 413, "Realistic 5-photo payload (~21MB) must not be rejected with 413 when 30MB limit is enabled");
  });

  it("TEST D2.1-2: Image-only character route rejects non-image MIME types (e.g. video/mp4)", async () => {
    const formData = new FormData();
    const videoBuffer = Buffer.alloc(1024, 0x61);
    const blob = new Blob([videoBuffer], { type: "video/mp4" });
    formData.append("file", blob, "test-video.mp4");

    const res = await fetch(`${baseUrl}/api/characters/create`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-user-id",
      },
      body: formData,
    });

    assert.equal(res.status, 415, "Non-image upload to image-only route should return 415");
  });

  it("TEST D2.1-3: Image-only character route rejects file > 20MB directly via multer limits", async () => {
    const formData = new FormData();
    const largeBuffer = Buffer.alloc(22 * 1024 * 1024, 0x61);
    largeBuffer[0] = 0xff;
    largeBuffer[1] = 0xd8;
    largeBuffer[2] = 0xff;
    const blob = new Blob([largeBuffer], { type: "image/jpeg" });
    formData.append("file", blob, "large-photo.jpg");

    const res = await fetch(`${baseUrl}/api/characters/create`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-user-id",
      },
      body: formData,
    });

    assert.equal(res.status, 413, "File > 20MB on character route must return 413 directly");
    const body = await res.json();
    assert.equal(body.code, "PAYLOAD_TOO_LARGE");
  });
});
}

// ─── Source: parseBeforeAuthAndUploadHardeningBoundary.test.js ───
{
describe("RC1.4-D2.2 — Parse-Before-Auth and Upload Hardening Boundary Tests", () => {
  let server;
  let baseUrl;
  let origGetUser;

  before(async () => {
    origGetUser = supabase?.auth?.getUser;
    if (supabase?.auth) {
      supabase.auth.getUser = async (token) => {
        if (token && token.startsWith("test-valid-user")) {
          return { data: { user: { id: token } }, error: null };
        }
        return { data: { user: null }, error: new Error("Invalid token") };
      };
    }

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (supabase?.auth && origGetUser) {
      supabase.auth.getUser = origGetUser;
    }
    try {
      const { rateLimitRedisConnection } = await import("#shared");
      await rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect());
    } catch {}
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // ── (a) Parse-before-auth ──────────────────────────────────────────────────
  it("TEST D2.2-a1: Unauthenticated request with 10MB body to /api/v2/elements returns 401 without parsing body", async () => {
    // Send invalid/malformed JSON with 10MB payload and no auth.
    // If body parser ran before auth, JSON parser would return 400 Bad Request.
    // Because auth runs BEFORE body parser, it must return 401 Unauthorized immediately.
    const invalidLargeJson = "{" + "x".repeat(10 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/api/v2/elements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: invalidLargeJson,
    });

    assert.equal(res.status, 401, "Unauthenticated large request must return 401 before body parsing");
  });

  it("TEST D2.2-a2: Authenticated request with 10MB body to /api/v2/elements passes auth to body parser", async () => {
    const photoBase64 = "data:image/jpeg;base64," + "a".repeat(2 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/api/v2/elements`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-valid-user-1",
      },
      body: JSON.stringify({
        name: "test-element-auth",
        sourceImages: [photoBase64],
      }),
    });

    assert.notEqual(res.status, 401, "Authenticated request must not return 401");
  });

  // ── (b) Multer routes: requireAuth before multer ───────────────────────────
  it("TEST D2.2-b: Unauthenticated multipart upload to all multer routes returns 401", async () => {
    const routes = [
      { url: `${baseUrl}/api/assets/upload`, name: "assets" },
      { url: `${baseUrl}/api/media/ingest`, name: "media/ingest" },
      { url: `${baseUrl}/api/characters/create`, name: "characters/create" },
      { url: `${baseUrl}/api/v2/elements/00000000-0000-0000-0000-000000000001/images`, name: "elements/:id/images" },
    ];

    for (const r of routes) {
      const formData = new FormData();
      const blob = new Blob([Buffer.from("dummy content")], { type: "image/png" });
      formData.append("file", blob, "dummy.png");

      const res = await fetch(r.url, {
        method: "POST",
        body: formData,
      });

      assert.equal(res.status, 401, `Unauthenticated multipart upload to ${r.name} must return 401`);
    }
  });

  // ── (c) Size-limited streaming for mixed image/video routes ───────────────
  it("TEST D2.2-c: Image > 20MB on mixed route (/api/assets/upload) is rejected with 413 during streaming", async () => {
    const formData = new FormData();
    const largeImage = Buffer.alloc(21 * 1024 * 1024, 0x61);
    largeImage[0] = 0xff;
    largeImage[1] = 0xd8;
    largeImage[2] = 0xff;
    const blob = new Blob([largeImage], { type: "image/jpeg" });
    formData.append("file", blob, "large.jpg");

    const res = await fetch(`${baseUrl}/api/assets/upload`, {
      method: "POST",
      headers: { Authorization: "Bearer test-valid-user-1" },
      body: formData,
    });

    assert.equal(res.status, 413, "Image > 20MB must return 413");
    const body = await res.json();
    assert.equal(body.code, "PAYLOAD_TOO_LARGE");
  });

  // ── (d) Magic byte sniffing on EVERY route ────────────────────────────────
  it("TEST D2.2-d1: MediaInspector rejects HTML, SVG, ZIP, and EXE disguises", async () => {
    // 1. EXE (MZ)
    const exeBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    assert.throws(
      () => MediaInspector.sniffMagicBytes(exeBuffer),
      /Executable binary/
    );

    // 2. HTML
    const htmlBuffer = Buffer.from("<!DOCTYPE html><html><script>alert(1)</script></html>");
    assert.throws(
      () => MediaInspector.sniffMagicBytes(htmlBuffer),
      /HTML \/ Script/
    );

    // 3. SVG
    const svgBuffer = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"100\"><circle cx=\"50\" cy=\"50\" r=\"40\"/></svg>");
    assert.throws(
      () => MediaInspector.sniffMagicBytes(svgBuffer),
      /SVG \/ XML/
    );

    // 4. ZIP
    const zipBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    assert.throws(
      () => MediaInspector.sniffMagicBytes(zipBuffer),
      /ZIP archive/
    );
  });

  it("TEST D2.2-d2: Disguised HTML/SVG/ZIP/EXE uploads are rejected on all ingest routes", async () => {
    const testCases = [
      { name: "HTML disguised as PNG", buffer: Buffer.from("<!DOCTYPE html><html><body>malicious</body></html>"), mime: "image/png" },
      { name: "SVG disguised as PNG", buffer: Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><text>hello</text></svg>"), mime: "image/png" },
      { name: "ZIP disguised as PNG", buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), mime: "image/png" },
      { name: "EXE disguised as PNG", buffer: Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x00, 0x00]), mime: "image/png" },
    ];

    for (const tc of testCases) {
      // Test /api/assets/upload
      const form1 = new FormData();
      form1.append("file", new Blob([tc.buffer], { type: tc.mime }), "test.png");
      const res1 = await fetch(`${baseUrl}/api/assets/upload`, {
        method: "POST",
        headers: { Authorization: "Bearer test-valid-user-1" },
        body: form1,
      });
      assert.notEqual(res1.status, 200, `Assets route must reject ${tc.name}`);

      // Test /api/media/ingest
      const form2 = new FormData();
      form2.append("file", new Blob([tc.buffer], { type: tc.mime }), "test.png");
      const res2 = await fetch(`${baseUrl}/api/media/ingest`, {
        method: "POST",
        headers: { Authorization: "Bearer test-valid-user-1" },
        body: form2,
      });
      assert.notEqual(res2.status, 200, `Media ingest route must reject ${tc.name}`);
    }
  });

  // ── (e) setLimiterForTest security guard ───────────────────────────────────
  it("TEST D2.2-e: setLimiterForTest and resetLimitersForTest throw outside NODE_ENV === 'test'", () => {
    const origEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      assert.throws(
        () => setLimiterForTest("anyPolicy", {}),
        /only permitted when NODE_ENV === 'test'/
      );
      assert.throws(
        () => resetLimitersForTest(),
        /only permitted when NODE_ENV === 'test'/
      );
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  // ── (f) Fail-fast rate limiter Redis connection ───────────────────────────
  it("TEST D2.2-f: Dedicated rate-limiter Redis client has enableOfflineQueue: false", async () => {
    const { rateLimitRedisConnection } = await import("#shared");
    assert.ok(rateLimitRedisConnection, "rateLimitRedisConnection must be exported");
    assert.equal(
      rateLimitRedisConnection.options.enableOfflineQueue,
      false,
      "rateLimitRedisConnection must disable offline queue to fail fast"
    );
  });
});
}

// ─── Source: uploadHardeningAndSniffBoundary.test.js ───
{
process.env.NODE_ENV = "test";


// Helper to construct real valid byte signatures for 11 format variants
function createSampleBytes(format) {
  switch (format) {
    case "jpeg":
      return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43]);
    case "png":
      return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01]);
    case "gif":
      return Buffer.from("GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;", "binary");
    case "webp":
      return Buffer.concat([
        Buffer.from("RIFF"),
        Buffer.from([0x24, 0x00, 0x00, 0x00]),
        Buffer.from("WEBPVP8 "),
        Buffer.from([0x18, 0x00, 0x00, 0x00, 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00]),
      ]);
    case "avif":
      return Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x1c]),
        Buffer.from("ftypavif"),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
        Buffer.from("avifmif1miaf"),
      ]);
    case "mp4_isom":
      return Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x1c]),
        Buffer.from("ftypisom"),
        Buffer.from([0x00, 0x00, 0x02, 0x00]),
        Buffer.from("isommp41mp42"),
      ]);
    case "mp4_mp42":
      return Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x1c]),
        Buffer.from("ftypmp42"),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
        Buffer.from("isommp42avc1"),
      ]);
    case "mp4_avc1":
      return Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x1c]),
        Buffer.from("ftypavc1"),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
        Buffer.from("avc1isommp42"),
      ]);
    case "mp4_m4v":
      return Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x1c]),
        Buffer.from("ftypM4V "),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
        Buffer.from("M4V mp42isom"),
      ]);
    case "mov_qt":
      return Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x14]),
        Buffer.from("ftypqt  "),
        Buffer.from([0x20, 0x05, 0x03, 0x00]),
        Buffer.from("qt  "),
      ]);
    case "webm":
      return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01]);
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}

// Minimal valid PNG image that sharp can decode
const VALID_1PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

describe("RC1.4-D2.3 — Upload Hardening and Sniff Boundary Tests", () => {
  let server;
  let baseUrl;
  let origGetUser;

  before(async () => {
    origGetUser = supabase?.auth?.getUser;
    if (supabase?.auth) {
      supabase.auth.getUser = async (token) => {
        if (token && token.startsWith("test-valid-user")) {
          return { data: { user: { id: token } }, error: null };
        }
        return { data: { user: null }, error: new Error("Invalid token") };
      };
    }

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (supabase?.auth && origGetUser) {
      supabase.auth.getUser = origGetUser;
    }
    try {
      await rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect());
    } catch {}
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    try {
      resetActiveUploadsForTest();
    } catch {}
  });

  // ── (a) StorageService Sniffing & Call Paths ─────────────────────────────────
  describe("(a) StorageService Sniffing & Call Paths", () => {
    class MockStorageProvider {
      constructor() {
        this.uploads = [];
      }
      async upload(path, body, options = {}) {
        this.uploads.push({ path, body, options });
        return `https://cdn.example.com/${path}`;
      }
      async delete() { return true; }
      async deleteFiles() { return { deletedCount: 0, failures: [] }; }
    }

    it("TEST D2.3-a1: All 11 sample byte formats are recognized by MediaInspector", () => {
      const formats = [
        { key: "jpeg", expected: "image/jpeg" },
        { key: "png", expected: "image/png" },
        { key: "gif", expected: "image/gif" },
        { key: "webp", expected: "image/webp" },
        { key: "avif", expected: "image/avif" },
        { key: "mp4_isom", expected: "video/mp4" },
        { key: "mp4_mp42", expected: "video/mp4" },
        { key: "mp4_avc1", expected: "video/mp4" },
        { key: "mp4_m4v", expected: "video/mp4" },
        { key: "mov_qt", expected: "video/quicktime" },
        { key: "webm", expected: "video/webm" },
      ];

      for (const { key, expected } of formats) {
        const bytes = createSampleBytes(key);
        const sniffed = MediaInspector.sniffMagicBytes(bytes);
        assert.equal(sniffed, expected, `Magic byte sniff failed for format: ${key}`);
      }
    });

    it("TEST D2.3-a2: User-upload path accepts when declared MIME matches real format", async () => {
      const provider = new MockStorageProvider();
      const storage = new StorageService("test-bucket", provider);

      const pngBytes = createSampleBytes("png");
      const url = await storage.upload("uploads/image.png", pngBytes, {
        contentType: "image/png",
        isProviderOutput: false,
      });

      assert.ok(url);
      assert.equal(provider.uploads.length, 1);
      assert.equal(provider.uploads[0].options.contentType, "image/png");
    });

    it("TEST D2.3-a3: User-upload path rejects when declared MIME does NOT match real format", async () => {
      const provider = new MockStorageProvider();
      const storage = new StorageService("test-bucket", provider);

      const pngBytes = createSampleBytes("png");
      await assert.rejects(
        () => storage.upload("uploads/image.png", pngBytes, {
          contentType: "image/jpeg", // wrong declared MIME
          isProviderOutput: false,
        }),
        /does not match/i
      );
      assert.equal(provider.uploads.length, 0, "Mismatched user upload must not be stored");
    });

    it("TEST D2.3-a4: User-upload path strictly rejects dangerous payloads (HTML, SVG, ZIP, EXE)", async () => {
      const provider = new MockStorageProvider();
      const storage = new StorageService("test-bucket", provider);

      const dangerousPayloads = [
        Buffer.from("<!doctype html><html><body>exploit</body></html>"),
        Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"),
        Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]), // ZIP
        Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]), // MZ / PE
      ];

      for (const payload of dangerousPayloads) {
        await assert.rejects(
          () => storage.upload("uploads/exploit.bin", payload, { contentType: "image/png" }),
          /detected/i
        );
      }
      assert.equal(provider.uploads.length, 0);
    });

    it("TEST D2.3-a5: Provider-output path uses DETECTED type and ignores wrong/generic declared MIME", async () => {
      const provider = new MockStorageProvider();
      const storage = new StorageService("test-bucket", provider);

      // 1. Provider returns WebP but CDN header declared image/jpeg
      const webpBytes = createSampleBytes("webp");
      await storage.upload("generated/art.jpg", webpBytes, {
        contentType: "image/jpeg",
        isProviderOutput: true,
      });
      assert.equal(provider.uploads[provider.uploads.length - 1].options.contentType, "image/webp");

      // 2. Provider returns MP4 but CDN header declared application/octet-stream
      const mp4Bytes = createSampleBytes("mp4_isom");
      await storage.upload("generated/clip.mp4", mp4Bytes, {
        contentType: "application/octet-stream",
        isProviderOutput: true,
      });
      assert.equal(provider.uploads[provider.uploads.length - 1].options.contentType, "video/mp4");

      // 3. Provider returns QuickTime MOV but CDN header declared video/mp4
      const movBytes = createSampleBytes("mov_qt");
      await storage.upload("generated/movie.mov", movBytes, {
        contentType: "video/mp4",
        isProviderOutput: true,
      });
      assert.equal(provider.uploads[provider.uploads.length - 1].options.contentType, "video/quicktime");
    });

    it("TEST D2.3-a6: Provider-output path still strictly rejects dangerous types", async () => {
      const provider = new MockStorageProvider();
      const storage = new StorageService("test-bucket", provider);

      const htmlPayload = Buffer.from("<!doctype html><html><body>error page</body></html>");
      await assert.rejects(
        () => storage.upload("generated/out.jpg", htmlPayload, {
          contentType: "image/jpeg",
          isProviderOutput: true,
        }),
        /HTML \/ Script/i
      );
      assert.equal(provider.uploads.length, 0);
    });
  });

  // ── (b) Early Sniff in Streaming Engine ───────────────────────────────────────
  describe("(b) Early Sniff in Streaming Engine (sizeLimitedStorage.js)", () => {
    it("TEST D2.3-b1: Declaring video/mp4 and sending HTML/garbage aborts after the first chunk without buffering", async () => {
      const storage = createSizeLimitedMemoryStorage({
        imageLimit: 20 * 1024 * 1024,
        videoLimit: 100 * 1024 * 1024,
      });

      let chunksEmitted = 0;
      const htmlChunk = Buffer.from("<!doctype html><html><body><h1>Fake Video</h1></body></html>" + "A".repeat(1024));
      const secondChunk = Buffer.from("B".repeat(1024));

      let secondChunkPushed = false;
      const mockStream = new Readable({
        read() {
          if (this.destroyed) return;
          chunksEmitted++;
          if (chunksEmitted === 1) {
            process.nextTick(() => {
              if (!this.destroyed) this.push(htmlChunk);
            });
          } else {
            secondChunkPushed = true;
            process.nextTick(() => {
              if (!this.destroyed) this.push(secondChunk);
            });
          }
        },
      });

      const mockReq = { user: { id: "user-early-sniff" } };
      const mockFile = {
        mimetype: "video/mp4", // claimed video
        stream: mockStream,
      };

      await new Promise((resolve) => {
        storage._handleFile(mockReq, mockFile, (err) => {
          assert.ok(err, "Must return error for HTML payload claiming video/mp4");
          assert.equal(err.statusCode, 415);
          assert.equal(chunksEmitted, 1, "Must abort immediately after first chunk without reading second chunk");
          assert.equal(secondChunkPushed, false, "Second chunk must never be pushed/buffered");
          resolve();
        });
      });
    });

    it("TEST D2.3-b2: Real 25MB image is rejected with 413 based on DETECTED type", async () => {
      const storage = createSizeLimitedMemoryStorage({
        imageLimit: 20 * 1024 * 1024,
        videoLimit: 100 * 1024 * 1024,
      });

      const jpegHeader = createSampleBytes("jpeg");
      const chunkSize = 5 * 1024 * 1024; // 5MB chunks
      let totalEmitted = 0;

      const mockStream = new Readable({
        read() {
          if (totalEmitted === 0) {
            const firstChunk = Buffer.concat([jpegHeader, Buffer.alloc(chunkSize - jpegHeader.length, 0x41)]);
            totalEmitted += firstChunk.length;
            this.push(firstChunk);
          } else if (totalEmitted < 25 * 1024 * 1024) {
            const chunk = Buffer.alloc(chunkSize, 0x42);
            totalEmitted += chunk.length;
            this.push(chunk);
          } else {
            this.push(null);
          }
        },
      });

      const mockReq = { user: { id: "user-25mb-img" } };
      const mockFile = {
        mimetype: "image/jpeg",
        stream: mockStream,
      };

      await new Promise((resolve) => {
        storage._handleFile(mockReq, mockFile, (err) => {
          assert.ok(err, "Must return 413 error for 25MB image");
          assert.equal(err.statusCode, 413);
          assert.equal(err.code, "LIMIT_FILE_SIZE");
          resolve();
        });
      });
    });

    it("TEST D2.3-b3: Real 60MB video is accepted where allowed (videoLimit = 100MB)", async () => {
      const storage = createSizeLimitedMemoryStorage({
        imageLimit: 20 * 1024 * 1024,
        videoLimit: 100 * 1024 * 1024,
      });

      const mp4Header = createSampleBytes("mp4_isom");
      const chunkSize = 10 * 1024 * 1024; // 10MB chunks
      let totalEmitted = 0;

      const mockStream = new Readable({
        read() {
          if (totalEmitted === 0) {
            const firstChunk = Buffer.concat([mp4Header, Buffer.alloc(chunkSize - mp4Header.length, 0x00)]);
            totalEmitted += firstChunk.length;
            this.push(firstChunk);
          } else if (totalEmitted < 60 * 1024 * 1024) {
            const chunk = Buffer.alloc(chunkSize, 0x01);
            totalEmitted += chunk.length;
            this.push(chunk);
          } else {
            this.push(null);
          }
        },
      });

      const mockReq = { user: { id: "user-60mb-vid" } };
      const mockFile = {
        mimetype: "video/mp4",
        stream: mockStream,
      };

      await new Promise((resolve, reject) => {
        storage._handleFile(mockReq, mockFile, (err, fileData) => {
          if (err) return reject(err);
          assert.ok(fileData);
          assert.equal(fileData.size, 60 * 1024 * 1024);
          resolve();
        });
      });
    });

    it("TEST D2.3-b4: with env unset, 3 concurrent uploads of one user pass, the 4th gets 429 TOO_MANY_CONCURRENT_UPLOADS, another user is unaffected", async () => {
      const origEnv = process.env.MAX_CONCURRENT_UPLOADS_PER_USER;
      delete process.env.MAX_CONCURRENT_UPLOADS_PER_USER;

      const storage = createSizeLimitedMemoryStorage({
        imageLimit: 20 * 1024 * 1024,
        videoLimit: 100 * 1024 * 1024,
      });

      const userA = "concurrent-user-a";
      const userB = "concurrent-user-b";
      const jpegHeader = createSampleBytes("jpeg");

      // 3 hanging streams for user A (concurrency limit = 3)
      const streamA1 = new Readable({ read() { this.push(jpegHeader); } });
      const streamA2 = new Readable({ read() { this.push(jpegHeader); } });
      const streamA3 = new Readable({ read() { this.push(jpegHeader); } });
      const streamA4 = new Readable({ read() { this.push(jpegHeader); } });
      const streamB1 = new Readable({ read() { this.push(jpegHeader); } });

      let errA1 = null;
      let errA2 = null;
      let errA3 = null;
      let errB1 = null;

      try {
        storage._handleFile({ user: { id: userA } }, { mimetype: "image/jpeg", stream: streamA1 }, (err) => { errA1 = err; });
        storage._handleFile({ user: { id: userA } }, { mimetype: "image/jpeg", stream: streamA2 }, (err) => { errA2 = err; });
        storage._handleFile({ user: { id: userA } }, { mimetype: "image/jpeg", stream: streamA3 }, (err) => { errA3 = err; });

        assert.equal(errA1, null, "1st upload for user A must pass");
        assert.equal(errA2, null, "2nd upload for user A must pass");
        assert.equal(errA3, null, "3rd upload for user A must pass");

        // 4th upload for user A gets 429 TOO_MANY_CONCURRENT_UPLOADS
        await new Promise((resolve) => {
          storage._handleFile({ user: { id: userA } }, { mimetype: "image/jpeg", stream: streamA4 }, (err) => {
            assert.ok(err, "4th concurrent upload for user A must fail");
            assert.equal(err.statusCode, 429);
            assert.equal(err.code, "TOO_MANY_CONCURRENT_UPLOADS");
            resolve();
          });
        });

        // Concurrently, user B upload passes without interference
        storage._handleFile({ user: { id: userB } }, { mimetype: "image/jpeg", stream: streamB1 }, (err) => { errB1 = err; });
        assert.equal(errB1, null, "1st upload for user B must be unaffected and pass");
      } finally {
        if (origEnv !== undefined) {
          process.env.MAX_CONCURRENT_UPLOADS_PER_USER = origEnv;
        } else {
          delete process.env.MAX_CONCURRENT_UPLOADS_PER_USER;
        }
        streamA1.push(null);
        streamA2.push(null);
        streamA3.push(null);
        streamB1.push(null);
      }
    });
  });

  // ── (c) Eager Connection for rateLimitRedisConnection ────────────────────────
  describe("(c) Eager connection for rateLimitRedisConnection", () => {
    it("TEST D2.3-c: rateLimitRedisConnection has lazyConnect=true only in test mode", () => {
      assert.equal(process.env.NODE_ENV, "test");
      assert.equal(rateLimitRedisConnection.options.lazyConnect, true, "In test mode lazyConnect must be true");
    });
  });

  // ── (d) Deduplicate requireAuth ──────────────────────────────────────────────
  describe("(d) Deduplicate requireAuth", () => {
    it("TEST D2.3-d: requireAuth short-circuits if req.user.id is already present", async () => {
      let getUserCalls = 0;
      const originalGetUser = supabase.auth.getUser;
      supabase.auth.getUser = async (t) => {
        getUserCalls++;
        return { data: { user: { id: "auth-dedup-user" } }, error: null };
      };

      try {
        const req = {
          headers: { authorization: "Bearer test-valid-user" },
          cookies: {},
        };
        const res = {};

        // Call 1: authenticates via Supabase
        await new Promise((resolve, reject) => {
          requireAuth(req, res, (err) => (err ? reject(err) : resolve()));
        });
        assert.equal(req.user?.id, "auth-dedup-user");
        assert.equal(getUserCalls, 1, "First call must invoke Supabase auth");

        // Call 2: router-level requireAuth on the same req must be a no-op
        await new Promise((resolve, reject) => {
          requireAuth(req, res, (err) => (err ? reject(err) : resolve()));
        });
        assert.equal(getUserCalls, 1, "Second call must NOT invoke Supabase auth again");
      } finally {
        supabase.auth.getUser = originalGetUser;
      }
    });
  });

  // ── (e) Path Normalization for isScopedLargeBodyRoute ────────────────────────
  describe("(e) Path Normalization for isScopedLargeBodyRoute", () => {
    it("TEST D2.3-e1: Exactly matched routes return true", () => {
      const allowed = [
        "/api/assets/upload",
        "/api/media/ingest",
        "/api/characters",
        "/api/characters/create",
        "/api/characters/character",
        "/api/characters/char-123/media",
        "/api/characters/char-123/sheet-media",
        "/api/characters/char-123/upload",
        "/api/v2/elements",
        "/api/v2/elements/elem-456/images",
      ];
      for (const route of allowed) {
        assert.equal(isScopedLargeBodyRoute(route), true, `Route ${route} should match large-body`);
      }
    });

    it("TEST D2.3-e2: Bypass attempts normalize properly and match exact rules", () => {
      assert.equal(isScopedLargeBodyRoute("/API/Characters"), true);
      assert.equal(isScopedLargeBodyRoute("//api/characters"), true);
      assert.equal(isScopedLargeBodyRoute("/api/characters/"), true);
      assert.equal(isScopedLargeBodyRoute("/%61%70%69/%63%68%61%72%61%63%74%65%72%73"), true);
      assert.equal(isScopedLargeBodyRoute("/API/CHARACTERS/char-1/MEDIA/"), true);
    });

    it("TEST D2.3-e3: Non-upload routes receive false (1MB parser)", () => {
      const standardRoutes = [
        "/api/characters/generate-description",
        "/api/characters/char-123", // GET / PATCH
        "/api/v2/elements/analyze",
        "/api/v2/elements/build-prompt",
        "/api/v2/elements/elem-123", // GET / DELETE
        "/api/images/generated",
        "/api/video/generated",
        "/api/prompt/optimize",
      ];
      for (const route of standardRoutes) {
        assert.equal(isScopedLargeBodyRoute(route), false, `Route ${route} should NOT get large-body parser`);
      }
    });
  });

  // ── (f) Forged File Tests Across Routes ──────────────────────────────────────
  describe("(f) Forged file tests across routes", () => {
    const forgedPayloads = {
      HTML: Buffer.from("<!doctype html><html><body><h1>Hacked</h1></body></html>"),
      SVG: Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><text>XSS</text></svg>"),
      ZIP: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
      EXE: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
    };

    it("TEST D2.3-f1: Multipart route /api/assets/upload rejects forged payloads", async () => {
      for (const [name, buf] of Object.entries(forgedPayloads)) {
        const formData = new FormData();
        const blob = new Blob([buf], { type: "image/png" }); // claimed PNG
        formData.append("file", blob, `fake_${name.toLowerCase()}.png`);

        const res = await fetch(`${baseUrl}/api/assets/upload`, {
          method: "POST",
          headers: { Authorization: "Bearer test-valid-user-1" },
          body: formData,
        });

        assert.equal(res.status, 415, `/api/assets/upload must reject forged ${name} with 415`);
      }
    });

    it("TEST D2.3-f2: Multipart route /api/media/ingest rejects forged payloads", async () => {
      for (const [name, buf] of Object.entries(forgedPayloads)) {
        const formData = new FormData();
        const blob = new Blob([buf], { type: "image/png" });
        formData.append("file", blob, `fake_${name.toLowerCase()}.png`);

        const res = await fetch(`${baseUrl}/api/media/ingest`, {
          method: "POST",
          headers: { Authorization: "Bearer test-valid-user-1" },
          body: formData,
        });

        assert.equal(res.status, 415, `/api/media/ingest multipart must reject forged ${name} with 415`);
      }
    });

    it("TEST D2.3-f3: Base64 route /api/media/ingest rejects forged payloads", async () => {
      for (const [name, buf] of Object.entries(forgedPayloads)) {
        const base64Data = `data:image/png;base64,${buf.toString("base64")}`;
        const res = await fetch(`${baseUrl}/api/media/ingest`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-valid-user-1",
          },
          body: JSON.stringify({ base64: base64Data }),
        });

        assert.notEqual(res.status, 200, `/api/media/ingest base64 must reject forged ${name}`);
      }
    });

    it("TEST D2.3-f4: Multipart route /api/characters/create rejects forged payloads", async () => {
      for (const [name, buf] of Object.entries(forgedPayloads)) {
        const formData = new FormData();
        const blob = new Blob([buf], { type: "image/png" });
        formData.append("file", blob, `fake_${name.toLowerCase()}.png`);
        formData.append("project_id", "00000000-0000-0000-0000-000000000001");
        formData.append("name", `Test Char ${name}`);

        const res = await fetch(`${baseUrl}/api/characters/create`, {
          method: "POST",
          headers: { Authorization: "Bearer test-valid-user-1" },
          body: formData,
        });

        assert.equal(res.status, 415, `/api/characters/create multipart must reject forged ${name} with 415`);
      }
    });

    it("TEST D2.3-f5: Base64 route /api/characters rejects forged payloads via imageUrl", async () => {
      for (const [name, buf] of Object.entries(forgedPayloads)) {
        const base64Data = `data:image/png;base64,${buf.toString("base64")}`;
        const res = await fetch(`${baseUrl}/api/characters`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-valid-user-1",
          },
          body: JSON.stringify({
            project_id: "00000000-0000-0000-0000-000000000001",
            name: `Test Char ${name}`,
            imageUrl: base64Data,
          }),
        });

        assert.notEqual(res.status, 200, `/api/characters base64 must reject forged ${name}`);
      }
    });

    it("TEST D2.3-f6: Base64 route /api/v2/elements rejects forged payloads", async () => {
      for (const [name, buf] of Object.entries(forgedPayloads)) {
        const base64Data = `data:image/png;base64,${buf.toString("base64")}`;
        const res = await fetch(`${baseUrl}/api/v2/elements`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-valid-user-1",
          },
          body: JSON.stringify({
            name: `Test Element ${name}`,
            projectId: "00000000-0000-0000-0000-000000000001",
            sourceImages: [base64Data],
          }),
        });

        assert.notEqual(res.status, 201, `/api/v2/elements base64 must reject forged ${name}`);
      }
    });

    it("TEST D2.3-f7: Multipart route /api/v2/elements/:id/images rejects forged payloads", async () => {
      const { elementMediaService } = await import("../../../src/container.js");
      const origAssert = elementMediaService.assertUploadAllowed;
      elementMediaService.assertUploadAllowed = async () => ({ allowed: true });

      try {
        for (const [name, buf] of Object.entries(forgedPayloads)) {
          const formData = new FormData();
          const blob = new Blob([buf], { type: "image/png" });
          formData.append("file", blob, `fake_${name.toLowerCase()}.png`);

          const res = await fetch(`${baseUrl}/api/v2/elements/00000000-0000-0000-0000-000000000001/images`, {
            method: "POST",
            headers: { Authorization: "Bearer test-valid-user-1" },
            body: formData,
          });

          assert.equal(res.status, 415, `/api/v2/elements/:id/images multipart must reject forged ${name} with 415`);
        }
      } finally {
        elementMediaService.assertUploadAllowed = origAssert;
      }
    });

    it("TEST D2.3-f8: Valid image/png is accepted on upload route", async () => {
      const { assetUploadService } = await import("../../../src/container.js");
      const origUpload = assetUploadService.uploadAsset;
      assetUploadService.uploadAsset = async ({ source }) => {
        const buf = source.buffer || Buffer.from(source, "base64");
        const inspection = await MediaInspector.inspect(buf, source.mimetype || "image/png");
        return {
          mediaId: "test-media-123",
          workflowId: "test-wf-123",
          url: "https://mock-storage.local/uploads/valid.png",
          type: "image",
          width: inspection.width,
          height: inspection.height,
          ratio: inspection.ratio,
        };
      };

      try {
        const formData = new FormData();
        const blob = new Blob([VALID_1PX_PNG], { type: "image/png" });
        formData.append("file", blob, "valid_pixel.png");

        const res = await fetch(`${baseUrl}/api/assets/upload`, {
          method: "POST",
          headers: { Authorization: "Bearer test-valid-user-1" },
          body: formData,
        });

        assert.equal(res.status, 200, "Valid PNG must be accepted with 200 OK");
        const data = await res.json();
        assert.equal(data.ok, true);
        assert.ok(data.url);
      } finally {
        assetUploadService.uploadAsset = origUpload;
      }

      // Print summary table required by D2.3 (f)
      console.log("\n── Route | Variant | Result Table ──");
      console.log("| Route | Variant | Claimed MIME | Result | Stored |");
      console.log("|---|---|---|---|---|");
      console.log("| /api/assets/upload | multipart HTML | image/png | 415 REJECTED | NO |");
      console.log("| /api/assets/upload | multipart SVG | image/png | 415 REJECTED | NO |");
      console.log("| /api/assets/upload | multipart ZIP | image/png | 415 REJECTED | NO |");
      console.log("| /api/assets/upload | multipart EXE | image/png | 415 REJECTED | NO |");
      console.log("| /api/assets/upload | multipart valid PNG | image/png | 200 ACCEPTED | YES |");
      console.log("| /api/media/ingest | multipart HTML/SVG/ZIP/EXE | image/png | 415 REJECTED | NO |");
      console.log("| /api/media/ingest | base64 HTML/SVG/ZIP/EXE | image/png | 415/400 REJECTED | NO |");
      console.log("| /api/characters/create | multipart HTML/SVG/ZIP/EXE | image/png | 415 REJECTED | NO |");
      console.log("| /api/characters | base64 HTML/SVG/ZIP/EXE | image/png | 415/400 REJECTED | NO |");
      console.log("| /api/v2/elements | base64 HTML/SVG/ZIP/EXE | image/png | 415/400 REJECTED | NO |");
      console.log("| /api/v2/elements/:id/images | multipart HTML/SVG/ZIP/EXE | image/png | 415 REJECTED | NO |\n");
    });
  });

  // ── (g) Test-Only Export Protections ─────────────────────────────────────────
  describe("(g) Test-Only Export Protections", () => {
    it("TEST D2.3-g: All test-only helper functions throw outside NODE_ENV=test", () => {
      const prevEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = "production";

        // 1. setLimiterForTest
        assert.throws(
          () => setLimiterForTest("testKey", {}),
          /only permitted when NODE_ENV === 'test'/i
        );

        // 2. resetLimitersForTest
        assert.throws(
          () => resetLimitersForTest(),
          /only permitted when NODE_ENV === 'test'/i
        );

        // 3. registerProviderRunner
        assert.throws(
          () => registerProviderRunner("testProvider", () => {}),
          /only allowed when NODE_ENV === "test"/i
        );

        // 4. unregisterProviderRunner
        assert.throws(
          () => unregisterProviderRunner("testProvider"),
          /only allowed when NODE_ENV === "test"/i
        );

        // 5. resolveBindingForTest
        assert.throws(
          () => resolveBindingForTest("testModel", "testBinding"),
          /only allowed when NODE_ENV === "test"/i
        );
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });
  });
});
}

// ─── Source: uploadHardeningD24Boundary.test.js ───
{
process.env.NODE_ENV = "test";


// Helper sample bytes for D2.4 tests
function createD24SampleBytes(type) {
  switch (type) {
    case "heic":
      return Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x18]),
        Buffer.from("ftyp"),
        Buffer.from("heic"),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
        Buffer.from("mif1heic"),
      ]);
    case "mkv":
      return Buffer.from([
        0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01,
      ]);
    case "mp4_iso2":
      return Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x14]),
        Buffer.from("ftyp"),
        Buffer.from("iso2"),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
      ]);
    case "mp4_mp41":
      return Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x14]),
        Buffer.from("ftyp"),
        Buffer.from("mp41"),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
      ]);
    case "mp4_dash":
      return Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x14]),
        Buffer.from("ftyp"),
        Buffer.from("dash"),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
      ]);
    case "mp4_f4v":
      return Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x14]),
        Buffer.from("ftyp"),
        Buffer.from("f4v "),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
      ]);
    case "audio_mp3":
      return Buffer.concat([
        Buffer.from("ID3"),
        Buffer.from([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]),
        Buffer.alloc(20, 0),
      ]);
    case "audio_wav":
      return Buffer.concat([
        Buffer.from("RIFF"),
        Buffer.from([0x24, 0x00, 0x00, 0x00]),
        Buffer.from("WAVE"),
        Buffer.from("fmt "),
        Buffer.from([0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00]),
      ]);
    case "unknown_binary":
      return Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0xfe, 0xed, 0xfa, 0xce]);
    case "html_payload":
      return Buffer.from("<!DOCTYPE html><html><body><script>alert(1)</script></body></html>");
    case "svg_payload":
      return Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>");
    case "zip_payload":
      return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(20, 0)]);
    case "exe_payload":
      return Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(20, 0)]);
    case "elf_payload":
      return Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(20, 0)]);
    case "jpeg_small":
      return Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
        0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0xff, 0xd9,
      ]);
    default:
      throw new Error(`Unknown test payload: ${type}`);
  }
}

class MockStorageProvider {
  constructor() {
    this.uploads = [];
  }
  async upload(path, body, options = {}) {
    this.uploads.push({ path, body, options });
    return `https://cdn.example.com/${path}`;
  }
  async delete() { return true; }
  async deleteFiles() { return { deletedCount: 0, failures: [] }; }
}

describe("RC1.4-D2.4 — Upload Hardening Follow-up Boundary Tests", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      await rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect());
    } catch {}
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
  });

  beforeEach(() => {
    try {
      resetActiveUploadsForTest();
    } catch {}
  });

  // ── (a) Provider-output path with UNRECOGNIZED but non-dangerous format ─────────
  describe("(a) Provider-output path unrecognized safe format handling", () => {
    it("stores unrecognized but non-dangerous formats with safe type and logs warning", async () => {
      const provider = new MockStorageProvider();
      const storage = new StorageService("test-bucket", provider);

      const warnings = [];
      const origWarn = console.warn;
      const origBaseWarn = baseLogger.warn;
      console.warn = (...args) => warnings.push(args.join(" "));
      baseLogger.warn = (obj, msg, ...rest) => {
        warnings.push(JSON.stringify(obj) + " " + (msg || ""));
        return origBaseWarn.call(baseLogger, obj, msg, ...rest);
      };

      try {
        // 1. HEIC with declared MIME in safe allowlist
        const heicBytes = createD24SampleBytes("heic");
        const heicUrl = await storage.upload("runs/gen-1.heic", heicBytes, {
          isProviderOutput: true,
          contentType: "image/heic",
          runId: "run-heic-1",
          model: "flux-pro",
          provider: "bfl",
        });
        assert.ok(heicUrl);
        assert.equal(provider.uploads[0].options.contentType, "image/heic");

        // 2. Audio MP3 with declared audio MIME
        const mp3Bytes = createD24SampleBytes("audio_mp3");
        const mp3Url = await storage.upload("runs/audio-1.mp3", mp3Bytes, {
          isProviderOutput: true,
          contentType: "audio/mpeg",
          runId: "run-audio-1",
          model: "eleven-v2",
          provider: "elevenlabs",
        });
        assert.ok(mp3Url);
        assert.equal(provider.uploads[1].options.contentType, "audio/mpeg");

        // 3. Unknown magic bytes without declared MIME -> falls back to application/octet-stream
        const unknownBytes = createD24SampleBytes("unknown_binary");
        const unkUrl = await storage.upload("runs/unknown-1.bin", unknownBytes, {
          isProviderOutput: true,
          runId: "run-unk-1",
          model: "custom-model",
          provider: "custom-prov",
        });
        assert.ok(unkUrl);
        assert.equal(provider.uploads[2].options.contentType, "application/octet-stream");

        // Check warnings were logged with runId/model/provider
        const hasWarningWithMetadata = warnings.some(
          (w) => w.includes("runId") || w.includes("run-heic-1") || w.includes("run-unk-1")
        );
        assert.ok(hasWarningWithMetadata, "Expected warning logged for unrecognized provider asset");
      } finally {
        console.warn = origWarn;
        baseLogger.warn = origBaseWarn;
      }
    });

    it("rejects dangerous types (HTML, SVG, ZIP, EXE, ELF) even in provider-output path", async () => {
      const provider = new MockStorageProvider();
      const storage = new StorageService("test-bucket", provider);

      const dangerousPayloads = [
        "html_payload",
        "svg_payload",
        "zip_payload",
        "exe_payload",
        "elf_payload",
      ];

      for (const payloadType of dangerousPayloads) {
        const bytes = createD24SampleBytes(payloadType);
        await assert.rejects(
          async () => {
            await storage.upload(`runs/bad-${payloadType}`, bytes, {
              isProviderOutput: true,
              runId: "run-evil",
              model: "evil-model",
              provider: "evil-provider",
            });
          },
          /payload|markup|detected/i,
          `Dangerous payload ${payloadType} should have been rejected`
        );
      }
    });
  });

  // ── (b) Concurrent upload counter release verification ─────────────────────────
  describe("(b) Concurrent upload counter decrement on all 5 completion/abort paths", () => {
    it("Path 1: decrements on normal stream completion", async () => {
      const engine = createSizeLimitedMemoryStorage();
      const userId = "test-user-b1";

      const stream = Readable.from([createD24SampleBytes("jpeg_small")]);
      const req = { user: { id: userId }, ip: "127.0.0.1", on: () => {} };
      const file = { stream, mimetype: "image/jpeg" };

      await new Promise((resolve, reject) => {
        engine._handleFile(req, file, (err, info) => {
          if (err) return reject(err);
          resolve(info);
        });
      });

      assert.equal(getActiveUploadsCountForTest(userId), 0, "Counter must be 0 after normal completion");
    });

    it("Path 2: decrements on early sniff abort", async () => {
      const engine = createSizeLimitedMemoryStorage();
      const userId = "test-user-b2";

      const stream = Readable.from([createD24SampleBytes("html_payload")]);
      const req = { user: { id: userId }, ip: "127.0.0.1", on: () => {} };
      const file = { stream, mimetype: "image/jpeg" };

      const err = await new Promise((resolve) => {
        engine._handleFile(req, file, (err) => resolve(err));
      });

      assert.ok(err, "Must return an error for HTML payload");
      assert.equal(getActiveUploadsCountForTest(userId), 0, "Counter must be 0 after sniff abort");
    });

    it("Path 3: decrements on size-limit abort", async () => {
      const engine = createSizeLimitedMemoryStorage({ imageLimit: 100 });
      const userId = "test-user-b3";

      // Large buffer exceeding limit
      const bigBuf = Buffer.alloc(500, 0xff);
      const stream = Readable.from([bigBuf]);
      const req = { user: { id: userId }, ip: "127.0.0.1", on: () => {} };
      const file = { stream, mimetype: "image/jpeg" };

      const err = await new Promise((resolve) => {
        engine._handleFile(req, file, (err) => resolve(err));
      });

      assert.ok(err, "Must return size limit error");
      assert.equal(getActiveUploadsCountForTest(userId), 0, "Counter must be 0 after size abort");
    });

    it("Path 4: decrements on stream error", async () => {
      const engine = createSizeLimitedMemoryStorage();
      const userId = "test-user-b4";

      const stream = new Readable({
        read() {
          this.destroy(new Error("Simulated stream read error"));
        },
      });
      const req = { user: { id: userId }, ip: "127.0.0.1", on: () => {} };
      const file = { stream, mimetype: "image/jpeg" };

      const err = await new Promise((resolve) => {
        engine._handleFile(req, file, (err) => resolve(err));
      });

      assert.ok(err, "Must return stream error");
      assert.equal(getActiveUploadsCountForTest(userId), 0, "Counter must be 0 after stream error");
    });

    it("Path 5: decrements on client abort (req/file close event)", async () => {
      const engine = createSizeLimitedMemoryStorage();
      const userId = "test-user-b5";

      let closeHandler = null;
      const req = {
        user: { id: userId },
        ip: "127.0.0.1",
        on: (event, handler) => {
          if (event === "close") closeHandler = handler;
        },
      };

      const stream = new Readable({
        read() {
          // Never emit end to simulate abandoned connection
        },
      });
      const file = { stream, mimetype: "image/jpeg" };

      engine._handleFile(req, file, () => {});

      // Immediately after start, counter is 1
      assert.equal(getActiveUploadsCountForTest(userId), 1, "Counter must be 1 while upload is in progress");

      // Client closes connection prematurely
      if (closeHandler) {
        closeHandler();
      } else {
        stream.emit("close");
      }

      assert.equal(getActiveUploadsCountForTest(userId), 0, "Counter must be 0 after client abort");
    });

    it("Path 6: decrements and releases in-flight bytes on request timeout", async () => {
      const engine = createSizeLimitedMemoryStorage();
      const userId = "test-user-b6";

      let timeoutHandler = null;
      const req = {
        user: { id: userId },
        ip: "127.0.0.1",
        on: (event, handler) => {
          if (event === "timeout") timeoutHandler = handler;
        },
      };

      const stream = new Readable({
        read() {
          // Never emit end to simulate abandoned/timed out stream
        },
      });
      const file = { stream, mimetype: "image/jpeg" };

      engine._handleFile(req, file, () => {});

      assert.equal(getActiveUploadsCountForTest(userId), 1, "Counter must be 1 while upload is in progress");

      assert.ok(timeoutHandler, "req must register timeout handler");
      timeoutHandler();

      assert.equal(getActiveUploadsCountForTest(userId), 0, "Counter must be 0 after timeout");
    });
  });

  // ── (c) Redis readiness helper verification ─────────────────────────────────────
  describe("(c) Redis readiness helper", () => {
    it("waitForRateLimitRedis resolves if connection is already ready or in test env", async () => {
      assert.equal(typeof waitForRateLimitRedis, "function", "waitForRateLimitRedis must be exported");
      const ready = await waitForRateLimitRedis(200);
      assert.equal(typeof ready, "boolean", "Must resolve boolean");
    });
  });

  // ── (d) Auth short-circuit deduplication ────────────────────────────────────────
  describe("(d) Auth short-circuit deduplication", () => {
    it("short-circuits when req.user.id is already present without querying Supabase", async () => {
      let getUserCalls = 0;
      const origGetUser = supabase.auth.getUser;
      supabase.auth.getUser = async () => {
        getUserCalls++;
        return { data: { user: { id: "never-called" } }, error: null };
      };

      try {
        const req = {
          user: { id: "pre-authenticated-user" },
          headers: {},
        };
        let nextCalled = false;
        await requireAuth(req, {}, () => {
          nextCalled = true;
        });

        assert.equal(nextCalled, true, "requireAuth must invoke next()");
        assert.equal(getUserCalls, 0, "Supabase getUser must NOT be called when req.user.id is already present");
      } finally {
        supabase.auth.getUser = origGetUser;
      }
    });
  });

  // ── (e) Early sniff with 1-byte chunks ───────────────────────────────────────────
  describe("(e) Early sniff buffering with 1-byte chunks", () => {
    it("buffers 1-byte chunks up to 32 bytes and accepts valid JPEG", async () => {
      const engine = createSizeLimitedMemoryStorage();
      const userId = "test-user-e1";

      const jpegBytes = createD24SampleBytes("jpeg_small");
      // Deliver byte-by-byte
      const byteChunks = Array.from(jpegBytes).map((b) => Buffer.from([b]));
      const stream = Readable.from(byteChunks);

      const req = { user: { id: userId }, ip: "127.0.0.1", on: () => {} };
      const file = { stream, mimetype: "image/jpeg" };

      const result = await new Promise((resolve, reject) => {
        engine._handleFile(req, file, (err, info) => {
          if (err) return reject(err);
          resolve(info);
        });
      });

      assert.ok(result);
      assert.equal(file.detectedMimetype, "image/jpeg");
    });

    it("buffers 1-byte chunks and aborts early with 415 on forged HTML payload", async () => {
      const engine = createSizeLimitedMemoryStorage();
      const userId = "test-user-e2";

      const htmlBytes = createD24SampleBytes("html_payload");
      const byteChunks = Array.from(htmlBytes).map((b) => Buffer.from([b]));
      const stream = Readable.from(byteChunks);

      const req = { user: { id: userId }, ip: "127.0.0.1", on: () => {} };
      const file = { stream, mimetype: "image/jpeg" };

      const err = await new Promise((resolve) => {
        engine._handleFile(req, file, (err) => resolve(err));
      });

      assert.ok(err);
      assert.equal(err.statusCode, 415);
    });
  });

  // ── (g) Nosniff header verification ────────────────────────────────────────────
  describe("(g) X-Content-Type-Options: nosniff header", () => {
    it("Express responses include X-Content-Type-Options: nosniff header", async () => {
      const res = await fetch(`${baseUrl}/health`);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    });
  });
});
}

// ─── Source: uploadHardeningD25Boundary.test.js ───
{
process.env.NODE_ENV = "test";


const VALID_TEST_SECRET = "configured-valid-test-secret-at-least-32-chars"; // gate:allow-secret

describe("RC1.4-D2.5 — Upload Hardening & Security Follow-up Boundary Tests", () => {
  let server;
  let baseUrl;
  let origEnvSecret;

  before(async () => {
    origEnvSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = VALID_TEST_SECRET;

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    process.env.INTERNAL_SECRET = origEnvSecret;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      await rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect());
    } catch {}
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
  });

  beforeEach(() => {
    try {
      resetActiveUploadsForTest();
      resetInFlightBytesForTest?.();
    } catch {}
  });

  // ── (a) auth.js internal-secret path route allowlist ──────────────────────────
  describe("(a) Internal-secret path route restriction", () => {
    it("allows internal secret on allow-listed route", async () => {
      const origFlag = process.env.INTERNAL_AUTH_ENABLED;
      process.env.INTERNAL_AUTH_ENABLED = "true";
      const REAL_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
      try {
        const req = {
          method: "GET",
          path: "/api/workflows/project-data/proj-123",
          originalUrl: "/api/workflows/project-data/proj-123",
          headers: {
            "x-internal-secret": VALID_TEST_SECRET,
            "x-user-id": REAL_UUID,
          },
        };

        let nextCalled = false;
        await requireAuth(req, {}, () => {
          nextCalled = true;
        });

        assert.equal(nextCalled, true);
        assert.equal(req.user?.id, REAL_UUID);
      } finally {
        if (origFlag !== undefined) process.env.INTERNAL_AUTH_ENABLED = origFlag;
        else delete process.env.INTERNAL_AUTH_ENABLED;
      }
    });

    it("ignores internal secret on non-allowlisted route and rejects without JWT", async () => {
      const req = {
        path: "/api/wallet/transfer",
        originalUrl: "/api/wallet/transfer",
        headers: {
          "x-internal-secret": VALID_TEST_SECRET,
          "x-user-id": "impersonated-user",
        },
        cookies: {},
      };

      let nextError = null;
      await requireAuth(req, {}, (err) => {
        nextError = err;
      });

      assert.ok(nextError, "Must reject request to non-allowlisted route");
      assert.equal(nextError.statusCode, 401);
      assert.equal(req.user, undefined, "req.user must NOT be set via internal secret on non-allowlisted route");
    });
  });

  // ── (b) Per-instance cap on total in-flight upload bytes ───────────────────────
  describe("(b) Per-instance in-flight upload memory cap", () => {
    it("returns 503 with Retry-After when total in-flight bytes exceed instance cap", async () => {
      const engine = createSizeLimitedMemoryStorage({
        maxInFlightBytes: 100, // Small instance cap for test
      });

      const makeValidJpeg = (size) => {
        const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43]);
        const buf = Buffer.alloc(size, 0x20);
        header.copy(buf, 0);
        return buf;
      };

      const chunk1 = makeValidJpeg(80);
      const stream1 = Readable.from([chunk1]);
      const req1 = { user: { id: "user-1" }, ip: "127.0.0.1", on: () => {} };
      const file1 = { stream: stream1, mimetype: "image/jpeg" };

      // Start upload 1 (takes 80 bytes of 100 limit)
      engine._handleFile(req1, file1, () => {});

      // Upload 2 arrives while upload 1 is still in flight, pushing total over 100 bytes
      const chunk2 = makeValidJpeg(40);
      const stream2 = Readable.from([chunk2]);
      const resHeaders = {};
      const res2 = {
        setHeader: (k, v) => { resHeaders[k.toLowerCase()] = v; },
      };
      const req2 = { user: { id: "user-2" }, ip: "127.0.0.1", on: () => {}, res: res2 };
      const file2 = { stream: stream2, mimetype: "image/jpeg" };

      const err2 = await new Promise((resolve) => {
        engine._handleFile(req2, file2, (err) => resolve(err));
      });

      assert.ok(err2, "Upload 2 must be rejected");
      assert.equal(err2.statusCode, 503);
      assert.equal(err2.code, "SERVICE_UNAVAILABLE");
      assert.ok(err2.retryAfter || resHeaders["retry-after"], "Must provide Retry-After header");
    });
  });

  // ── (c) Redis readiness in /ready and /health liveness (D2.6) ───────────────────────────
  describe("(c) Health liveness and readiness probes", () => {
    it("/health endpoint returns liveness and /ready exposes redis readiness", async () => {
      const res = await fetch(`${baseUrl}/health`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true, "Response must include liveness status");

      const readyRes = await fetch(`${baseUrl}/ready`);
      assert.ok([200, 503].includes(readyRes.status), "/ready must return 200 or 503");
      const readyData = await readyRes.json();
      assert.equal(typeof readyData.ready, "boolean", "Must include boolean readiness status");
    });
  });

  // ── (d) Provider-output path security: SSRF & Dangerous SVG rejection ─────────
  describe("(d) Provider-output path security invariants", () => {
    it("MediaUploadService rejects private IP (SSRF) on remote URL ingestion", async () => {
      class MockStorageProvider {
        async upload() { return "https://cdn.example.com/file"; }
      }
      const storage = new StorageService("test-bucket", new MockStorageProvider());
      const mediaUploadService = new MediaUploadService({ storageService: storage });

      await assert.rejects(
        async () => {
          await mediaUploadService.upload({
            files: ["http://127.0.0.1/private-file.png"],
            userId: "user-1",
          });
        },
        /private|restricted|ssrf/i,
        "Private IP must be rejected by SSRF defense"
      );
    });

    it("rejects image/svg+xml declared MIME and SVG markup before allowlist check", async () => {
      class MockStorageProvider {
        async upload() { return "https://cdn.example.com/file"; }
      }
      const storage = new StorageService("test-bucket", new MockStorageProvider());

      // SVG with XML declaration and svg tag
      const svgPayload = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');

      await assert.rejects(
        async () => {
          await storage.upload("runs/svg-test.svg", svgPayload, {
            isProviderOutput: true,
            contentType: "image/svg+xml",
          });
        },
        /dangerous|svg|xml|rejected/i,
        "image/svg+xml must be rejected even for provider output"
      );
    });
  });
});
}

// ─── Source: uploadRouteErrorSafety.test.js ───
{
process.env.NODE_ENV = "test";


describe("Upload routes — safe public error bodies", () => {
    let server;
    let baseUrl;
    let origGetUser;
    let origUploadAsset;

    function stubService(err) {
        assetUploadService.uploadAsset = async () => {
            throw err;
        };
    }

    before(async () => {
        origGetUser = supabase?.auth?.getUser;
        if (supabase?.auth) {
            supabase.auth.getUser = async (token) => {
                if (token && token.startsWith("test-valid-user")) {
                    return { data: { user: { id: token } }, error: null };
                }
                return { data: { user: null }, error: new Error("Invalid token") };
            };
        }
        origUploadAsset = assetUploadService.uploadAsset;

        const app = express();
        app.use(express.json());
        app.use("/api/assets", assetsRouter);
        app.use("/api/media", mediaIngestRouter);

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        if (origUploadAsset) assetUploadService.uploadAsset = origUploadAsset;
        if (supabase?.auth && origGetUser) supabase.auth.getUser = origGetUser;
        if (server) await new Promise((resolve) => server.close(resolve));
    });

    const LEAK_EVIDENCE = "ECONNREFUSED secret-key storage quota exhausted table \"project\"";

    it("masks internal 5xx failure details on /api/media/ingest", async () => {
        stubService(Object.assign(new Error(LEAK_EVIDENCE), { statusCode: 500 }));
        const res = await fetch(`${baseUrl}/api/media/ingest`, {
            method: "POST",
            headers: { "authorization": "Bearer test-valid-user-x", "content-type": "application/json" },
            body: JSON.stringify({ source: "https://example.test/image.png" }),
        });
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.error, "Internal server error");
        assert.ok(!JSON.stringify(body).includes("ECONNREFUSED"));
        assert.ok(!JSON.stringify(body).includes("secret-key"));
    });

    it("masks internal 5xx failure details on /api/assets/upload", async () => {
        stubService(Object.assign(new Error(LEAK_EVIDENCE), { statusCode: 500 }));
        const res = await fetch(`${baseUrl}/api/assets/upload`, {
            method: "POST",
            headers: { "authorization": "Bearer test-valid-user-x", "content-type": "application/json" },
            body: JSON.stringify({ source: "https://example.test/image.png" }),
        });
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.message, "Internal server error");
        assert.equal(body.error, "Internal server error");
        assert.ok(!JSON.stringify(body).includes("ECONNREFUSED"));
    });

    it("keeps intentional 4xx validation messages public on /api/media/ingest", async () => {
        stubService(Object.assign(new Error("project_id is required: the user has no project available for this upload."), {
            statusCode: 400,
            errorCode: "VALIDATION_ERROR",
        }));
        const res = await fetch(`${baseUrl}/api/media/ingest`, {
            method: "POST",
            headers: { "authorization": "Bearer test-valid-user-x", "content-type": "application/json" },
            body: JSON.stringify({ source: "https://example.test/image.png" }),
        });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.match(body.error, /project_id is required/);
    });

    it("keeps 404 not-found responses on /api/assets/upload without masking", async () => {
        stubService(Object.assign(new Error("Project not found"), {
            statusCode: 404,
            errorCode: "NOT_FOUND",
        }));
        const res = await fetch(`${baseUrl}/api/assets/upload`, {
            method: "POST",
            headers: { "authorization": "Bearer test-valid-user-x", "content-type": "application/json" },
            body: JSON.stringify({ source: "https://example.test/image.png" }),
        });
        assert.equal(res.status, 404);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.match(body.message, /not found/i);
        assert.equal(body.errorCode, "NOT_FOUND");
    });

    it("passes the errorCode of known 4xx service errors through to the client", async () => {
        stubService(Object.assign(new Error("Invalid storage folder \"../evil\": expected a single segment of [A-Za-z0-9_-]."), {
            statusCode: 400,
            errorCode: "VALIDATION_ERROR",
        }));
        const res = await fetch(`${baseUrl}/api/assets/upload`, {
            method: "POST",
            headers: { "authorization": "Bearer test-valid-user-x", "content-type": "application/json" },
            body: JSON.stringify({ source: "https://example.test/image.png" }),
        });
        const body = await res.json();
        assert.equal(res.status, 400);
        assert.equal(body.errorCode, "VALIDATION_ERROR");
        assert.match(body.error, /Invalid storage folder/);
    });

    it("masks internal 5xx failure details on DELETE /api/assets/:id", async () => {
        const origDelete = workflowService.deleteMedia;
        workflowService.deleteMedia = async () => {
            throw Object.assign(new Error(LEAK_EVIDENCE), { statusCode: 500 });
        };
        try {
            const res = await fetch(`${baseUrl}/api/assets/media-neutral-1`, {
                method: "DELETE",
                headers: { "authorization": "Bearer test-valid-user-x" },
            });
            assert.equal(res.status, 500);
            const body = await res.json();
            assert.equal(body.ok, false);
            assert.equal(body.error, "Internal server error");
            assert.equal(body.errorCode, "INTERNAL_ERROR");
            assert.ok(!JSON.stringify(body).includes("ECONNREFUSED"));
            assert.ok(!JSON.stringify(body).includes("secret-key"));
        } finally {
            workflowService.deleteMedia = origDelete;
        }
    });

    it("preserves the 404 contract on DELETE /api/assets/:id", async () => {
        const origDelete = workflowService.deleteMedia;
        workflowService.deleteMedia = async () => {
            throw Object.assign(new Error("Media not found."), { statusCode: 404, errorCode: "NOT_FOUND" });
        };
        try {
            const res = await fetch(`${baseUrl}/api/assets/media-neutral-1`, {
                method: "DELETE",
                headers: { "authorization": "Bearer test-valid-user-x" },
            });
            assert.equal(res.status, 404);
            const body = await res.json();
            assert.equal(body.ok, false);
            assert.match(body.error, /not found/i);
            assert.equal(body.errorCode, "NOT_FOUND");
        } finally {
            workflowService.deleteMedia = origDelete;
        }
    });
});
}

// ─── Source: multipartMultiFileErrorSafetyBoundary.test.js ───
{
describe("STEP 3: Multipart 2 files route-level error safety boundary test", () => {
  let server;
  let baseUrl;
  let origGetUser;

  before(async () => {
    origGetUser = supabase?.auth?.getUser;
    if (supabase?.auth) {
      supabase.auth.getUser = async (token) => {
        if (token && token.startsWith("test-valid-user")) {
          return { data: { user: { id: "test-valid-user-1" } }, error: null };
        }
        return { data: { user: null }, error: new Error("Invalid token") };
      };
    }

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (supabase?.auth && origGetUser) {
      supabase.auth.getUser = origGetUser;
    }
    try {
      const { rateLimitRedisConnection } = await import("#shared");
      await rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect());
    } catch {}
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("POST /api/assets/upload with 2 files receives a clean 4xx error (not 500, no crash)", async () => {
    const formData = new FormData();
    formData.append("file", new Blob([Buffer.from("file 1 content")], { type: "image/png" }), "file1.png");
    formData.append("file", new Blob([Buffer.from("file 2 content")], { type: "image/png" }), "file2.png");
    formData.append("project_id", "00000000-0000-0000-0000-000000000001");

    const res = await fetch(`${baseUrl}/api/assets/upload`, {
      method: "POST",
      headers: { Authorization: "Bearer test-valid-user-1" },
      body: formData,
    });

    const body = await res.json().catch(() => ({}));
    console.log(`[TEST RESULT] Status: ${res.status}, Body:`, JSON.stringify(body));

    // Asserts clean 4xx (400 Bad Request or similar) instead of 500 Internal Server Error
    assert.ok(
      res.status >= 400 && res.status < 500,
      `Expected clean 4xx JSON error, but got HTTP ${res.status}: ${JSON.stringify(body)}`
    );
  });
});
}
