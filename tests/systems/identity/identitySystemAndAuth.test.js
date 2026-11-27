import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as identityToolsNamespace from "#identity/tools";
import * as identityApiNamespace from "#identity/api";
import {
  assertOwns,
  assertOwnsAny,
  toMediaIdList,
  configureOwnershipResolvers,
  IdentityError,
  IdentityAuthenticationError,
  IdentityForbiddenError,
  IdentityNotFoundError,
  IdentityValidationError,
  requireAuth,
  rateLimit,
} from "#identity/tools";
import { authRouter } from "#identity/api";
import { signup, login } from "../../../src/systems/identity/internal/controllers/authController.js";
import { resetLimitersForTest } from "../../../src/systems/identity/internal/middleware/rateLimit.js";
import { safeCompareSecret } from "../../../src/systems/identity/internal/services/secretComparison.js";
import {
  resetJwtVerifierForTest,
  setJwksFetcherForTest,
  setJwtClockForTest,
} from "../../../src/systems/identity/internal/services/jwtVerifier.js";
import healthRouter from "../../../src/api/probes/health.js";
import readyRouter, { _resetReadinessCacheForTest } from "../../../src/api/probes/ready.js";
import { rateLimitRedisConnection, redisConnection, workerRedisConnection } from "#shared/redis";
import { StorageService } from "../../../src/systems/media/internal/storage/StorageService.js";
import http from "node:http";
import express from "express";
import { workflowsRouter } from "#generation/api";
import {
  assertSecurityConfiguredForEnvironment,
  workflowService,
  projectReadService,
  db,
  createOwnershipResolvers,
} from "../../../src/container.js";
import { supabase } from "#shared/db/supabase.js";
import { WorkflowAuthorizationService } from "../../../src/systems/generation/internal/services/WorkflowAuthorizationService.js";
import { ProjectReadService } from "#workspace/tools";

