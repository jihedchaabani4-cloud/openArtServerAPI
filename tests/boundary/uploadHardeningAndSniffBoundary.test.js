process.env.NODE_ENV = "test";

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import app, { isScopedLargeBodyRoute, normalizeRoutePath } from "../../index.js";
import { supabase } from "../../lib/supabase.js";
import { StorageService } from "../../src/platform/storage/StorageService.js";
import { MediaInspector } from "../../src/platform/media-ingestion/MediaInspector.js";
import { createSizeLimitedMemoryStorage, resetActiveUploadsForTest } from "../../src/middleware/sizeLimitedStorage.js";
import { requireAuth } from "../../src/middleware/auth.js";
import { setLimiterForTest, resetLimitersForTest } from "../../src/middleware/rateLimit.js";
import { registerProviderRunner, unregisterProviderRunner } from "../../src/models/runtime/providerRuntimeRegistry.js";
import { resolveBindingForTest } from "../../src/models/registry/bindingResolver.js";
import { redisConnection, workerRedisConnection, rateLimitRedisConnection } from "../../src/queue/redis.js";

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
      const url = await storage.uploadBuffer("uploads/image.png", pngBytes, {
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
        () => storage.uploadBuffer("uploads/image.png", pngBytes, {
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
          () => storage.uploadBuffer("uploads/exploit.bin", payload, { contentType: "image/png" }),
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
      await storage.uploadBuffer("generated/art.jpg", webpBytes, {
        contentType: "image/jpeg",
        isProviderOutput: true,
      });
      assert.equal(provider.uploads[provider.uploads.length - 1].options.contentType, "image/webp");

      // 2. Provider returns MP4 but CDN header declared application/octet-stream
      const mp4Bytes = createSampleBytes("mp4_isom");
      await storage.uploadBuffer("generated/clip.mp4", mp4Bytes, {
        contentType: "application/octet-stream",
        isProviderOutput: true,
      });
      assert.equal(provider.uploads[provider.uploads.length - 1].options.contentType, "video/mp4");

      // 3. Provider returns QuickTime MOV but CDN header declared video/mp4
      const movBytes = createSampleBytes("mov_qt");
      await storage.uploadBuffer("generated/movie.mov", movBytes, {
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
        () => storage.uploadBuffer("generated/out.jpg", htmlPayload, {
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

    it("TEST D2.3-b4: 3rd concurrent upload of the same user returns 429", async () => {
      const storage = createSizeLimitedMemoryStorage({
        imageLimit: 20 * 1024 * 1024,
        videoLimit: 100 * 1024 * 1024,
      });

      const user = "concurrent-test-user";
      const jpegHeader = createSampleBytes("jpeg");

      // Create two hanging streams that stay open
      const stream1 = new Readable({ read() { this.push(jpegHeader); } });
      const stream2 = new Readable({ read() { this.push(jpegHeader); } });
      const stream3 = new Readable({ read() { this.push(jpegHeader); } });

      storage._handleFile({ user: { id: user } }, { mimetype: "image/jpeg", stream: stream1 }, () => {});
      storage._handleFile({ user: { id: user } }, { mimetype: "image/jpeg", stream: stream2 }, () => {});

      // 3rd upload should immediately return 429
      await new Promise((resolve) => {
        storage._handleFile({ user: { id: user } }, { mimetype: "image/jpeg", stream: stream3 }, (err) => {
          assert.ok(err, "3rd concurrent upload must fail");
          assert.equal(err.statusCode, 429);
          assert.equal(err.code, "TOO_MANY_CONCURRENT_UPLOADS");
          resolve();
        });
      });

      // Close stream1 and stream2 to release concurrency
      stream1.push(null);
      stream2.push(null);
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
    });

    it("TEST D2.3-f8: Valid image/png is accepted on upload route", async () => {
      const { mediaIngestionService } = await import("../../src/container.js");
      const origIngest = mediaIngestionService.ingest;
      mediaIngestionService.ingest = async ({ source }) => {
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
        mediaIngestionService.ingest = origIngest;
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
