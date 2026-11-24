import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AppError, ProviderError, ValidationError, BillingError, SystemError, InsufficientCreditsError, ReservationExpiredError, CrudServiceError, safePublicRouteError, ErrorSystem, ERROR_POLICY } from "../../src/shared/errors/index.js";
import { createLogger, runWithContext, setContext, getContext, getCleanContext, LogEvents, LogErrorCodes, baseLogger } from "../../src/shared/logger/index.js";
import { sanitizeData } from "../../src/shared/logger/redaction.js";
import { errSerializer, reqSerializer, resSerializer } from "../../src/shared/logger/serializers.js";
import {
  envConfig,
  loggingConfig,
  redisConnection,
  workerRedisConnection,
  rateLimitRedisConnection,
  waitForRedis,
  waitForRateLimitRedis,
  RECONCILIATION_CACHE_KEY,
  RATE_LIMIT_POLICIES,
  clampBulkDeleteConcurrency,
  BULK_DELETE_CONCURRENCY_DEFAULT,
  BULK_DELETE_CONCURRENCY_MIN,
  BULK_DELETE_CONCURRENCY_MAX,
  runWithConcurrency,
} from "#shared";
import { isProductionEnvironment, assertSecurityConfiguredForEnvironment, assertWalletConfiguredForEnvironment, assertRateLimitConfiguredForEnvironment, workflowService } from "../../src/container.js";
import http from "node:http";
import app from "../../index.js";
import { _resetReadinessCacheForTest } from "../../src/api/probes/ready.js";
import { supabase } from "#shared/db/supabase.js";

// ─── Source: sharedErrors.test.js ───
{
describe("Shared Errors Hierarchy", () => {
  it("supports legacy 2-argument signature: new AppError(message, statusCode)", () => {
    const err404 = new AppError("Resource not found", 404);
    assert.equal(err404.message, "Resource not found");
    assert.equal(err404.statusCode, 404);
    assert.equal(err404.status, "fail");
    assert.equal(err404.isOperational, true);
    assert.equal(err404.code, "NOT_FOUND");
    assert.equal(err404.category, "USER_FAULT");

    const err500 = new AppError("Internal crash", 500);
    assert.equal(err500.statusCode, 500);
    assert.equal(err500.status, "error");
    assert.equal(err500.category, "SERVER_FAULT");
  });

  it("supports modern 3-argument signature: new AppError(code, message, options)", () => {
    const err = new AppError("CUSTOM_CODE", "Something failed", {
      statusCode: 422,
      category: "USER_FAULT",
      retryable: true,
      billingAction: "ROLLBACK",
      context: { foo: "bar" },
    });

    assert.equal(err.code, "CUSTOM_CODE");
    assert.equal(err.message, "Something failed");
    assert.equal(err.statusCode, 422);
    assert.equal(err.status, "fail");
    assert.equal(err.retryable, true);
    assert.equal(err.billingAction, "ROLLBACK");
    assert.deepEqual(err.context, { foo: "bar" });
  });

  it("subclasses inherit correct categories and status codes", () => {
    const valErr = new ValidationError("INVALID_FIELD", "Missing email");
    assert.equal(valErr.statusCode, 400);
    assert.equal(valErr.category, "USER_FAULT");

    const provErr = new ProviderError("UPSTREAM_FAIL", "Fal AI timeout");
    assert.equal(provErr.category, "UPSTREAM_FAULT");

    const creditErr = new InsufficientCreditsError(10, 2);
    assert.equal(creditErr.code, "INSUFFICIENT_CREDITS");
    assert.equal(creditErr.statusCode, 402);
    assert.equal(creditErr.category, "BILLING_FAULT");
    assert.equal(creditErr.required, 10);
    assert.equal(creditErr.available, 2);

    const expiredErr = new ReservationExpiredError("res-123");
    assert.equal(expiredErr.code, "RESERVATION_EXPIRED");
    assert.equal(expiredErr.statusCode, 409);
    assert.equal(expiredErr.reservationId, "res-123");
  });

  it("CrudServiceError initializes correctly", () => {
    const err = new CrudServiceError("Failed to update entity", {
      statusCode: 404,
      errorCode: "ENTITY_NOT_FOUND",
      entityId: "123",
    });
    assert.equal(err.name, "CrudServiceError");
    assert.equal(err.statusCode, 404);
    assert.equal(err.errorCode, "ENTITY_NOT_FOUND");
    assert.equal(err.entityId, "123");
  });

  it("safePublicRouteError masks 5xx and preserves 4xx contracts", () => {
    const err500 = new Error("Database connection leak on 10.0.0.1:5432");
    const masked = safePublicRouteError(err500);
    assert.equal(masked.statusCode, 500);
    assert.equal(masked.errorCode, "INTERNAL_ERROR");
    assert.equal(masked.publicMessage, "Internal server error");

    const err404 = new AppError("Item not found", 404);
    const pass404 = safePublicRouteError(err404);
    assert.equal(pass404.statusCode, 404);
    assert.equal(pass404.errorCode, "NOT_FOUND");
    assert.equal(pass404.publicMessage, "Item not found");

    const errCustom = { statusCode: 402, errorCode: "INSUFFICIENT_CREDITS", message: "Need credits" };
    const passCustom = safePublicRouteError(errCustom);
    assert.equal(passCustom.statusCode, 402);
    assert.equal(passCustom.errorCode, "INSUFFICIENT_CREDITS");
    assert.equal(passCustom.publicMessage, "Need credits");
  });

  it("ErrorSystem processes errors into user and system reports according to policy", () => {
    const appErr = new InsufficientCreditsError(20, 5);
    const processed = ErrorSystem.process(appErr, { nodeId: "node-1", runId: "run-99" });

    assert.equal(processed.user.code, "INSUFFICIENT_CREDITS");
    assert.equal(processed.user.statusCode, 402);
    assert.equal(processed.user.category, "BILLING_FAULT");
    assert.equal(processed.user.nodeId, "node-1");
    assert.equal(processed.system.traceId, "run-99");
    assert.equal(processed.actions.billingAction, "NONE");
    assert.equal(processed.actions.shouldRefund, false);
  });
});
}

