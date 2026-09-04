import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createLogger,
  runWithContext,
  setContext,
  getContext,
  getCleanContext,
  LogEvents,
  LogErrorCodes,
} from "../../src/infrastructure/logging/index.js";
import { errSerializer } from "../../src/infrastructure/logging/serializers.js";

describe("Logging Infrastructure Foundation Unit Tests", () => {
  test("createLogger returns an object with standard log methods and child factory", () => {
    const logger = createLogger("wallet");
    assert.equal(typeof logger.debug, "function");
    assert.equal(typeof logger.info, "function");
    assert.equal(typeof logger.warn, "function");
    assert.equal(typeof logger.error, "function");
    assert.equal(typeof logger.fatal, "function");
    assert.equal(typeof logger.child, "function");

    const child = logger.child({ customBinding: "val" });
    assert.equal(typeof child.info, "function");
  });

  test("runWithContext propagates context across async execution boundaries", async () => {
    const testContext = {
      requestId: "req_test_123",
      userId: "usr_456",
      useCase: "image-generation-v1",
      operation: "generate",
    };

    await runWithContext(testContext, async () => {
      const active = getContext();
      assert.deepEqual(active, testContext);

      // Async step
      await new Promise((resolve) => setTimeout(resolve, 5));

      const afterAsync = getContext();
      assert.equal(afterAsync.requestId, "req_test_123");
      assert.equal(afterAsync.userId, "usr_456");
    });

    // Outside context must be undefined
    assert.equal(getContext(), undefined);
  });

  test("setContext enriches active context store", async () => {
    await runWithContext({ requestId: "req_auth_test" }, async () => {
      assert.equal(getContext().requestId, "req_auth_test");
      assert.equal(getContext().userId, undefined);

      // Simulate authentication middleware setting userId
      setContext({ userId: "usr_authenticated_789" });

      assert.equal(getContext().requestId, "req_auth_test");
      assert.equal(getContext().userId, "usr_authenticated_789");
    });
  });

  test("getCleanContext omits empty, null, and undefined values (FR-016)", async () => {
    await runWithContext(
      {
        requestId: "req_clean_1",
        userId: null,
        jobId: undefined,
        useCase: "",
        operation: "test_op",
      },
      () => {
        const clean = getCleanContext();
        assert.equal(clean.requestId, "req_clean_1");
        assert.equal(clean.operation, "test_op");
        assert.equal("userId" in clean, false);
        assert.equal("jobId" in clean, false);
        assert.equal("useCase" in clean, false);
      }
    );
  });

  test("errSerializer safely formats error objects with codes and stack traces", () => {
    const err = new Error("Provider request timed out");
    err.code = LogErrorCodes.PROVIDER_TIMEOUT;
    err.statusCode = 504;

    const serialized = errSerializer(err);
    assert.equal(serialized.type, "Error");
    assert.equal(serialized.message, "Provider request timed out");
    assert.equal(serialized.code, "PROVIDER_TIMEOUT");
    assert.equal(serialized.statusCode, 504);
    assert.ok(typeof serialized.stack === "string" && serialized.stack.includes("Provider request timed out"));
  });

  test("LogEvents and LogErrorCodes are immutable dictionaries", () => {
    assert.equal(LogEvents.WALLET_HOLD_CREATED, "wallet.hold.created");
    assert.equal(LogErrorCodes.WALLET_INSUFFICIENT_CREDITS, "WALLET_INSUFFICIENT_CREDITS");

    assert.throws(() => {
      LogEvents.NEW_EVENT = "test";
    });
    assert.throws(() => {
      LogErrorCodes.NEW_CODE = "test";
    });
  });

  test("wrapWorkerJob restores originating context from job.data._context", async () => {
    const { wrapWorkerJob } = await import("../../src/infrastructure/logging/workerLogger.js");

    const mockJob = {
      id: "job_999",
      data: {
        _context: {
          requestId: "req_from_http_parent",
          userId: "usr_originator",
          useCase: "image-generation-v1",
        },
      },
    };

    let executedWithContext = null;

    const wrappedProcessor = wrapWorkerJob("test-worker", async (job) => {
      executedWithContext = getContext();
      return { success: true };
    });

    const res = await wrappedProcessor(mockJob);
    assert.deepEqual(res, { success: true });
    assert.equal(executedWithContext.requestId, "req_from_http_parent");
    assert.equal(executedWithContext.userId, "usr_originator");
    assert.equal(executedWithContext.jobId, "job_999");
    assert.equal(executedWithContext.useCase, "image-generation-v1");
  });

  test("createLogger binds uppercase module name and child bindings", () => {
    const logger = createLogger("workflow");
    assert.equal(typeof logger.info, "function");

    const childLogger = logger.child({ workflowRunId: "run_abc_123" });
    assert.equal(typeof childLogger.info, "function");
    assert.equal(typeof childLogger.error, "function");
  });

  test("sanitizeData and reqSerializer redact authorization, passwords, and tokens", async () => {
    const { sanitizeData } = await import("../../src/infrastructure/logging/redaction.js");
    const { reqSerializer } = await import("../../src/infrastructure/logging/serializers.js");

    const payload = {
      user: "alice",
      password: "SuperSecretPassword123!",
      apiKey: "ws_live_secret_key_888",
      nested: {
        token: "jwt.secret.bearer",
        refreshToken: "refresh.secret.token",
      },
    };

    const sanitized = sanitizeData(payload);
    assert.equal(sanitized.user, "alice");
    assert.equal(sanitized.password, "[REDACTED]");
    assert.equal(sanitized.apiKey, "[REDACTED]");
    assert.equal(sanitized.nested.token, "[REDACTED]");
    assert.equal(sanitized.nested.refreshToken, "[REDACTED]");

    const mockReq = {
      method: "POST",
      url: "/api/workflows",
      headers: {
        authorization: "Bearer eyJhbGciOi...",
        cookie: "access_token=secret; refresh_token=secret",
        "x-api-key": "secret-key",
        "content-type": "application/json",
      },
    };

    const serializedReq = reqSerializer(mockReq);
    assert.equal(serializedReq.headers.authorization, "[REDACTED]");
    assert.equal(serializedReq.headers.cookie, "[REDACTED]");
    assert.equal(serializedReq.headers["x-api-key"], "[REDACTED]");
    assert.equal(serializedReq.headers["content-type"], "application/json");
  });

  test("ErrorSystem.logReport formats reports with error codes and diagnostic stacks", async () => {
    const { ErrorSystem } = await import("../../src/v2/runtime/errorPolicy.js");

    const syntheticError = new Error("Simulated provider upstream failure");
    syntheticError.code = "PROVIDER_TIMEOUT";
    syntheticError.statusCode = 504;

    const report = ErrorSystem.process(syntheticError, {
      runId: "run_test_err_504",
      userId: "usr_diag_1",
      nodeId: "image-gen-node",
    });

    assert.equal(report.user.category, "UPSTREAM_FAULT");
    assert.equal(report.actions.statusCode, 503);
    assert.ok(report.system.stack.includes("Simulated provider upstream failure"));

    // Should not throw when executing logReport
    assert.doesNotThrow(() => {
      ErrorSystem.logReport(report);
    });
  });
});
