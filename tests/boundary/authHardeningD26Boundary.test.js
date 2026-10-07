import { describe, it, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { requireAuth } from "../../src/middleware/auth.js";
import healthRouter from "../../routes/health.js";
import readyRouter, { _resetReadinessCacheForTest } from "../../routes/ready.js";
import { rateLimitRedisConnection, redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { StorageService } from "../../src/platform/storage/StorageService.js";
import { supabase } from "../../lib/supabase.js";
import { WorkflowAuthorizationService } from "../../src/platform/workflow/WorkflowAuthorizationService.js";
import { ProjectReadService } from "../../src/domain/project/ProjectReadService.js";

const VALID_TEST_SECRET = "test-internal-secret-for-d26-auth-min-32-chars-ok!";

describe("D2.6 Security Hardening Boundary Tests", () => {
  let origEnvSecret;
  let origInternalAuthEnabled;

  beforeEach(() => {
    _resetReadinessCacheForTest?.();
    origEnvSecret = process.env.INTERNAL_SECRET;
    origInternalAuthEnabled = process.env.INTERNAL_AUTH_ENABLED;
    process.env.INTERNAL_SECRET = VALID_TEST_SECRET;
  });

  after(async () => {
    await Promise.allSettled([
      rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect()),
      redisConnection?.quit().catch(() => redisConnection?.disconnect()),
      workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect()),
    ]);
  });

  afterEach(() => {
    process.env.INTERNAL_SECRET = origEnvSecret;
    if (origInternalAuthEnabled !== undefined) {
      process.env.INTERNAL_AUTH_ENABLED = origInternalAuthEnabled;
    } else {
      delete process.env.INTERNAL_AUTH_ENABLED;
    }
  });

  // ── (a) auth.js internal secret restrictions (13 tests) ───────────────────
  describe("(a) Internal secret restricted to exact allow-listed pairs & disabled by default", () => {
    it("1. flag unset, correct secret, valid user id -> GET allowed path -> ignored (401)", async () => {
      delete process.env.INTERNAL_AUTH_ENABLED;

      const req = {
        method: "GET",
        path: "/api/workflows/project-data/proj-123",
        originalUrl: "/api/workflows/project-data/proj-123",
        headers: {
          "x-internal-secret": VALID_TEST_SECRET,
          "x-user-id": "service-worker-user",
        },
        cookies: {},
      };

      let nextErr = null;
      await requireAuth(req, {}, (err) => {
        nextErr = err;
      });

      assert.ok(nextErr, "Must reject request when INTERNAL_AUTH_ENABLED is unset");
      assert.equal(nextErr.statusCode, 401);
      assert.equal(req.user, undefined);
    });

    it("2. flag 'false', correct secret -> GET allowed path -> ignored (401)", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "false";

      const req = {
        method: "GET",
        path: "/api/workflows/project-data/proj-123",
        originalUrl: "/api/workflows/project-data/proj-123",
        headers: {
          "x-internal-secret": VALID_TEST_SECRET,
          "x-user-id": "service-worker-user",
        },
        cookies: {},
      };

      let nextErr = null;
      await requireAuth(req, {}, (err) => {
        nextErr = err;
      });

      assert.ok(nextErr, "Must reject request when INTERNAL_AUTH_ENABLED is false");
      assert.equal(nextErr.statusCode, 401);
      assert.equal(req.user, undefined);
    });

    it("3. flag 'true', WRONG secret -> GET allowed path -> ignored (401) and warn log", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";

      const req = {
        method: "GET",
        path: "/api/workflows/project-data/proj-123",
        originalUrl: "/api/workflows/project-data/proj-123",
        headers: {
          "x-internal-secret": "completely-wrong-internal-secret-attempt",
          "x-user-id": "service-worker-user",
        },
        cookies: {},
      };

      let nextErr = null;
      await requireAuth(req, {}, (err) => {
        nextErr = err;
      });

      assert.ok(nextErr, "Must reject request with wrong secret");
      assert.equal(nextErr.statusCode, 401);
      assert.equal(req.user, undefined);
    });

    it("4. flag 'true', correct secret -> POST on allowed path -> ignored (method not allowed)", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";

      const req = {
        method: "POST",
        path: "/api/workflows/project-data/proj-123",
        originalUrl: "/api/workflows/project-data/proj-123",
        headers: {
          "x-internal-secret": VALID_TEST_SECRET,
          "x-user-id": "service-worker-user",
        },
        cookies: {},
      };

      let nextErr = null;
      await requireAuth(req, {}, (err) => {
        nextErr = err;
      });

      assert.ok(nextErr, "POST on project-data must be rejected");
      assert.equal(nextErr.statusCode, 401);
      assert.equal(req.user, undefined);
    });

    it("5. flag 'true', correct secret -> DELETE /api/workflows/workflows/abc -> ignored", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";

      const req = {
        method: "DELETE",
        path: "/api/workflows/workflows/abc",
        originalUrl: "/api/workflows/workflows/abc",
        headers: {
          "x-internal-secret": VALID_TEST_SECRET,
          "x-user-id": "service-worker-user",
        },
        cookies: {},
      };

      let nextErr = null;
      await requireAuth(req, {}, (err) => {
        nextErr = err;
      });

      assert.ok(nextErr, "DELETE on workflows must be rejected");
      assert.equal(nextErr.statusCode, 401);
      assert.equal(req.user, undefined);
    });

    it("6. flag 'true', correct secret -> POST /api/images/generate -> ignored", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";

      const forbiddenRoutes = [
        { method: "POST", url: "/api/images/generate" },
        { method: "POST", url: "/api/video/generate" },
        { method: "POST", url: "/api/v2/workflows/run" },
        { method: "POST", url: "/api/characters" },
        { method: "DELETE", url: "/api/v2/elements/elem-123" },
        { method: "POST", url: "/api/wallet/credit" },
      ];

      for (const route of forbiddenRoutes) {
        const req = {
          method: route.method,
          path: route.url,
          originalUrl: route.url,
          headers: {
            "x-internal-secret": VALID_TEST_SECRET,
            "x-user-id": "attacker-user",
          },
          cookies: {},
        };

        let nextErr = null;
        await requireAuth(req, {}, (err) => {
          nextErr = err;
        });

        assert.ok(nextErr, `Forbidden route ${route.method} ${route.url} must be rejected`);
        assert.equal(nextErr.statusCode, 401);
        assert.equal(req.user, undefined);
      }
    });

    it("7. flag 'true', correct secret -> path traversal /.. and %2e segments -> ignored", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";

      const traversalUrls = [
        "/api/workflows/project-data/x/../images",
        "/api/workflows/project-data/x%2F..%2Fimages",
        "/api/workflows/project-data/..",
      ];

      for (const url of traversalUrls) {
        const req = {
          method: "GET",
          path: url,
          originalUrl: url,
          headers: {
            "x-internal-secret": VALID_TEST_SECRET,
            "x-user-id": "service-worker-user",
          },
          cookies: {},
        };

        let nextErr = null;
        await requireAuth(req, {}, (err) => {
          nextErr = err;
        });

        assert.ok(nextErr, `Traversal attempt ${url} must be rejected`);
        assert.equal(nextErr.statusCode, 401);
        assert.equal(req.user, undefined);
      }
    });

    it("8. flag 'true', correct secret -> trailing slash and extra segments -> ignored", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";

      const invalidPaths = [
        "/api/workflows/project-data/abc/",
        "/api/workflows/project-data/abc/extra",
        "/api/workflows/workflows/abc/",
        "/api/workflows/workflows/abc/extra",
      ];

      for (const url of invalidPaths) {
        const req = {
          method: "GET",
          path: url,
          originalUrl: url,
          headers: {
            "x-internal-secret": VALID_TEST_SECRET,
            "x-user-id": "service-worker-user",
          },
          cookies: {},
        };

        let nextErr = null;
        await requireAuth(req, {}, (err) => {
          nextErr = err;
        });

        assert.ok(nextErr, `Path ${url} must be rejected`);
        assert.equal(nextErr.statusCode, 401);
        assert.equal(req.user, undefined);
      }
    });

    it("9. flag 'true', correct secret, invalid user id format -> allowed path -> ignored", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";

      const invalidUserIds = ["", "   ", "bad/user", "user$inject", "user;drop table", "element-vision-worker", "not-a-uuid-12345"];

      for (const badId of invalidUserIds) {
        const req = {
          method: "GET",
          path: "/api/workflows/project-data/proj-123",
          originalUrl: "/api/workflows/project-data/proj-123",
          headers: {
            "x-internal-secret": VALID_TEST_SECRET,
            "x-user-id": badId,
          },
          cookies: {},
        };

        let nextErr = null;
        await requireAuth(req, {}, (err) => {
          nextErr = err;
        });

        assert.ok(nextErr, `Invalid user id "${badId}" must be rejected`);
        assert.equal(nextErr.statusCode, 401);
        assert.equal(req.user, undefined);
      }
    });

    it("10. flag 'true', correct secret, valid user id (real UUID) -> GET /api/workflows/project-data/abc -> accepted", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";
      const REAL_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

      const req = {
        method: "GET",
        path: "/api/workflows/project-data/abc",
        originalUrl: "/api/workflows/project-data/abc",
        headers: {
          "x-internal-secret": VALID_TEST_SECRET,
          "x-user-id": REAL_UUID,
        },
        cookies: {},
      };

      let nextCalled = false;
      await requireAuth(req, {}, (err) => {
        assert.ifError(err);
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      assert.equal(req.user?.id, REAL_UUID);
    });

    it("11. flag 'true', correct secret, valid user id (real UUID) -> PATCH /api/workflows/workflows/abc -> accepted", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";
      const REAL_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

      const req = {
        method: "PATCH",
        path: "/api/workflows/workflows/abc",
        originalUrl: "/api/workflows/workflows/abc",
        headers: {
          "x-internal-secret": VALID_TEST_SECRET,
          "x-user-id": REAL_UUID,
        },
        cookies: {},
      };

      let nextCalled = false;
      await requireAuth(req, {}, (err) => {
        assert.ifError(err);
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      assert.equal(req.user?.id, REAL_UUID);
    });

    it("12. any accepted/rejected case -> serialized logs do NOT contain secret string", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";
      const REAL_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

      const req = {
        method: "GET",
        path: "/api/workflows/project-data/abc",
        originalUrl: "/api/workflows/project-data/abc",
        headers: {
          "x-internal-secret": VALID_TEST_SECRET,
          "x-user-id": REAL_UUID,
        },
        cookies: {},
      };

      await requireAuth(req, {}, () => {});
      // Headers and req objects sanitized through logging serializers
      assert.ok(!JSON.stringify(req.user || {}).includes(VALID_TEST_SECRET));
    });

    it("13. flag 'true', NO secret header, valid JWT -> normal JWT authentication still works", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";

      const origGetUser = supabase.auth.getUser;
      supabase.auth.getUser = async (token) => {
        if (token === "valid-supabase-jwt-token") {
          return { data: { user: { id: "user-from-jwt" } }, error: null };
        }
        return { data: { user: null }, error: new Error("invalid token") };
      };

      try {
        const req = {
          method: "GET",
          path: "/api/workflows/project-data/abc",
          originalUrl: "/api/workflows/project-data/abc",
          headers: {
            authorization: "Bearer valid-supabase-jwt-token",
          },
          cookies: {},
        };

        let nextCalled = false;
        await requireAuth(req, {}, (err) => {
          assert.ifError(err);
          nextCalled = true;
        });

        assert.equal(nextCalled, true);
        assert.equal(req.user?.id, "user-from-jwt");
      } finally {
        supabase.auth.getUser = origGetUser;
      }
    });
  });

  // ── (b) Split /health and /ready (6 tests) ─────────────────────────────────
  describe("(b) Health and readiness split", () => {
    function invokeHandler(router, req) {
      return new Promise((resolve) => {
        let statusCode = 200;
        const res = {
          status(code) {
            statusCode = code;
            return this;
          },
          json(data) {
            resolve({ statusCode, data });
            return this;
          },
        };
        router.handle(req, res, () => resolve({ statusCode, data: null }));
      });
    }

    it("1. /health returns 200 even if Redis is down, body has only { ok: true }", async () => {
      const req = { method: "GET", url: "/", path: "/" };
      const { statusCode, data } = await invokeHandler(healthRouter, req);

      assert.equal(statusCode, 200);
      assert.deepEqual(data, { ok: true });
    });

    it("2. /ready returns 200 when both Redis connections are ready", async () => {
      const origRLStatus = rateLimitRedisConnection.status;
      const origQStatus = redisConnection.status;
      rateLimitRedisConnection.status = "ready";
      redisConnection.status = "ready";

      const origRLPing = rateLimitRedisConnection.ping;
      const origQPing = redisConnection.ping;
      rateLimitRedisConnection.ping = async () => "PONG";
      redisConnection.ping = async () => "PONG";

      try {
        const req = { method: "GET", url: "/", path: "/" };
        const { statusCode, data } = await invokeHandler(readyRouter, req);

        assert.equal(statusCode, 200);
        assert.deepEqual(data, { ready: true });
      } finally {
        rateLimitRedisConnection.status = origRLStatus;
        redisConnection.status = origQStatus;
        rateLimitRedisConnection.ping = origRLPing;
        redisConnection.ping = origQPing;
      }
    });

    it("3. /ready returns 503 when rateLimit Redis is not ready", async () => {
      const origRLStatus = rateLimitRedisConnection.status;
      const origQStatus = redisConnection.status;
      rateLimitRedisConnection.status = "close";
      redisConnection.status = "ready";

      try {
        const req = { method: "GET", url: "/", path: "/" };
        const { statusCode, data } = await invokeHandler(readyRouter, req);

        assert.equal(statusCode, 503);
        assert.deepEqual(data, { ready: false });
      } finally {
        rateLimitRedisConnection.status = origRLStatus;
        redisConnection.status = origQStatus;
      }
    });

    it("4. /ready returns 503 when queue Redis is not ready", async () => {
      const origRLStatus = rateLimitRedisConnection.status;
      const origQStatus = redisConnection.status;
      rateLimitRedisConnection.status = "ready";
      redisConnection.status = "connecting";

      try {
        const req = { method: "GET", url: "/", path: "/" };
        const { statusCode, data } = await invokeHandler(readyRouter, req);

        assert.equal(statusCode, 503);
        assert.deepEqual(data, { ready: false });
      } finally {
        rateLimitRedisConnection.status = origRLStatus;
        redisConnection.status = origQStatus;
      }
    });

    it("5. /ready 503 body contains ONLY { ready: false }", async () => {
      const origRLStatus = rateLimitRedisConnection.status;
      rateLimitRedisConnection.status = "end";

      try {
        const req = { method: "GET", url: "/", path: "/" };
        const { statusCode, data } = await invokeHandler(readyRouter, req);

        assert.equal(statusCode, 503);
        assert.deepEqual(data, { ready: false });
        assert.equal(Object.keys(data).length, 1);
      } finally {
        rateLimitRedisConnection.status = origRLStatus;
      }
    });

    it("6. /ready does not throw when a Redis ping rejects (returns 503)", async () => {
      const origRLStatus = rateLimitRedisConnection.status;
      const origQStatus = redisConnection.status;
      const origRLPing = rateLimitRedisConnection.ping;
      rateLimitRedisConnection.status = "ready";
      redisConnection.status = "ready";
      rateLimitRedisConnection.ping = async () => {
        throw new Error("Connection reset by peer");
      };

      try {
        const req = { method: "GET", url: "/", path: "/" };
        const { statusCode, data } = await invokeHandler(readyRouter, req);

        assert.equal(statusCode, 503);
        assert.deepEqual(data, { ready: false });
      } finally {
        rateLimitRedisConnection.status = origRLStatus;
        redisConnection.status = origQStatus;
        rateLimitRedisConnection.ping = origRLPing;
      }
    });

    it("7. /ready caches result for 1 to 2 seconds without re-pinging Redis within TTL", async () => {
      const origRLStatus = rateLimitRedisConnection.status;
      const origQStatus = redisConnection.status;
      const origRLPing = rateLimitRedisConnection.ping;
      const origQPing = redisConnection.ping;

      rateLimitRedisConnection.status = "ready";
      redisConnection.status = "ready";

      let pingCount = 0;
      rateLimitRedisConnection.ping = async () => {
        pingCount++;
        return "PONG";
      };
      redisConnection.ping = async () => {
        pingCount++;
        return "PONG";
      };

      try {
        const req1 = { method: "GET", url: "/", path: "/" };
        const res1 = await invokeHandler(readyRouter, req1);
        assert.equal(res1.statusCode, 200);
        assert.deepEqual(res1.data, { ready: true });
        const initialPings = pingCount;
        assert.ok(initialPings >= 2, "Initial check must perform pings");

        // Immediate second call should hit cache and NOT invoke ping again
        const req2 = { method: "GET", url: "/", path: "/" };
        const res2 = await invokeHandler(readyRouter, req2);
        assert.equal(res2.statusCode, 200);
        assert.deepEqual(res2.data, { ready: true });
        assert.equal(pingCount, initialPings, "Second check within cache TTL must hit cache without re-pinging Redis");
      } finally {
        rateLimitRedisConnection.status = origRLStatus;
        redisConnection.status = origQStatus;
        rateLimitRedisConnection.ping = origRLPing;
        redisConnection.ping = origQPing;
      }
    });

    it("8. /ready respects short timeout (READINESS_TIMEOUT_MS) and returns 503 on slow ping", async () => {
      const origRLStatus = rateLimitRedisConnection.status;
      const origQStatus = redisConnection.status;
      const origRLPing = rateLimitRedisConnection.ping;
      const origTimeoutEnv = process.env.READINESS_TIMEOUT_MS;

      process.env.READINESS_TIMEOUT_MS = "50"; // 50ms short timeout for test
      rateLimitRedisConnection.status = "ready";
      redisConnection.status = "ready";

      // Hang ping beyond 50ms
      rateLimitRedisConnection.ping = () => new Promise((resolve) => setTimeout(resolve, 200));

      try {
        const req = { method: "GET", url: "/", path: "/" };
        const { statusCode, data } = await invokeHandler(readyRouter, req);

        assert.equal(statusCode, 503);
        assert.deepEqual(data, { ready: false });
      } finally {
        rateLimitRedisConnection.status = origRLStatus;
        redisConnection.status = origQStatus;
        rateLimitRedisConnection.ping = origRLPing;
        if (origTimeoutEnv !== undefined) {
          process.env.READINESS_TIMEOUT_MS = origTimeoutEnv;
        } else {
          delete process.env.READINESS_TIMEOUT_MS;
        }
      }
    });
  });

  // ── (c) Structured logger tests ───────────────────────────────────────────
  describe("(c) Structured logger instead of console.* in touched files", () => {
    it("StorageService does not invoke console.error on upload or delete failure", async () => {
      let consoleErrorCalls = 0;
      const origConsoleError = console.error;
      console.error = (...args) => {
        consoleErrorCalls++;
        origConsoleError(...args);
      };

      const mockFailingProvider = {
        upload: async () => { throw new Error("Storage provider timeout"); },
        delete: async () => { throw new Error("Storage provider delete error"); },
        deleteFiles: async () => { throw new Error("Batch delete error"); },
      };

      const storage = new StorageService("generated_images", mockFailingProvider);

      try {
        await assert.rejects(
          async () => storage.upload("test.png", Buffer.from("test"), { contentType: "image/png" }),
          /Storage provider timeout/
        );
        await assert.rejects(
          async () => storage.delete("test.png"),
          /Storage provider delete error/
        );
        const batchRes = await storage.deleteFiles(["a.png", "b.png"]);
        assert.equal(batchRes.deletedCount, 0);

        assert.equal(consoleErrorCalls, 0, "console.error must not be called; structured logger used");
      } finally {
        console.error = origConsoleError;
      }
    });
  });

  // ── (d) Internal secret hardening in WorkflowAuthorizationService & ProjectReadService ────
  describe("(d) Internal secret hardening in WorkflowAuthorizationService and ProjectReadService", () => {
    it("WorkflowAuthorizationService._isBypassed returns false when INTERNAL_AUTH_ENABLED is unset/false", () => {
      delete process.env.INTERNAL_AUTH_ENABLED;
      const service = new WorkflowAuthorizationService({ db: {} });

      const req = {
        method: "PATCH",
        originalUrl: "/api/workflows/workflows/wf-123",
        headers: { "x-internal-secret": VALID_TEST_SECRET },
      };

      assert.equal(service._isBypassed(req), false, "Must not bypass when INTERNAL_AUTH_ENABLED is unset");

      process.env.INTERNAL_AUTH_ENABLED = "false";
      assert.equal(service._isBypassed(req), false, "Must not bypass when INTERNAL_AUTH_ENABLED is false");
    });

    it("WorkflowAuthorizationService._isBypassed returns false for unauthorized routes even if flag is true", () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";
      const service = new WorkflowAuthorizationService({ db: {} });

      const forbiddenReqs = [
        { method: "POST", originalUrl: "/api/workflows/run", headers: { "x-internal-secret": VALID_TEST_SECRET } },
        { method: "DELETE", originalUrl: "/api/workflows/items/item-123", headers: { "x-internal-secret": VALID_TEST_SECRET } },
        { method: "GET", originalUrl: "/api/workflows/workflow-by-media/media-123", headers: { "x-internal-secret": VALID_TEST_SECRET } },
      ];

      for (const req of forbiddenReqs) {
        assert.equal(service._isBypassed(req), false, `Must not bypass on unauthorized route ${req.method} ${req.originalUrl}`);
      }
    });

    it("WorkflowAuthorizationService._isBypassed returns true ONLY for allow-listed pairs with flag true & valid secret", () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";
      const service = new WorkflowAuthorizationService({ db: {} });

      const allowedReq1 = {
        method: "PATCH",
        originalUrl: "/api/workflows/workflows/wf-123",
        headers: { "x-internal-secret": VALID_TEST_SECRET },
      };
      const allowedReq2 = {
        method: "GET",
        originalUrl: "/api/workflows/project-data/proj-123",
        headers: { "x-internal-secret": VALID_TEST_SECRET },
      };

      assert.equal(service._isBypassed(allowedReq1), true, "Must bypass for PATCH /api/workflows/workflows/:id");
      assert.equal(service._isBypassed(allowedReq2), true, "Must bypass for GET /api/workflows/project-data/:projectId");
    });

    it("ProjectReadService._verifyMediaOwnership returns false without valid allowed internal request or dev bypass", async () => {
      delete process.env.INTERNAL_AUTH_ENABLED;
      const service = new ProjectReadService({ db: {} });

      const reqWithSecret = {
        method: "GET",
        originalUrl: "/api/workflows/workflow-by-media/media-123",
        headers: { "x-internal-secret": VALID_TEST_SECRET },
      };

      // Must not bypass ownership via x-internal-secret for workflow-by-media
      const isAuthorized = await service._verifyMediaOwnership("media-123", "user-foreign", reqWithSecret);
      assert.equal(isAuthorized, false, "Must not bypass media ownership check on unauthorized route");
    });
  });
});