// ─── Source: sharedLogger.test.js ───
{
describe("Shared Logger Infrastructure", () => {
  it("creates a module-scoped logger", () => {
    const log = createLogger("test_module");
    assert.equal(typeof log.info, "function");
    assert.equal(typeof log.error, "function");
    assert.equal(typeof log.debug, "function");
    assert.equal(typeof log.warn, "function");
    assert.equal(typeof log.child, "function");
  });

  it("propagates context via AsyncLocalStorage runWithContext & setContext", () => {
    assert.equal(getContext(), undefined);

    runWithContext({ requestId: "req-123", userId: "user-abc" }, () => {
      const ctx = getContext();
      assert.equal(ctx.requestId, "req-123");
      assert.equal(ctx.userId, "user-abc");

      setContext({ operation: "generate_image" });
      const enriched = getContext();
      assert.equal(enriched.operation, "generate_image");

      const clean = getCleanContext();
      assert.deepEqual(clean, {
        requestId: "req-123",
        userId: "user-abc",
        operation: "generate_image",
      });
    });

    assert.equal(getContext(), undefined);
  });

  it("redacts sensitive fields in sanitizeData", () => {
    const raw = {
      password: "pass",
      apiKey: "key",
      regularField: "hello",
      nested: {
        token: "tok",
        name: "test",
      },
    };

    const sanitized = sanitizeData(raw);
    assert.equal(sanitized.password, "[REDACTED]");
    assert.equal(sanitized.apiKey, "[REDACTED]");
    assert.equal(sanitized.regularField, "hello");
    assert.equal(sanitized.nested.token, "[REDACTED]");
    assert.equal(sanitized.nested.name, "test");
  });

  it("serializers format error, req, and res safely", () => {
    const err = new Error("Boom");
    err.code = "CRASH";
    const serializedErr = errSerializer(err);
    assert.equal(serializedErr.message, "Boom");
    assert.equal(serializedErr.code, "CRASH");

    const req = {
      method: "POST",
      url: "/api/test",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
    };
    const serializedReq = reqSerializer(req);
    assert.equal(serializedReq.method, "POST");
    assert.equal(serializedReq.headers.authorization, "[REDACTED]");
    assert.equal(serializedReq.headers["content-type"], "application/json");

    const res = { statusCode: 201 };
    const serializedRes = resSerializer(res);
    assert.equal(serializedRes.statusCode, 201);
  });

  it("LogEvents and LogErrorCodes are immutable taxonomies", () => {
    assert.ok(Object.isFrozen(LogEvents));
    assert.ok(Object.isFrozen(LogErrorCodes));
    assert.equal(LogEvents.HTTP_REQUEST_STARTED, "http.request.started");
    assert.equal(LogErrorCodes.VALIDATION_INVALID_INPUT, "VALIDATION_INVALID_INPUT");
  });
});
}

