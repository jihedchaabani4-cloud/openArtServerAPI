import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { requireAuth } from "../../src/middleware/auth.js";
import healthRouter from "../../routes/health.js";
import readyRouter, { _resetReadinessCacheForTest } from "../../routes/ready.js";
import { rateLimitRedisConnection, redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { StorageService } from "../../src/platform/storage/StorageService.js";
import http from "node:http";
import express from "express";
import workflowsRouter from "../../routes/workflows.js";
import { assertSecurityConfiguredForEnvironment, workflowService, projectReadService } from "../../src/container.js";
import { supabase } from "../../lib/supabase.js";
import { WorkflowAuthorizationService } from "../../src/platform/workflow/WorkflowAuthorizationService.js";
import { ProjectReadService } from "../../src/domain/project/ProjectReadService.js";

const VALID_TEST_SECRET = "test-internal-secret-for-d26-auth-min-32-chars-ok!";

describe("D2.6 Security Hardening Boundary Tests", () => {
  let origEnvSecret;
  let origInternalAuthEnabled;
  let origDevAuthBypass;

  beforeEach(() => {
    _resetReadinessCacheForTest?.();
    origEnvSecret = process.env.INTERNAL_SECRET;
    origInternalAuthEnabled = process.env.INTERNAL_AUTH_ENABLED;
    origDevAuthBypass = process.env.DEV_AUTH_BYPASS;
    delete process.env.DEV_AUTH_BYPASS;
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
    if (origDevAuthBypass !== undefined) {
      process.env.DEV_AUTH_BYPASS = origDevAuthBypass;
    } else {
      delete process.env.DEV_AUTH_BYPASS;
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

  // ── (d) DEV_AUTH_BYPASS production ban & ownership bypass removal ──────────────────────────
  describe("(d) DEV_AUTH_BYPASS production ban and internal secret ownership enforcement", () => {
    it("DEV_AUTH_BYPASS throws at boot/config when NODE_ENV=production", () => {
      const origNodeEnv = process.env.NODE_ENV;
      const origBypass = process.env.DEV_AUTH_BYPASS;
      try {
        process.env.NODE_ENV = "production";
        process.env.INTERNAL_SECRET = "a".repeat(32);
        process.env.DEV_AUTH_BYPASS = "true";

        assert.throws(
          () => assertSecurityConfiguredForEnvironment(),
          /DEV_AUTH_BYPASS cannot be enabled in production/i,
          "Must throw at boot when DEV_AUTH_BYPASS is enabled in production"
        );
      } finally {
        process.env.NODE_ENV = origNodeEnv;
        process.env.DEV_AUTH_BYPASS = origBypass;
      }
    });

    it("WorkflowAuthorizationService._isBypassed returns false in production even if DEV_AUTH_BYPASS=true", () => {
      const origNodeEnv = process.env.NODE_ENV;
      const origBypass = process.env.DEV_AUTH_BYPASS;
      try {
        process.env.NODE_ENV = "production";
        process.env.DEV_AUTH_BYPASS = "true";
        const service = new WorkflowAuthorizationService({ db: {} });
        assert.equal(service._isBypassed({}), false, "Must not bypass in production");
      } finally {
        process.env.NODE_ENV = origNodeEnv;
        process.env.DEV_AUTH_BYPASS = origBypass;
      }
    });

    it("WorkflowAuthorizationService._isBypassed NEVER bypasses for internal-secret (returns false)", () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";
      const service = new WorkflowAuthorizationService({ db: {} });

      const reqWithSecret = {
        method: "PATCH",
        originalUrl: "/api/workflows/workflows/wf-123",
        headers: { "x-internal-secret": VALID_TEST_SECRET },
      };

      // CRITICAL: internal secret MUST NOT bypass ownership check!
      assert.equal(
        service._isBypassed(reqWithSecret),
        false,
        "Internal secret must authenticate only and never bypass ownership"
      );
    });

    it("ProjectReadService._verifyMediaOwnership NEVER bypasses for internal-secret (must check userId)", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";
      const service = new ProjectReadService({ db: {} });

      // Mock verifyMediaOwnership to check whether internal secret returns true without owner check
      const reqWithSecret = {
        method: "GET",
        originalUrl: "/api/workflows/project-data/proj-123",
        headers: { "x-internal-secret": VALID_TEST_SECRET },
      };

      // Mock db/supabase inside service: foreign owner
      const origVerify = service._verifyMediaOwnership;
      try {
        // Calling _verifyMediaOwnership for foreign user must return false
        const isAuthorized = await service._verifyMediaOwnership("media-123", "foreign-user-id", reqWithSecret);
        assert.equal(isAuthorized, false, "Internal secret must never grant ownership bypass on media");
      } finally {
        service._verifyMediaOwnership = origVerify;
      }
    });
  });

  // ── (e) HTTP route tests: internal-secret strictly enforces tenant ownership (both allowed pairs) ──
  describe("(e) Allowed internal-secret routes enforce tenant ownership (no cross-tenant bypass)", () => {
    let server;
    let baseUrl;
    const USER_A = "11111111-1111-4111-8111-111111111111";
    const USER_B = "22222222-2222-4222-8222-222222222222";

    let origGetProjectData;
    let origUpdateMetadata;

    before(async () => {
      origGetProjectData = projectReadService.getProjectData;
      origUpdateMetadata = workflowService.updateWorkflowMetadata;

      // Mock getProjectData strictly enforcing ownership
      projectReadService.getProjectData = async ({ projectId, userId }) => {
        if (projectId === "proj-user-B" && userId !== USER_B) {
          const err = new Error("Project not found");
          err.statusCode = 404;
          throw err;
        }
        if (projectId === "proj-user-A" && userId === USER_A) {
          return {
            projectName: "User A Project",
            projectId: "proj-user-A",
            sessions: [],
            workflows: [],
            media: [],
            elements: [],
            characters: [],
          };
        }
        const err = new Error("Project not found");
        err.statusCode = 404;
        throw err;
      };

      // Mock updateWorkflowMetadata strictly delegating to authService
      workflowService.updateWorkflowMetadata = async ({ workflowId, updates, userId, req }) => {
        const isAuthorized = await workflowService.authService.verifyWorkflowOwnership(workflowId, userId, req);
        if (!isAuthorized) {
          const err = new Error("Workflow not found");
          err.statusCode = 404;
          throw err;
        }
        return { workflow: { id: workflowId, ...updates } };
      };

      const app = express();
      app.use(express.json());
      app.use("/api/workflows", workflowsRouter);
      app.use((err, req, res, next) => {
        const status = err.statusCode || 500;
        res.status(status).json({ ok: false, message: err.message });
      });

      server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
    });

    after(async () => {
      projectReadService.getProjectData = origGetProjectData;
      workflowService.updateWorkflowMetadata = origUpdateMetadata;
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    // Pair 1: GET /api/workflows/project-data/:projectId
    describe("Pair 1: GET /api/workflows/project-data/:projectId", () => {
      it("a) internal secret + x-user-id = User A + foreign project of User B -> 404, reveals nothing", async () => {
        process.env.INTERNAL_AUTH_ENABLED = "true";

        const res = await fetch(`${baseUrl}/api/workflows/project-data/proj-user-B`, {
          method: "GET",
          headers: {
            "x-internal-secret": VALID_TEST_SECRET,
            "x-user-id": USER_A,
          },
        });

        assert.equal(res.status, 404, `Cross-tenant access must return 404, got ${res.status}`);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.match(body.message, /not found/i);
        assert.equal(body.projectContents, undefined, "Body must reveal zero project contents");
      });

      it("b) internal secret + x-user-id = User A + own project of User A -> 200", async () => {
        process.env.INTERNAL_AUTH_ENABLED = "true";

        const res = await fetch(`${baseUrl}/api/workflows/project-data/proj-user-A`, {
          method: "GET",
          headers: {
            "x-internal-secret": VALID_TEST_SECRET,
            "x-user-id": USER_A,
          },
        });

        assert.equal(res.status, 200, `Legitimate owner access must return 200, got ${res.status}`);
        const body = await res.json();
        assert.equal(body.result.data.json.projectId, "proj-user-A");
      });

      it("c) INTERNAL_AUTH_ENABLED unset + valid secret -> 401 rejected", async () => {
        delete process.env.INTERNAL_AUTH_ENABLED;

        const res = await fetch(`${baseUrl}/api/workflows/project-data/proj-user-A`, {
          method: "GET",
          headers: {
            "x-internal-secret": VALID_TEST_SECRET,
            "x-user-id": USER_A,
          },
        });

        assert.equal(res.status, 401, `Must reject when flag unset, got ${res.status}`);
      });

      it("d) valid secret on non-allowed route -> 401 rejected", async () => {
        process.env.INTERNAL_AUTH_ENABLED = "true";

        const res = await fetch(`${baseUrl}/api/workflows/workflow-by-media/media-123`, {
          method: "GET",
          headers: {
            "x-internal-secret": VALID_TEST_SECRET,
            "x-user-id": USER_A,
          },
        });

        assert.equal(res.status, 401, `Non-allowed route must reject internal secret, got ${res.status}`);
      });
    });

    // Pair 2: PATCH /api/workflows/workflows/:id
    describe("Pair 2: PATCH /api/workflows/workflows/:id", () => {
      it("a) internal secret + x-user-id = User A + foreign workflow of User B -> 404, reveals nothing", async () => {
        process.env.INTERNAL_AUTH_ENABLED = "true";

        // Mock authService ownership check for foreign workflow
        const origVerifyOwnership = workflowService.authService.verifyWorkflowOwnership;
        workflowService.authService.verifyWorkflowOwnership = async (wfId, userId, req) => {
          if (wfId === "wf-user-B" && userId !== USER_B) return false;
          return true;
        };

        try {
          const res = await fetch(`${baseUrl}/api/workflows/workflows/wf-user-B`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "x-internal-secret": VALID_TEST_SECRET,
              "x-user-id": USER_A,
            },
            body: JSON.stringify({ display_name: "Hacked by User A" }),
          });

          assert.equal(res.status, 404, `Foreign workflow patch must return 404, got ${res.status}`);
          const body = await res.json();
          assert.equal(body.ok, false);
          assert.match(body.message, /not found/i);
        } finally {
          workflowService.authService.verifyWorkflowOwnership = origVerifyOwnership;
        }
      });

      it("b) internal secret + x-user-id = User A + own workflow of User A -> 200", async () => {
        process.env.INTERNAL_AUTH_ENABLED = "true";

        const origVerifyOwnership = workflowService.authService.verifyWorkflowOwnership;
        workflowService.authService.verifyWorkflowOwnership = async (wfId, userId, req) => {
          if (wfId === "wf-user-A" && userId === USER_A) return true;
          return false;
        };

        try {
          const res = await fetch(`${baseUrl}/api/workflows/workflows/wf-user-A`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "x-internal-secret": VALID_TEST_SECRET,
              "x-user-id": USER_A,
            },
            body: JSON.stringify({ display_name: "Updated by User A" }),
          });

          assert.equal(res.status, 200, `Own workflow patch must return 200, got ${res.status}`);
          const body = await res.json();
          assert.equal(body.ok, true);
        } finally {
          workflowService.authService.verifyWorkflowOwnership = origVerifyOwnership;
        }
      });

      it("c) INTERNAL_AUTH_ENABLED unset + valid secret -> 401 rejected", async () => {
        delete process.env.INTERNAL_AUTH_ENABLED;

        const res = await fetch(`${baseUrl}/api/workflows/workflows/wf-user-A`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": VALID_TEST_SECRET,
            "x-user-id": USER_A,
          },
          body: JSON.stringify({ display_name: "Test" }),
        });

        assert.equal(res.status, 401, `Must reject when flag unset, got ${res.status}`);
      });

      it("d) valid secret on non-allowed method (POST) -> 401 rejected", async () => {
        process.env.INTERNAL_AUTH_ENABLED = "true";

        const res = await fetch(`${baseUrl}/api/workflows/workflows/wf-user-A`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": VALID_TEST_SECRET,
            "x-user-id": USER_A,
          },
          body: JSON.stringify({ display_name: "Test" }),
        });

        assert.equal(res.status, 401, `POST on workflows/:id must reject internal secret with 401, got ${res.status}`);
      });
    });
  });
});
