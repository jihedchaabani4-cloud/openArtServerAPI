import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AppError, ProviderError, ValidationError, BillingError, SystemError, InsufficientCreditsError, ReservationExpiredError, CrudServiceError, safePublicRouteError, ErrorSystem, ERROR_POLICY } from "../../src/shared/errors/index.js";
import { createLogger, runWithContext, setContext, getContext, getCleanContext, LogEvents, LogErrorCodes, baseLogger } from "../../src/shared/logger/index.js";
import { sanitizeData } from "../../src/shared/logger/redaction.js";
import { errSerializer, reqSerializer, resSerializer } from "../../src/shared/logger/serializers.js";
import { envConfig, loggingConfig, redisConnection, workerRedisConnection, rateLimitRedisConnection, waitForRateLimitRedis, RECONCILIATION_CACHE_KEY } from "#shared";
import { isProductionEnvironment, assertSecurityConfiguredForEnvironment, assertWalletConfiguredForEnvironment, assertRateLimitConfiguredForEnvironment, workflowService } from "../../src/container.js";
import http from "node:http";
import app from "../../index.js";
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