// ─── Source: sharedRedisAndConfig.test.js ───
{
describe("Shared Redis & Config Kernel", () => {
  it("resolves through #shared alias successfully", () => {
    assert.ok(envConfig);
    assert.ok(loggingConfig);
    assert.equal(typeof createLogger, "function");
    assert.equal(typeof AppError, "function");
  });

  it("provides clean environment config flags", () => {
    assert.equal(typeof envConfig.isProduction, "boolean");
    assert.equal(typeof envConfig.isTest, "boolean");
    assert.equal(typeof envConfig.isDevelopment, "boolean");
    assert.equal(typeof envConfig.level, "string");
  });

  it("exports Redis connection singletons and constants", async () => {
    assert.ok(redisConnection);
    assert.ok(workerRedisConnection);
    assert.ok(rateLimitRedisConnection);
    assert.equal(RECONCILIATION_CACHE_KEY, "reconciliation:latest");

    const ready = await waitForRateLimitRedis(100);
    assert.equal(ready, true); // in test environment, resolves immediately to true
  });

  it("parses and clamps BULK_DELETE_CONCURRENCY into [1, 15] with default 10", () => {
    const orig = process.env.BULK_DELETE_CONCURRENCY;
    try {
      assert.equal(BULK_DELETE_CONCURRENCY_DEFAULT, 10);
      assert.equal(BULK_DELETE_CONCURRENCY_MIN, 1);
      assert.equal(BULK_DELETE_CONCURRENCY_MAX, 15);

      // Direct clamp helper checks
      assert.equal(clampBulkDeleteConcurrency(undefined), 10);
      assert.equal(clampBulkDeleteConcurrency(null), 10);
      assert.equal(clampBulkDeleteConcurrency(""), 10);
      assert.equal(clampBulkDeleteConcurrency("   "), 10);
      assert.equal(clampBulkDeleteConcurrency("not-a-number"), 10);
      assert.equal(clampBulkDeleteConcurrency(NaN), 10);
      assert.equal(clampBulkDeleteConcurrency(Infinity), 10);
      assert.equal(clampBulkDeleteConcurrency(true), 10);
      assert.equal(clampBulkDeleteConcurrency(0), 1);
      assert.equal(clampBulkDeleteConcurrency(-5), 1);
      assert.equal(clampBulkDeleteConcurrency("0"), 1);
      assert.equal(clampBulkDeleteConcurrency("-5"), 1);
      assert.equal(clampBulkDeleteConcurrency(1), 1);
      assert.equal(clampBulkDeleteConcurrency(12), 12);
      assert.equal(clampBulkDeleteConcurrency("12"), 12);
      assert.equal(clampBulkDeleteConcurrency(15), 15);
      assert.equal(clampBulkDeleteConcurrency(50), 15);
      assert.equal(clampBulkDeleteConcurrency("50"), 15);

      // Dynamic envConfig.bulkDeleteConcurrency getter checks
      delete process.env.BULK_DELETE_CONCURRENCY;
      assert.equal(envConfig.bulkDeleteConcurrency, 10);

      process.env.BULK_DELETE_CONCURRENCY = "";
      assert.equal(envConfig.bulkDeleteConcurrency, 10);

      process.env.BULK_DELETE_CONCURRENCY = "invalid";
      assert.equal(envConfig.bulkDeleteConcurrency, 10);

      process.env.BULK_DELETE_CONCURRENCY = "0";
      assert.equal(envConfig.bulkDeleteConcurrency, 1);

      process.env.BULK_DELETE_CONCURRENCY = "-5";
      assert.equal(envConfig.bulkDeleteConcurrency, 1);

      process.env.BULK_DELETE_CONCURRENCY = "12";
      assert.equal(envConfig.bulkDeleteConcurrency, 12);

      process.env.BULK_DELETE_CONCURRENCY = "50";
      assert.equal(envConfig.bulkDeleteConcurrency, 15);
    } finally {
      if (orig === undefined) {
        delete process.env.BULK_DELETE_CONCURRENCY;
      } else {
        process.env.BULK_DELETE_CONCURRENCY = orig;
      }
    }
  });

  it("defines bulkDelete rate limit policy at 30 req / 60s per user (fail-open)", () => {
    assert.deepEqual(RATE_LIMIT_POLICIES.bulkDelete, {
      points: 30,
      duration: 60,
      keyBy: "user",
      failPolicy: "open",
    });
  });

  it("runWithConcurrency strictly bounds max in-flight workers across 1, 10, 15, and clamped <1 / >15", async () => {
    const cases = [
      { input: 1, expectedCap: 1, totalItems: 6 },
      { input: 0, expectedCap: 1, totalItems: 6 },
      { input: -5, expectedCap: 1, totalItems: 6 },
      { input: 10, expectedCap: 10, totalItems: 25 },
      { input: 15, expectedCap: 15, totalItems: 35 },
      { input: 50, expectedCap: 15, totalItems: 35 },
    ];

    for (const { input, expectedCap, totalItems } of cases) {
      let inFlight = 0;
      let maxInFlight = 0;
      const items = Array.from({ length: totalItems }, (_, i) => i + 1);

      const results = await runWithConcurrency(
        items,
        async (item) => {
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight -= 1;
          return item * 2;
        },
        { concurrency: input }
      );

      assert.deepEqual(
        results,
        items.map((n) => n * 2),
        `Result order must match input order for concurrency=${input}`
      );
      assert.equal(inFlight, 0);
      assert.ok(
        maxInFlight <= expectedCap,
        `maxInFlight (${maxInFlight}) exceeded cap (${expectedCap}) for concurrency=${input}`
      );
      assert.equal(
        maxInFlight,
        Math.min(expectedCap, totalItems),
        `Pool should utilize full bounded concurrency (${expectedCap}) for concurrency=${input}`
      );
    }

    // Empty list returns empty array immediately
    assert.deepEqual(await runWithConcurrency([], async () => 1, { concurrency: 5 }), []);

    // Propagates errors and stops launching remaining queued items
    let started = 0;
    await assert.rejects(
      () =>
        runWithConcurrency(
          [1, 2, 3, 4, 5, 6],
          async (item) => {
            started += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (item === 2) throw new Error("boom-item-2");
            return item;
          },
          { concurrency: 1 }
        ),
      /boom-item-2/
    );
    assert.equal(started, 2, "Must stop picking up new items after first error");
  });
});
}

