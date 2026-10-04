import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { assertSecurityConfiguredForEnvironment } from "../../src/container.js";
import { safeCompareSecret } from "../../src/platform/security/secretComparison.js";
import workflowsRouter from "../../routes/workflows.js";
import { projectReadService } from "../../src/container.js";
import { supabase } from "../../lib/supabase.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";

describe("RC1.1-R1 — Internal Secret Security & Timing-Safe Enforcement", () => {
  let origEnv;

  after(async () => {
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
  });

  beforeEach(() => {
    origEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  // ── 1. Boot Assertions in Production ──────────────────────────────────────
  it("TEST 1: In production (NODE_ENV=production), server refuses to boot if INTERNAL_SECRET is missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.INTERNAL_SECRET;

    assert.throws(
      () => {
        assertSecurityConfiguredForEnvironment();
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Fatal: INTERNAL_SECRET is required in production/i);
        return true;
      },
      "Must throw when booting in production without INTERNAL_SECRET"
    );
  });

  it("TEST 2: In production (NODE_ENV=production), server refuses to boot if INTERNAL_SECRET is shorter than 32 characters", () => {
    process.env.NODE_ENV = "production";
    process.env.INTERNAL_SECRET = "short-secret-under-32-chars";

    assert.throws(
      () => {
        assertSecurityConfiguredForEnvironment();
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /must be at least 32 characters long/i);
        return true;
      },
      "Must throw when booting in production with INTERNAL_SECRET < 32 chars"
    );
  });

  it("TEST 3: In production (NODE_ENV=production), server boots cleanly if INTERNAL_SECRET is >= 32 characters", () => {
    process.env.NODE_ENV = "production";
    process.env.INTERNAL_SECRET = "a-very-long-production-grade-secret-key-32-chars-min";

    assert.doesNotThrow(() => {
      assertSecurityConfiguredForEnvironment();
    });
  });

  // ── 2. Constant-Time Comparison Unit Tests ─────────────────────────────────
  it("TEST 4: safeCompareSecret compares secrets in constant time and rejects unequal or falsy values", () => {
    const validSecret = "super-secret-valid-token-at-least-32-chars-long";
    assert.equal(safeCompareSecret(validSecret, validSecret), true);
    assert.equal(safeCompareSecret(validSecret, "super-secret-valid-token-different"), false);
    assert.equal(safeCompareSecret(validSecret, "short"), false);
    assert.equal(safeCompareSecret("openart_internal_s2s_secret_2026", validSecret), false);
    assert.equal(safeCompareSecret(undefined, validSecret), false);
    assert.equal(safeCompareSecret(validSecret, null), false);
    assert.equal(safeCompareSecret("", validSecret), false);
  });

  // ── 3. Old Hardcoded Secret & Route Bypass Tests ────────────────────────────
  describe("Route Bypass Enforcement", () => {
    let server;
    let baseUrl;
    const testSecret = "configured-valid-test-secret-at-least-32-chars";
    let originalGetWorkflowByMedia;
    let originalGetUser;

    beforeEach(async () => {
      process.env.INTERNAL_SECRET = testSecret;

      originalGetWorkflowByMedia = projectReadService.getWorkflowByMedia;
      originalGetUser = supabase.auth.getUser;

      supabase.auth.getUser = async (token) => {
        if (token === "valid-user-token") {
          return { data: { user: { id: "user-attacker" } }, error: null };
        }
        return { data: { user: null }, error: new Error("Invalid token") };
      };

      const app = express();
      app.use(express.json());
      app.use("/api/workflows", workflowsRouter);
      app.use((err, req, res, next) => {
        res.status(err.statusCode || 500).json({
          ok: false,
          message: err.message,
        });
      });

      server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
      projectReadService.getWorkflowByMedia = originalGetWorkflowByMedia;
      supabase.auth.getUser = originalGetUser;
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("TEST 5: Request with the old hardcoded value gets no bypass and foreign media yields 404", async () => {
      // Mock getWorkflowByMedia checking ownership
      projectReadService.getWorkflowByMedia = async ({ mediaId, userId, req }) => {
        const secret = req?.headers?.["x-internal-secret"];
        const isInternal = Boolean(secret && safeCompareSecret(secret, process.env.INTERNAL_SECRET));
        if (isInternal) {
          return { workflow: { id: "wf-1" }, items: [] };
        }
        // Foreign media => 404
        const err = new Error("Media not found");
        err.statusCode = 404;
        throw err;
      };

      const res = await fetch(`${baseUrl}/api/workflows/workflow-by-media/media-foreign-123`, {
        headers: {
          "Authorization": "Bearer valid-user-token",
          "x-internal-secret": "openart_internal_s2s_secret_2026", // OLD hardcoded value
        },
      });

      const body = await res.json();
      assert.equal(res.status, 404, `Expected 404, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.ok, false);
      assert.match(body.message, /not found/i);
    });

    it("TEST 6: Request with correct configured secret allows bypass on authorized internal routes", async () => {
      projectReadService.getWorkflowByMedia = async ({ mediaId, userId, req }) => {
        const secret = req?.headers?.["x-internal-secret"];
        const isInternal = Boolean(secret && safeCompareSecret(secret, process.env.INTERNAL_SECRET));
        if (isInternal) {
          return { workflow: { id: "wf-1" }, items: [] };
        }
        const err = new Error("Media not found");
        err.statusCode = 404;
        throw err;
      };

      const res = await fetch(`${baseUrl}/api/workflows/workflow-by-media/media-foreign-123`, {
        headers: {
          "x-internal-secret": testSecret,
          "x-user-id": "service-worker",
        },
      });

      const body = await res.json();
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.ok, true);
      assert.equal(body.workflow.id, "wf-1");
    });
  });
});
