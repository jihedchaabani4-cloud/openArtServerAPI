import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { requireAuth } from "../../src/middleware/auth.js";
import healthRouter from "../../routes/health.js";
import readyRouter from "../../routes/ready.js";
import { rateLimitRedisConnection, redisConnection, workerRedisConnection } from "../../src/queue/redis.js";

const VALID_TEST_SECRET = "test-internal-secret-for-d26-auth-min-32-chars-ok!";

describe("D2.6 Security Hardening Boundary Tests", () => {
  let origEnvSecret;
  let origInternalAuthEnabled;

  beforeEach(() => {
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

  // ── (a) auth.js internal secret restrictions ──────────────────────────────
  describe("(a) Internal secret restricted to exact allow-listed pairs & disabled by default", () => {
    it("TEST D2.6-a1: when INTERNAL_AUTH_ENABLED is unset, secret is ignored even for allow-listed pair", async () => {
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

    it("TEST D2.6-a2: when INTERNAL_AUTH_ENABLED is 'false', secret is ignored", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "false";

      const req = {
        method: "PATCH",
        path: "/api/workflows/workflows/wf-123",
        originalUrl: "/api/workflows/workflows/wf-123",
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

    it("TEST D2.6-a3: when enabled, wrong method on allowed path is ignored", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";

      const req = {
        method: "POST", // Should be GET for project-data
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

    it("TEST D2.6-a4: when enabled, generation, characters, elements, wallet routes are rejected", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";

      const forbiddenCalls = [
        { method: "POST", url: "/api/v2/workflows/run" },
        { method: "POST", url: "/api/characters" },
        { method: "DELETE", url: "/api/v2/elements/elem-123" },
        { method: "POST", url: "/api/wallet/credit" },
        { method: "GET", url: "/api/wallet/balance" },
        { method: "POST", url: "/api/images/generate" },
      ];

      for (const call of forbiddenCalls) {
        const req = {
          method: call.method,
          path: call.url,
          originalUrl: call.url,
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

        assert.ok(nextErr, `Forbidden route ${call.method} ${call.url} must be rejected`);
        assert.equal(nextErr.statusCode, 401);
        assert.equal(req.user, undefined);
      }
    });

    it("TEST D2.6-a5: when enabled, exact allowed pairs (GET project-data & PATCH workflows) succeed", async () => {
      process.env.INTERNAL_AUTH_ENABLED = "true";

      // Pair 1: GET /api/workflows/project-data/:projectId
      const req1 = {
        method: "GET",
        path: "/api/workflows/project-data/proj-valid-1",
        originalUrl: "/api/workflows/project-data/proj-valid-1",
        headers: {
          "x-internal-secret": VALID_TEST_SECRET,
          "x-user-id": "element-vision-worker",
        },
        cookies: {},
      };

      let next1Called = false;
      await requireAuth(req1, {}, (err) => {
        assert.ifError(err);
        next1Called = true;
      });
      assert.equal(next1Called, true);
      assert.equal(req1.user?.id, "element-vision-worker");

      // Pair 2: PATCH /api/workflows/workflows/:id
      const req2 = {
        method: "PATCH",
        path: "/api/workflows/workflows/wf-valid-2",
        originalUrl: "/api/workflows/workflows/wf-valid-2",
        headers: {
          "x-internal-secret": VALID_TEST_SECRET,
          "x-user-id": "element-vision-worker",
        },
        cookies: {},
      };

      let next2Called = false;
      await requireAuth(req2, {}, (err) => {
        assert.ifError(err);
        next2Called = true;
      });
      assert.equal(next2Called, true);
      assert.equal(req2.user?.id, "element-vision-worker");
    });
  });

  // ── (b) Split /health and /ready ──────────────────────────────────────────
  describe("(b) Health and readiness split", () => {
    it("TEST D2.6-b1: /health is liveness only, always 200, minimal status", async () => {
      let statusCode = null;
      let jsonPayload = null;

      const res = {
        status(code) {
          statusCode = code;
          return this;
        },
        json(data) {
          jsonPayload = data;
          return this;
        },
      };

      // Call health handler
      const req = { method: "GET", path: "/" };
      healthRouter.handle(req, res, () => {});

      assert.equal(statusCode, null, "Default status is 200 (res.json without res.status)");
      assert.equal(jsonPayload?.status, "ok");
    });

    it("TEST D2.6-b2: /ready returns 200 when Redis connections are ready", async () => {
      let statusCode = 200;
      let jsonPayload = null;

      const res = {
        status(code) {
          statusCode = code;
          return this;
        },
        json(data) {
          jsonPayload = data;
          return this;
        },
      };

      // Mock ready state
      const origRLStatus = rateLimitRedisConnection.status;
      const origQStatus = redisConnection.status;
      rateLimitRedisConnection.status = "ready";
      redisConnection.status = "ready";

      try {
        const req = { method: "GET", path: "/" };
        readyRouter.handle(req, res, () => {});

        assert.equal(statusCode, 200);
        assert.deepEqual(jsonPayload, { ready: true });
      } finally {
        rateLimitRedisConnection.status = origRLStatus;
        redisConnection.status = origQStatus;
      }
    });

    it("TEST D2.6-b3: /ready returns 503 when rateLimit Redis is disconnected", async () => {
      let statusCode = null;
      let jsonPayload = null;

      const res = {
        status(code) {
          statusCode = code;
          return this;
        },
        json(data) {
          jsonPayload = data;
          return this;
        },
      };

      const origRLStatus = rateLimitRedisConnection.status;
      const origQStatus = redisConnection.status;
      rateLimitRedisConnection.status = "close";
      redisConnection.status = "ready";

      try {
        const req = { method: "GET", path: "/" };
        readyRouter.handle(req, res, () => {});

        assert.equal(statusCode, 503);
        assert.deepEqual(jsonPayload, { ready: false });
      } finally {
        rateLimitRedisConnection.status = origRLStatus;
        redisConnection.status = origQStatus;
      }
    });
  });
});