// ─── Source: envFailSafeBoundary.test.js ───
{
describe("RC1.2-S2 — NODE_ENV and Rate Limit Fail-Safe Boundary Tests", () => {
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
  });

  afterEach(() => {
    process.env = origEnv;
  });

  describe("1. Inverted NODE_ENV Default (Fail-Safe Production Mode)", () => {
    it("TEST 1: unset NODE_ENV is treated as production mode", () => {
      delete process.env.NODE_ENV;
      assert.equal(isProductionEnvironment(), true);
    });

    it("TEST 2: arbitrary non-development/test NODE_ENV (e.g. 'staging', 'production') is treated as production mode", () => {
      process.env.NODE_ENV = "staging";
      assert.equal(isProductionEnvironment(), true);

      process.env.NODE_ENV = "production";
      assert.equal(isProductionEnvironment(), true);
    });

    it("TEST 3: NODE_ENV='development' is treated as non-production", () => {
      process.env.NODE_ENV = "development";
      assert.equal(isProductionEnvironment(), false);
    });

    it("TEST 4: NODE_ENV='test' is treated as non-production", () => {
      process.env.NODE_ENV = "test";
      assert.equal(isProductionEnvironment(), false);
    });
  });

  describe("2. Security & Wallet Boot Assertions with Inverted Default", () => {
    it("TEST 5: unset NODE_ENV refuses boot if INTERNAL_SECRET is missing or < 32 chars", () => {
      delete process.env.NODE_ENV;
      delete process.env.INTERNAL_SECRET;

      assert.throws(
        () => assertSecurityConfiguredForEnvironment(),
        /INTERNAL_SECRET is required in production mode/
      );

      process.env.INTERNAL_SECRET = "too-short";
      assert.throws(
        () => assertSecurityConfiguredForEnvironment(),
        /at least 32 characters/
      );
    });

    it("TEST 6: unset NODE_ENV refuses boot if WalletService credentials are missing", () => {
      delete process.env.NODE_ENV;
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      delete process.env.SUPABASE_KEY;

      assert.throws(
        () => assertWalletConfiguredForEnvironment(),
        /WalletService is required in production mode/
      );
    });

    it("TEST 7: NODE_ENV='development' allows boot with missing secrets and wallet credentials", () => {
      process.env.NODE_ENV = "development";
      delete process.env.INTERNAL_SECRET;
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_KEY;

      assert.doesNotThrow(() => assertSecurityConfiguredForEnvironment());
      assert.doesNotThrow(() => assertWalletConfiguredForEnvironment());
    });
  });

  describe("3. RATE_LIMIT_STORE Fail-Safe Enforcement", () => {
    it("TEST 8: in production mode, unset RATE_LIMIT_STORE throws at boot", () => {
      process.env.NODE_ENV = "production";
      delete process.env.RATE_LIMIT_STORE;
      delete process.env.ALLOW_IN_MEMORY_RATE_LIMIT;

      assert.throws(
        () => assertRateLimitConfiguredForEnvironment(),
        /RATE_LIMIT_STORE must be set to 'redis' in production mode/
      );
    });

    it("TEST 9: in production mode, RATE_LIMIT_STORE='memory' without escape hatch throws at boot", () => {
      delete process.env.NODE_ENV; // unset => production
      process.env.RATE_LIMIT_STORE = "memory";
      delete process.env.ALLOW_IN_MEMORY_RATE_LIMIT;

      assert.throws(
        () => assertRateLimitConfiguredForEnvironment(),
        /RATE_LIMIT_STORE must be set to 'redis' in production mode/
      );
    });

    it("TEST 10: in production mode, RATE_LIMIT_STORE='redis' passes boot cleanly", () => {
      process.env.NODE_ENV = "production";
      process.env.RATE_LIMIT_STORE = "redis";
      delete process.env.ALLOW_IN_MEMORY_RATE_LIMIT;

      assert.doesNotThrow(() => assertRateLimitConfiguredForEnvironment());
    });

    it("TEST 11: in production mode, RATE_LIMIT_STORE='memory' with ALLOW_IN_MEMORY_RATE_LIMIT='true' logs warning and boots", () => {
      delete process.env.NODE_ENV; // unset => production
      process.env.RATE_LIMIT_STORE = "memory";
      process.env.ALLOW_IN_MEMORY_RATE_LIMIT = "true";

      let warned = false;
      const logger = {
        warn(payload, message) {
          warned = payload?.event === "security.rate_limit_memory_warning"
            && typeof message === "string"
            && message.includes("CRITICAL SECURITY WARNING");
        },
      };

      assert.doesNotThrow(() => assertRateLimitConfiguredForEnvironment(logger));
      assert.equal(warned, true, "Loud structured warning must be logged when memory rate limit escape is active");
    });

    it("TEST 12: in development mode, memory rate limit store boots without warning or error", () => {
      process.env.NODE_ENV = "development";
      delete process.env.RATE_LIMIT_STORE;
      delete process.env.ALLOW_IN_MEMORY_RATE_LIMIT;

      assert.doesNotThrow(() => assertRateLimitConfiguredForEnvironment());
    });
  });
});
}

