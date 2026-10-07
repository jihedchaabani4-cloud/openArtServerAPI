process.env.NODE_ENV = "test";

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import app from "../../index.js";
import { supabase } from "../../lib/supabase.js";
import { StorageService } from "../../src/platform/storage/StorageService.js";
import { MediaInspector } from "../../src/platform/media-ingestion/MediaInspector.js";
import {
  createSizeLimitedMemoryStorage,
  resetActiveUploadsForTest,
  getActiveUploadsCountForTest,
} from "../../src/middleware/sizeLimitedStorage.js";
import { requireAuth } from "../../src/middleware/auth.js";
import {
  redisConnection,
  workerRedisConnection,
  rateLimitRedisConnection,
  waitForRateLimitRedis,
} from "../../src/queue/redis.js";
import { baseLogger } from "../../src/infrastructure/logging/index.js";

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
        const heicUrl = await storage.uploadBuffer("runs/gen-1.heic", heicBytes, {
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
        const mp3Url = await storage.uploadBuffer("runs/audio-1.mp3", mp3Bytes, {
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
        const unkUrl = await storage.uploadBuffer("runs/unknown-1.bin", unknownBytes, {
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
            await storage.uploadBuffer(`runs/bad-${payloadType}`, bytes, {
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
