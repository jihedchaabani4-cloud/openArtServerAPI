process.env.NODE_ENV = "test";

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import app from "../../index.js";
import { supabase } from "../../lib/supabase.js";
import { StorageService } from "../../src/platform/storage/StorageService.js";
import {
  createSizeLimitedMemoryStorage,
  resetActiveUploadsForTest,
  resetInFlightBytesForTest,
  getInFlightBytesForTest,
} from "../../src/middleware/sizeLimitedStorage.js";
import { requireAuth, isInternalSecretAllowedRoute } from "../../src/middleware/auth.js";
import {
  redisConnection,
  workerRedisConnection,
  rateLimitRedisConnection,
  waitForRateLimitRedis,
} from "../../src/queue/redis.js";

const VALID_TEST_SECRET = "configured-valid-test-secret-at-least-32-chars";

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
    it("uploadFromUrl rejects private IP (SSRF) even when isProviderOutput is true", async () => {
      class MockStorageProvider {
        async upload() { return "https://cdn.example.com/file"; }
      }
      const storage = new StorageService("test-bucket", new MockStorageProvider());

      await assert.rejects(
        async () => {
          await storage.uploadFromUrl("runs/ssrf-test.png", "http://127.0.0.1/private-file.png", {
            isProviderOutput: true,
          });
        },
        /private|restricted|ssrf/i,
        "Private IP must be rejected by SSRF defense even for provider outputs"
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
          await storage.uploadBuffer("runs/svg-test.svg", svgPayload, {
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