// ─── Source: globalErrorHandlerMaskingBoundary.test.js ───
{
describe("Boundary — global error handler never leaks internal 5xx messages", () => {
    let server;
    let baseUrl;
    let origGetUser;
    let origMoveToFolder;

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
        workflowService.moveToFolder = origMoveToFolder;
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

    it("masks an unexpected 5xx passed through next(err): no internal message, generic errorCode", async () => {
        const LEAK_EVIDENCE = 'connect ECONNREFUSED 10.0.0.4:5432 secret-key="sk-internal-77"';
        origMoveToFolder = workflowService.moveToFolder;
        workflowService.moveToFolder = async () => {
            throw Object.assign(new Error(LEAK_EVIDENCE), { statusCode: 502 });
        };
        const res = await fetch(`${baseUrl}/api/assets/asset-neutral-1/folder`, {
            method: "PATCH",
            headers: { "authorization": "Bearer test-valid-user-x", "content-type": "application/json" },
            body: JSON.stringify({ folderId: null }),
        });
        assert.equal(res.status, 502);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.message, "Internal server error");
        assert.equal(body.errorCode, "INTERNAL_ERROR");
        const serialized = JSON.stringify(body);
        assert.ok(!serialized.includes("ECONNREFUSED"), "internal connection details leaked");
        assert.ok(!serialized.includes("sk-internal-77"), "secret-like value leaked");
    });

    it("preserves the public 4xx contract through next(err): message and errorCode stay visible", async () => {
        origMoveToFolder = workflowService.moveToFolder;
        workflowService.moveToFolder = async () => {
            throw Object.assign(new Error("Asset not found."), {
                statusCode: 404,
                code: "NOT_FOUND",
            });
        };
        const res = await fetch(`${baseUrl}/api/assets/asset-neutral-1/folder`, {
            method: "PATCH",
            headers: { "authorization": "Bearer test-valid-user-x", "content-type": "application/json" },
            body: JSON.stringify({ folderId: null }),
        });
        assert.equal(res.status, 404);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.match(body.message, /not found/i);
        assert.equal(body.errorCode, "NOT_FOUND");
    });

    it("preserves the intentional 503 retry contract (message + Retry-After) with a public errorCode", async () => {
        origMoveToFolder = workflowService.moveToFolder;
        workflowService.moveToFolder = async () => {
            throw Object.assign(
                new Error("Server upload capacity temporarily exceeded. Please retry shortly."),
                { statusCode: 503, code: "SERVICE_UNAVAILABLE", retryAfter: 5 }
            );
        };
        const res = await fetch(`${baseUrl}/api/assets/asset-neutral-1/folder`, {
            method: "PATCH",
            headers: { "authorization": "Bearer test-valid-user-x", "content-type": "application/json" },
            body: JSON.stringify({ folderId: null }),
        });
        assert.equal(res.status, 503);
        assert.equal(res.headers.get("retry-after"), "5");
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.match(body.message, /retry shortly/i);
        assert.equal(body.errorCode, "SERVICE_UNAVAILABLE");
    });
});
}

