import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import app from "../../index.js";
import { supabase } from "../../lib/supabase.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { setLimiterForTest, resetLimitersForTest } from "../../src/middleware/rateLimit.js";
import { MediaInspector } from "../../src/platform/media-ingestion/MediaInspector.js";

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
      const { rateLimitRedisConnection } = await import("../../src/queue/redis.js");
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
    const { rateLimitRedisConnection } = await import("../../src/queue/redis.js");
    assert.ok(rateLimitRedisConnection, "rateLimitRedisConnection must be exported");
    assert.equal(
      rateLimitRedisConnection.options.enableOfflineQueue,
      false,
      "rateLimitRedisConnection must disable offline queue to fail fast"
    );
  });
});
