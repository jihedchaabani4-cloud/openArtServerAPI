import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createLogger,
  runWithContext,
  setContext,
  getContext,
  getCleanContext,
  LogEvents,
  LogErrorCodes,
  baseLogger,
} from "../../src/shared/logger/index.js";
import { sanitizeData } from "../../src/shared/logger/redaction.js";
import { errSerializer, reqSerializer, resSerializer } from "../../src/shared/logger/serializers.js";

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