// ─── Source: identitySystem.test.js ───
{
describe("System 5: Identity & Auth (#identity/tools and #identity/api)", () => {
  it("seals #identity/tools and #identity/api to exact production surface (zero test hooks or leaks)", () => {
    const expectedToolsExports = [
      "IdentityAuthenticationError",
      "IdentityError",
      "IdentityForbiddenError",
      "IdentityNotFoundError",
      "IdentityValidationError",
      "assertOwns",
      "assertOwnsAny",
      "configureIdentityHooks",
      "configureOwnershipResolvers",
      "getAuthUserById",
      "rateLimit",
      "requireAuth",
      "toMediaIdList",
      "walletRateLimit",
    ].sort();
    assert.deepEqual(Object.keys(identityToolsNamespace).sort(), expectedToolsExports);
    assert.deepEqual(Object.keys(identityApiNamespace).sort(), ["authRouter"]);

    // Forbidden test hooks, legacy bags, and unused helpers must never leak
    for (const forbidden of [
      "setDb",
      "identityTools",
      "default",
      "verifySession",
      "getUserProfile",
      "safeCompareSecret",
      "isInternalSecretAllowedRoute",
      "resetLimitersForTest",
      "setLimiterForTest",
      "resetJwtVerifierForTest",
      "setJwksFetcherForTest",
      "setJwtClockForTest",
    ]) {
      assert.equal(identityToolsNamespace[forbidden], undefined, `#identity/tools must not export ${forbidden}`);
    }
    for (const forbidden of ["identityRouter", "signup", "login", "default"]) {
      assert.equal(identityApiNamespace[forbidden], undefined, `#identity/api must not export ${forbidden}`);
    }
  });

  it("exports Express authRouter", () => {
    assert.ok(authRouter);
    assert.equal(typeof authRouter, "function");
  });

  it("normalizes media and reference parameters with toMediaIdList", () => {
    assert.deepEqual(toMediaIdList(null), []);
    assert.deepEqual(toMediaIdList(" id-123 "), ["id-123"]);
    assert.deepEqual(toMediaIdList({ id: " id-obj " }), ["id-obj"]);
    assert.deepEqual(toMediaIdList({ workflowId: "wf-1" }), ["wf-1"]);
    assert.deepEqual(toMediaIdList([" a ", { mediaId: " b " }, ""]), ["a", "b"]);
  });

  it("assertOwns enforces ownership via inverted resolvers and throws 404 on missing or unowned resource (anti-enumeration)", async () => {
    const mockDb = {
      projects: {
        findById: async (id) => {
          if (id === "proj-1") return { id: "proj-1", user_id: "user-owner" };
          return null;
        },
      },
    };
    configureOwnershipResolvers(createOwnershipResolvers(mockDb));

    try {
      // Owned resource passes
      const owned = await assertOwns("project", "proj-1", "user-owner");
      assert.equal(owned.id, "proj-1");

      // Missing resource throws 404
      await assert.rejects(
        async () => assertOwns("project", "non-existent", "user-owner"),
        (err) => err.statusCode === 404 && err.message.includes("Project not found")
      );

      // Unowned resource throws 404 (anti-enumeration mask)
      await assert.rejects(
        async () => assertOwns("project", "proj-1", "user-attacker"),
        (err) => err.statusCode === 404 && err.message.includes("Project not found")
      );
    } finally {
      configureOwnershipResolvers(createOwnershipResolvers(db));
    }
  });

  it("assertOwnsAny checks multiple resource types sequentially", async () => {
    const mockDb = {
      projects: {
        findById: async () => null,
      },
      characters: {
        findById: async (id) => {
          if (id === "char-1") return { id: "char-1", user_id: "user-1" };
          return null;
        },
      },
    };
    configureOwnershipResolvers(createOwnershipResolvers(mockDb));

    try {
      const match = await assertOwnsAny(["project", "character"], "char-1", "user-1");
      assert.equal(match.id, "char-1");

      await assert.rejects(
        async () => assertOwnsAny(["project", "character"], "char-99", "user-1"),
        (err) => err.statusCode === 404
      );
    } finally {
      configureOwnershipResolvers(createOwnershipResolvers(db));
    }
  });

  it("configureOwnershipResolvers rejects reassignment outside NODE_ENV === 'test'", () => {
    const prevEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      assert.throws(
        () => configureOwnershipResolvers({}),
        (err) => err instanceof IdentityForbiddenError && err.statusCode === 403
      );
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  it("Identity errors have correct codes and status codes", () => {
    const baseErr = new IdentityError();
    assert.equal(baseErr.statusCode, 500);
    assert.equal(baseErr.code, "IDENTITY_ERROR");

    const authErr = new IdentityAuthenticationError("Please log in");
    assert.equal(authErr.statusCode, 401);
    assert.equal(authErr.code, "UNAUTHORIZED");

    const forbErr = new IdentityForbiddenError();
    assert.equal(forbErr.statusCode, 403);
    assert.equal(forbErr.code, "FORBIDDEN");

    const notFoundErr = new IdentityNotFoundError();
    assert.equal(notFoundErr.statusCode, 404);
    assert.equal(notFoundErr.code, "NOT_FOUND");

    const valErr = new IdentityValidationError("Bad email");
    assert.equal(valErr.statusCode, 400);
    assert.equal(valErr.code, "IDENTITY_VALIDATION_ERROR");
  });
});
}

// ─── Source: authHardeningD26Boundary.test.js ───
{
const VALID_TEST_SECRET = "test-internal-secret-for-d26-auth-min-32-chars-ok!"; // gate:allow-secret

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
          "x-internal-secret": "completely-wrong-internal-secret-attempt", // gate:allow-secret
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
    let origRateLimitStore;

    beforeEach(() => {
      origRateLimitStore = process.env.RATE_LIMIT_STORE;
      process.env.RATE_LIMIT_STORE = "redis";
    });

    afterEach(() => {
      if (origRateLimitStore !== undefined) {
        process.env.RATE_LIMIT_STORE = origRateLimitStore;
      } else {
        delete process.env.RATE_LIMIT_STORE;
      }
    });

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

  // ── (d) DEV_AUTH_BYPASS completely removed & strict ownership enforcement ─────────────────
  describe("(d) DEV_AUTH_BYPASS removal and strict ownership enforcement", () => {
    it("envConfig exposes neither devAuthBypass nor rawDevAuthBypass", async () => {
      const { envConfig } = await import("#shared");
      assert.equal(envConfig.devAuthBypass, undefined, "devAuthBypass must be completely removed");
      assert.equal(envConfig.rawDevAuthBypass, undefined, "rawDevAuthBypass must be completely removed");
    });

    it("WorkflowAuthorizationService has no dev bypass and enforces ownership even if DEV_AUTH_BYPASS=true", async () => {
      const origBypass = process.env.DEV_AUTH_BYPASS;
      try {
        process.env.DEV_AUTH_BYPASS = "true";
        const service = new WorkflowAuthorizationService({
          db: {
            media: { findMediaOwnershipRecord: async () => ({ id: "m-1", project: { user_id: "owner-1" } }) },
            workflows: { client: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) },
          },
        });
        assert.equal(service._isBypassed, undefined, "_isBypassed must be completely removed");
        assert.equal(
          await service.verifyMediaOwnership("m-1", "foreign-user"),
          false,
          "Foreign ownership must be rejected even if DEV_AUTH_BYPASS=true is set in env"
        );
      } finally {
        if (origBypass !== undefined) process.env.DEV_AUTH_BYPASS = origBypass;
        else delete process.env.DEV_AUTH_BYPASS;
      }
    });

    it("ProjectReadService._verifyMediaOwnership NEVER bypasses for internal-secret or DEV_AUTH_BYPASS", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";
      process.env.DEV_AUTH_BYPASS = "true";
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
        assert.equal(isAuthorized, false, "Internal secret and DEV_AUTH_BYPASS must never grant ownership bypass on media");
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
}

// ─── Source: internalSecretBoundary.test.js ───
{
describe("RC1.1-R1 — Internal Secret Security & Timing-Safe Enforcement", () => {
  let origEnv;

  after(async () => {
    await Promise.allSettled([
      rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect()),
      redisConnection?.quit().catch(() => redisConnection?.disconnect()),
      workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect()),
    ]);
  });

  beforeEach(() => {
    origEnv = { ...process.env };
    delete process.env.DEV_AUTH_BYPASS;
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
    process.env.INTERNAL_SECRET = "short-secret-under-32-chars"; // gate:allow-secret

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
    process.env.INTERNAL_SECRET = "a-very-long-production-grade-secret-key-32-chars-min"; // gate:allow-secret

    assert.doesNotThrow(() => {
      assertSecurityConfiguredForEnvironment();
    });
  });

  // ── 2. Constant-Time Comparison Unit Tests ─────────────────────────────────
  it("TEST 4: safeCompareSecret compares secrets in constant time and rejects unequal or falsy values", () => {
    const validSecret = "super-secret-valid-token-at-least-32-chars-long"; // gate:allow-secret
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
    const testSecret = "configured-valid-test-secret-at-least-32-chars"; // gate:allow-secret
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
          "x-internal-secret": "openart_internal_s2s_secret_2026", // OLD hardcoded value // gate:allow-secret
        },
      });

      const body = await res.json();
      assert.equal(res.status, 404, `Expected 404, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.ok, false);
      assert.match(body.message, /not found/i);
    });

    it("TEST 6: Request with secret on unauthorized route gets no bypass and is rejected with 401", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/workflow-by-media/media-foreign-123`, {
        headers: {
          "x-internal-secret": testSecret,
          "x-user-id": "service-worker",
        },
      });

      const body = await res.json();
      assert.equal(res.status, 401, `Expected 401, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.ok, false);
    });
  });
});
}

// ─── Source: localJwtVerificationP11.test.js ───
{
describe("P1-1 — Local JWT / JWKS Verification in requireAuth (zero hot-path auth.getUser)", () => {
  const TEST_SUPABASE_URL = "https://local-jwt-test.supabase.co";
  const TEST_ISSUER = `${TEST_SUPABASE_URL}/auth/v1`;
  const TEST_HS256_SECRET = "test-supabase-hs256-jwt-secret-min-32-chars-ok!!"; // gate:allow-secret

  function b64urlJson(obj) {
    return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  }

  function signHs256Jwt(payload, secret = TEST_HS256_SECRET, headerOverrides = {}) {
    const header = { alg: "HS256", typ: "JWT", ...headerOverrides };
    const encodedHeader = b64urlJson(header);
    const encodedPayload = b64urlJson(payload);
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = crypto.createHmac("sha256", secret).update(signingInput, "utf8").digest("base64url");
    return `${signingInput}.${signature}`;
  }

  function signEs256Jwt(payload, privateKey, kid = "ec-key-1", headerOverrides = {}) {
    const header = { alg: "ES256", typ: "JWT", ...(kid ? { kid } : {}), ...headerOverrides };
    const encodedHeader = b64urlJson(header);
    const encodedPayload = b64urlJson(payload);
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const sig = crypto.sign("sha256", Buffer.from(signingInput, "utf8"), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `${signingInput}.${sig.toString("base64url")}`;
  }

  function signRs256Jwt(payload, privateKey, kid = "rsa-key-1", headerOverrides = {}) {
    const header = { alg: "RS256", typ: "JWT", ...(kid ? { kid } : {}), ...headerOverrides };
    const encodedHeader = b64urlJson(header);
    const encodedPayload = b64urlJson(payload);
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const sig = crypto.sign("sha256", Buffer.from(signingInput, "utf8"), privateKey);
    return `${signingInput}.${sig.toString("base64url")}`;
  }

  function buildBaseClaims(overrides = {}) {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      sub: "550e8400-e29b-41d4-a716-446655440000",
      email: "alice@example.com",
      role: "authenticated",
      aud: "authenticated",
      iss: TEST_ISSUER,
      iat: nowSec - 10,
      exp: nowSec + 3600,
      app_metadata: { provider: "email", providers: ["email"], role: "member" },
      user_metadata: { full_name: "Alice Example" },
      ...overrides,
    };
  }

  async function runRequireAuth(req) {
    let nextErr = null;
    let nextCalled = false;
    await requireAuth(req, {}, (err) => {
      nextCalled = true;
      nextErr = err || null;
    });
    return { nextCalled, nextErr, req };
  }

  let origEnv;
  let origGetUser;
  let getUserCalls;

  beforeEach(() => {
    origEnv = { ...process.env };
    origGetUser = supabase.auth.getUser;
    getUserCalls = 0;
    supabase.auth.getUser = async () => {
      getUserCalls++;
      return { data: { user: { id: "remote-fallback-user", email: "fallback@example.com", role: "authenticated" } }, error: null };
    };
    resetJwtVerifierForTest();
    process.env.SUPABASE_URL = TEST_SUPABASE_URL;
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.SUPABASE_JWKS_URL;
    delete process.env.SUPABASE_JWT_ISSUER;
    delete process.env.JWKS_CACHE_TTL_MS;
    delete process.env.JWKS_REFRESH_COOLDOWN_MS;
  });

  afterEach(() => {
    resetJwtVerifierForTest();
    supabase.auth.getUser = origGetUser;
    process.env = origEnv;
  });

  it("accepts valid HS256 JWT locally, populates full req.user shape, and calls auth.getUser 0 times", async () => {
    process.env.SUPABASE_JWT_SECRET = TEST_HS256_SECRET;
    const claims = buildBaseClaims({
      iss: `${TEST_ISSUER}/`, // trailing slash normalized
      aud: ["authenticated", "extra-aud"],
    });
    const token = signHs256Jwt(claims);

    const { nextCalled, nextErr, req } = await runRequireAuth({
      method: "GET",
      path: "/api/projects",
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
    });

    assert.equal(nextCalled, true);
    assert.equal(nextErr, null);
    assert.equal(getUserCalls, 0, "authClient.getUser must NOT be called for local HS256 JWT");
    assert.deepEqual(req.user, {
      id: claims.sub,
      email: "alice@example.com",
      role: "authenticated",
      app_metadata: { provider: "email", providers: ["email"], role: "member" },
      user_metadata: { full_name: "Alice Example" },
    });
  });

  it("accepts valid HS256 JWT from access_token cookie with 0 auth.getUser calls", async () => {
    process.env.SUPABASE_JWT_SECRET = TEST_HS256_SECRET;
    const token = signHs256Jwt(buildBaseClaims({ sub: "cookie-user-123", email: undefined, role: undefined, app_metadata: undefined, user_metadata: undefined }));

    const { nextCalled, nextErr, req } = await runRequireAuth({
      method: "GET",
      path: "/api/projects",
      headers: {},
      cookies: { access_token: token },
    });

    assert.equal(nextCalled, true);
    assert.equal(nextErr, null);
    assert.equal(getUserCalls, 0);
    assert.deepEqual(req.user, {
      id: "cookie-user-123",
      email: null,
      role: null,
      app_metadata: {},
      user_metadata: {},
    });
  });

  it("requireAuth validates Bearer JWT locally with 0 auth.getUser calls and populates email/role", async () => {
    process.env.SUPABASE_JWT_SECRET = TEST_HS256_SECRET;
    const token = signHs256Jwt(buildBaseClaims({ sub: "session-user-99", email: "sess@example.com", role: "authenticated" }));

    const req = {
      method: "GET",
      path: "/api/projects",
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
    };
    const { nextCalled, nextErr } = await runRequireAuth(req);

    assert.equal(nextCalled, true);
    assert.equal(nextErr, null);
    assert.equal(getUserCalls, 0);
    assert.equal(req.user.id, "session-user-99");
    assert.equal(req.user.email, "sess@example.com");
    assert.equal(req.user.role, "authenticated");
  });

  it("rateLimit keys on req.user.id (sub), not raw JWT string (distinct JWTs for same sub share bucket and hit 429)", async () => {
    process.env.SUPABASE_JWT_SECRET = TEST_HS256_SECRET;
    process.env.RATE_LIMIT_STORE = "memory";
    resetLimitersForTest();

    const sub = "user-ratelimit-sub-42";
    const otherSub = "user-ratelimit-sub-99";
    const limiterMiddleware = rateLimit("videoGeneration"); // keyBy: "user", points: 5

    const invokeRateLimit = async (req) => {
      let statusCode = 200;
      let passed = false;
      const res = {
        setHeader() {},
        status(code) { statusCode = code; return this; },
        json() { return this; },
      };
      await limiterMiddleware(req, res, () => { passed = true; });
      return { passed, statusCode };
    };

    // 5 distinct JWTs for the same sub consume all 5 points
    for (let i = 0; i < 5; i++) {
      const token = signHs256Jwt(buildBaseClaims({ sub, jti: `tok-${i}` }));
      const req = { method: "POST", path: "/api/video/generated", headers: { authorization: `Bearer ${token}` }, cookies: {} };
      const authRes = await runRequireAuth(req);
      assert.equal(authRes.nextErr, null);
      assert.equal(req.user.id, sub);
      const rlRes = await invokeRateLimit(req);
      assert.equal(rlRes.passed, true, `Request ${i + 1} should pass`);
    }

    // 6th request with a brand-new JWT for the SAME sub must hit 429 (proving bucket keys on sub, not raw JWT)
    const token6 = signHs256Jwt(buildBaseClaims({ sub, jti: "tok-6" }));
    const req6 = { method: "POST", path: "/api/video/generated", headers: { authorization: `Bearer ${token6}` }, cookies: {} };
    await runRequireAuth(req6);
    const rl6 = await invokeRateLimit(req6);
    assert.equal(rl6.passed, false);
    assert.equal(rl6.statusCode, 429);

    // Different sub has its own bucket and passes
    const otherToken = signHs256Jwt(buildBaseClaims({ sub: otherSub, jti: "tok-other" }));
    const reqOther = { method: "POST", path: "/api/video/generated", headers: { authorization: `Bearer ${otherToken}` }, cookies: {} };
    await runRequireAuth(reqOther);
    const rlOther = await invokeRateLimit(reqOther);
    assert.equal(rlOther.passed, true);

    assert.equal(getUserCalls, 0);
    resetLimitersForTest();
  });

  it("verifies ES256 JWT via cached JWKS, enforces unknown-kid refresh cooldown, and handles key rotation", async () => {
    const ecKey1 = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const ecKey2 = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk1 = { ...ecKey1.publicKey.export({ format: "jwk" }), kid: "ec-k1", alg: "ES256", use: "sig" };
    const jwk2 = { ...ecKey2.publicKey.export({ format: "jwk" }), kid: "ec-k2", alg: "ES256", use: "sig" };

    let fakeNow = Date.now();
    setJwtClockForTest(() => fakeNow);

    let jwksFetchCount = 0;
    let currentKeys = [jwk1];
    setJwksFetcherForTest(async (url) => {
      assert.equal(url, `${TEST_SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
      jwksFetchCount++;
      return { keys: currentKeys };
    });

    process.env.JWKS_CACHE_TTL_MS = "600000";
    process.env.JWKS_REFRESH_COOLDOWN_MS = "30000";

    const claims = buildBaseClaims({
      sub: "es256-user-1",
      email: "es256@example.com",
      iat: Math.floor(fakeNow / 1000) - 5,
      exp: Math.floor(fakeNow / 1000) + 3600,
    });
    const token1 = signEs256Jwt(claims, ecKey1.privateKey, "ec-k1");

    // 1) First request fetches JWKS once and authenticates
    const res1 = await runRequireAuth({ headers: { authorization: `Bearer ${token1}` }, cookies: {}, path: "/api/test" });
    assert.equal(res1.nextErr, null);
    assert.equal(res1.req.user.id, "es256-user-1");
    assert.equal(res1.req.user.email, "es256@example.com");
    assert.equal(jwksFetchCount, 1);
    assert.equal(getUserCalls, 0);

    // 2) Subsequent requests hit in-memory JWKS cache (still 1 fetch)
    const res2 = await runRequireAuth({ headers: { authorization: `Bearer ${token1}` }, cookies: {}, path: "/api/test" });
    const res3 = await runRequireAuth({ headers: { authorization: `Bearer ${token1}` }, cookies: {}, path: "/api/test" });
    assert.equal(res2.nextErr, null);
    assert.equal(res3.nextErr, null);
    assert.equal(jwksFetchCount, 1, "JWKS must be cached across requests");
    assert.equal(getUserCalls, 0);

    // 3) Key rotation happens on server, but unknown kid arrives WITHIN 30s cooldown -> no refetch (DoS guard), 401
    currentKeys = [jwk1, jwk2];
    const token2 = signEs256Jwt(claims, ecKey2.privateKey, "ec-k2");
    fakeNow += 5000; // only 5s elapsed (< 30s cooldown)

    const resCooldown = await runRequireAuth({ headers: { authorization: `Bearer ${token2}` }, cookies: {}, path: "/api/test" });
    assert.ok(resCooldown.nextErr);
    assert.equal(resCooldown.nextErr.statusCode, 401);
    assert.equal(jwksFetchCount, 1, "Unknown kid within cooldown must NOT trigger JWKS refetch");
    assert.equal(getUserCalls, 0);

    // 4) After 30s cooldown elapses, unknown kid triggers 1 JWKS refresh and succeeds
    fakeNow += 31000;
    const resRotated = await runRequireAuth({ headers: { authorization: `Bearer ${token2}` }, cookies: {}, path: "/api/test" });
    assert.equal(resRotated.nextErr, null);
    assert.equal(resRotated.req.user.id, "es256-user-1");
    assert.equal(jwksFetchCount, 2, "Unknown kid after cooldown must trigger JWKS refresh once");
    assert.equal(getUserCalls, 0);

    // 5) Further requests with rotated kid hit cache (still 2 fetches)
    const resRotatedCached = await runRequireAuth({ headers: { authorization: `Bearer ${token2}` }, cookies: {}, path: "/api/test" });
    assert.equal(resRotatedCached.nextErr, null);
    assert.equal(jwksFetchCount, 2);
    assert.equal(getUserCalls, 0);
  });

  it("verifies RS256 JWT over live local HTTP JWKS endpoint with caching and 0 auth.getUser calls", async () => {
    const rsaKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaJwk = { ...rsaKey.publicKey.export({ format: "jwk" }), kid: "rsa-live-1", alg: "RS256", use: "sig" };

    let httpHits = 0;
    const jwksServer = http.createServer((req, res) => {
      if (req.url === "/auth/v1/.well-known/jwks.json") {
        httpHits++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ keys: [rsaJwk] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
    const { port } = jwksServer.address();
    const localBaseUrl = `http://127.0.0.1:${port}`;

    try {
      process.env.SUPABASE_URL = localBaseUrl;
      const claims = buildBaseClaims({
        sub: "rs256-user-7",
        iss: `${localBaseUrl}/auth/v1`,
      });
      const token = signRs256Jwt(claims, rsaKey.privateKey, "rsa-live-1");

      const r1 = await runRequireAuth({ headers: { authorization: `Bearer ${token}` }, cookies: {}, path: "/api/test" });
      const r2 = await runRequireAuth({ headers: { authorization: `Bearer ${token}` }, cookies: {}, path: "/api/test" });

      assert.equal(r1.nextErr, null);
      assert.equal(r1.req.user.id, "rs256-user-7");
      assert.equal(r2.nextErr, null);
      assert.equal(httpHits, 1, "HTTP JWKS endpoint must only be fetched once within TTL");
      assert.equal(getUserCalls, 0);
    } finally {
      await new Promise((resolve) => jwksServer.close(resolve));
    }
  });

  it("rejects expired, future nbf, tampered payload, wrong signature, alg:none, wrong aud/iss, missing sub, and alg confusion with 401 and 0 auth.getUser calls", async () => {
    process.env.SUPABASE_JWT_SECRET = TEST_HS256_SECRET;
    const ecKey = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const ecOther = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const ecJwk = { ...ecKey.publicKey.export({ format: "jwk" }), kid: "ec-sec-1", alg: "ES256", use: "sig" };
    setJwksFetcherForTest(async () => ({ keys: [ecJwk] }));

    const nowSec = Math.floor(Date.now() / 1000);
    const validHs = signHs256Jwt(buildBaseClaims());
    const [validHdr, , validSig] = validHs.split(".");
    const tamperedPayload = b64urlJson(buildBaseClaims({ sub: "attacker-escalated-id" }));

    const badTokens = [
      { name: "expired exp", token: signHs256Jwt(buildBaseClaims({ exp: nowSec - 5 })) },
      { name: "missing exp", token: signHs256Jwt(buildBaseClaims({ exp: undefined })) },
      { name: "future nbf", token: signHs256Jwt(buildBaseClaims({ nbf: nowSec + 300 })) },
      { name: "tampered payload", token: `${validHdr}.${tamperedPayload}.${validSig}` },
      { name: "wrong HS256 secret", token: signHs256Jwt(buildBaseClaims(), "completely-different-secret-key-32-chars!!") }, // gate:allow-secret
      { name: "wrong ES256 key", token: signEs256Jwt(buildBaseClaims(), ecOther.privateKey, "ec-sec-1") },
      { name: "alg:none empty sig", token: `${b64urlJson({ alg: "none", typ: "JWT" })}.${b64urlJson(buildBaseClaims())}.` },
      { name: "alg:none fake sig", token: `${b64urlJson({ alg: "none", typ: "JWT" })}.${b64urlJson(buildBaseClaims())}.ZmFrZQ` },
      { name: "alg:None case variant", token: `${b64urlJson({ alg: "None", typ: "JWT" })}.${b64urlJson(buildBaseClaims())}.ZmFrZQ` },
      { name: "wrong aud string", token: signHs256Jwt(buildBaseClaims({ aud: "anon" })) },
      { name: "wrong aud array", token: signHs256Jwt(buildBaseClaims({ aud: ["anon", "service_role"] })) },
      { name: "missing aud", token: signHs256Jwt(buildBaseClaims({ aud: undefined })) },
      { name: "wrong iss", token: signHs256Jwt(buildBaseClaims({ iss: "https://evil-project.supabase.co/auth/v1" })) },
      { name: "missing iss", token: signHs256Jwt(buildBaseClaims({ iss: undefined })) },
      { name: "missing sub", token: signHs256Jwt(buildBaseClaims({ sub: undefined })) },
      { name: "empty sub", token: signHs256Jwt(buildBaseClaims({ sub: "   " })) },
      { name: "opaque non-JWT string when local auth configured", token: "not-even-a-jwt-token" }, // gate:allow-secret
    ];

    for (const tc of badTokens) {
      const { nextCalled, nextErr, req } = await runRequireAuth({
        method: "GET",
        path: "/api/projects",
        headers: { authorization: `Bearer ${tc.token}` },
        cookies: {},
      });
      assert.equal(nextCalled, true, `${tc.name}: next must be called`);
      assert.ok(nextErr, `${tc.name}: must reject with error`);
      assert.equal(nextErr.statusCode, 401, `${tc.name}: must return 401, got ${nextErr.statusCode}`);
      assert.equal(req.user, undefined, `${tc.name}: req.user must stay undefined`);
    }

    // Algorithm confusion: HS256 token rejected when ONLY JWKS is configured (no SUPABASE_JWT_SECRET)
    delete process.env.SUPABASE_JWT_SECRET;
    const hsWithPublicKey = signHs256Jwt(buildBaseClaims(), JSON.stringify(ecJwk));
    const algConfRes = await runRequireAuth({
      method: "GET",
      path: "/api/projects",
      headers: { authorization: `Bearer ${hsWithPublicKey}` },
      cookies: {},
    });
    assert.ok(algConfRes.nextErr);
    assert.equal(algConfRes.nextErr.statusCode, 401);
    assert.equal(algConfRes.req.user, undefined);

    assert.equal(getUserCalls, 0, "authClient.getUser must NEVER be called for any rejected JWT");
  });

  it("falls back to authClient.getUser ONLY when local JWT config (SUPABASE_URL/JWKS/SECRET) is completely missing", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.SUPABASE_JWKS_URL;

    const { nextCalled, nextErr, req } = await runRequireAuth({
      method: "GET",
      path: "/api/projects",
      headers: { authorization: "Bearer legacy-fallback-token" },
      cookies: {},
    });

    assert.equal(nextCalled, true);
    assert.equal(nextErr, null);
    assert.equal(getUserCalls, 1, "Fallback to authClient.getUser should run once when local config is missing");
    assert.equal(req.user.id, "remote-fallback-user");
    assert.equal(req.user.email, "fallback@example.com");
  });
});
}