// ─── Source: readyProbeAndRedisWait.test.js ───
{
describe("P2-1 — /ready Probe (RATE_LIMIT_STORE modes) & waitForRedis startup readiness", () => {
    let server;
    let baseUrl;
    let origRateLimitStore;

    before(async () => {
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
    });

    beforeEach(() => {
        _resetReadinessCacheForTest();
        origRateLimitStore = process.env.RATE_LIMIT_STORE;
    });

    afterEach(() => {
        _resetReadinessCacheForTest();
        if (origRateLimitStore === undefined) {
            delete process.env.RATE_LIMIT_STORE;
        } else {
            process.env.RATE_LIMIT_STORE = origRateLimitStore;
        }
    });

    after(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it("GET /ready returns 200 in memory mode even when rateLimitRedisConnection is disconnected ('wait'/'close')", async () => {
        process.env.RATE_LIMIT_STORE = "memory";

        const origRLStatus = rateLimitRedisConnection.status;
        const origQStatus = redisConnection.status;
        const origRLPing = rateLimitRedisConnection.ping;
        const origQPing = redisConnection.ping;

        let rateLimitPingCalls = 0;
        let queuePingCalls = 0;

        rateLimitRedisConnection.ping = async () => {
            rateLimitPingCalls += 1;
            throw new Error("rateLimitRedisConnection.ping must not be called in memory mode");
        };
        redisConnection.status = "ready";
        redisConnection.ping = async () => {
            queuePingCalls += 1;
            return "PONG";
        };

        try {
            for (const disconnectedStatus of ["wait", "close"]) {
                _resetReadinessCacheForTest();
                rateLimitRedisConnection.status = disconnectedStatus;

                const res = await fetch(`${baseUrl}/ready`);
                assert.equal(res.status, 200, `Expected 200 in memory mode when rateLimitRedis status=${disconnectedStatus}`);
                const body = await res.json();
                assert.deepEqual(body, { ready: true });
                assert.equal("rateLimitReady" in body, false, "Response must not expose rateLimitReady");
            }
            assert.equal(rateLimitPingCalls, 0, "rateLimitRedisConnection.ping must never be invoked in memory mode");
            assert.equal(queuePingCalls, 2, "queue redisConnection.ping must be invoked for each uncached probe");
        } finally {
            rateLimitRedisConnection.status = origRLStatus;
            redisConnection.status = origQStatus;
            rateLimitRedisConnection.ping = origRLPing;
            redisConnection.ping = origQPing;
        }
    });

    it("GET /ready returns 503 in memory mode when queue redisConnection is not ready (without reporting rateLimitReady)", async () => {
        process.env.RATE_LIMIT_STORE = "memory";

        const origRLStatus = rateLimitRedisConnection.status;
        const origQStatus = redisConnection.status;

        rateLimitRedisConnection.status = "wait";
        redisConnection.status = "connecting";

        try {
            const res = await fetch(`${baseUrl}/ready`);
            assert.equal(res.status, 503);
            const body = await res.json();
            assert.deepEqual(body, { ready: false });
            assert.equal("rateLimitReady" in body, false);
        } finally {
            rateLimitRedisConnection.status = origRLStatus;
            redisConnection.status = origQStatus;
        }
    });

    it("GET /ready in redis mode returns 503 when rateLimitRedisConnection is down and 200 when both are ready", async () => {
        process.env.RATE_LIMIT_STORE = "redis";

        const origRLStatus = rateLimitRedisConnection.status;
        const origQStatus = redisConnection.status;
        const origRLPing = rateLimitRedisConnection.ping;
        const origQPing = redisConnection.ping;

        let rateLimitPingCalls = 0;
        let queuePingCalls = 0;

        rateLimitRedisConnection.ping = async () => {
            rateLimitPingCalls += 1;
            return "PONG";
        };
        redisConnection.ping = async () => {
            queuePingCalls += 1;
            return "PONG";
        };

        try {
            // Down rate-limit Redis -> 503 even if queue Redis is ready
            rateLimitRedisConnection.status = "close";
            redisConnection.status = "ready";

            const downRes = await fetch(`${baseUrl}/ready`);
            assert.equal(downRes.status, 503);
            assert.deepEqual(await downRes.json(), { ready: false });
            assert.equal(rateLimitPingCalls, 0);

            // Both ready -> 200 and both pinged
            _resetReadinessCacheForTest();
            rateLimitRedisConnection.status = "ready";
            redisConnection.status = "ready";

            const upRes = await fetch(`${baseUrl}/ready`);
            assert.equal(upRes.status, 200);
            assert.deepEqual(await upRes.json(), { ready: true });
            assert.equal(rateLimitPingCalls, 1);
            assert.equal(queuePingCalls, 1);
        } finally {
            rateLimitRedisConnection.status = origRLStatus;
            redisConnection.status = origQStatus;
            rateLimitRedisConnection.ping = origRLPing;
            redisConnection.ping = origQPing;
        }
    });

    it("waitForRedis resolves fast when ready and times out cleanly without throwing", async () => {
        // Default singleton in test env resolves true immediately
        assert.equal(typeof waitForRedis, "function");
        assert.equal(await waitForRedis(100), true);

        // Already-ready connection resolves immediately
        const readyConn = new EventEmitter();
        readyConn.status = "ready";
        const t0 = Date.now();
        assert.equal(await waitForRedis(500, readyConn), true);
        assert.ok(Date.now() - t0 < 100, "Already-ready connection must resolve immediately");

        // Connecting -> emits 'ready' quickly -> resolves true and cleans up listeners
        const fastConn = new EventEmitter();
        fastConn.status = "connecting";
        const t1 = Date.now();
        setTimeout(() => {
            fastConn.status = "ready";
            fastConn.emit("ready");
        }, 15);
        assert.equal(await waitForRedis(500, fastConn), true);
        assert.ok(Date.now() - t1 < 250, "Must resolve promptly on ready event");
        assert.equal(fastConn.listenerCount("ready"), 0, "Must clean up ready listener");
        assert.equal(fastConn.listenerCount("error"), 0, "Must clean up error listener");

        // Unreachable connection in 'wait' state with failing connect() -> times out cleanly to false without throwing
        const slowConn = new EventEmitter();
        slowConn.status = "wait";
        let connectCalls = 0;
        slowConn.connect = async () => {
            connectCalls += 1;
            slowConn.emit("error", new Error("ECONNREFUSED"));
            throw new Error("ECONNREFUSED");
        };
        const t2 = Date.now();
        const timedOutResult = await waitForRedis(40, slowConn);
        const elapsed = Date.now() - t2;
        assert.equal(timedOutResult, false, "Must resolve false on timeout");
        assert.equal(connectCalls, 1, "Must attempt connect() when status is wait");
        assert.ok(elapsed >= 30 && elapsed < 400, `Expected bounded timeout near 40ms, got ${elapsed}ms`);
        assert.equal(slowConn.listenerCount("ready"), 0, "Must clean up ready listener on timeout");
        assert.equal(slowConn.listenerCount("error"), 0, "Must clean up error listener on timeout");
    });
});
}
