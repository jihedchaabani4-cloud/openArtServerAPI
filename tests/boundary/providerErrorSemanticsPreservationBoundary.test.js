import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatWorkflowError,
  toRuntimeError,
  RUNTIME_ERROR_CODES,
  ERROR_CATEGORIES,
} from "../../src/v2/runtime/errorPolicy.js";
import { ProviderTransientError } from "../../src/models/errors/index.js";

describe("D2.5 — Provider Error Semantics & Upstream Fault Mapping Boundary Tests", () => {
  it("TEST 1: formatWorkflowError maps PROVIDER_UNAVAILABLE to UPSTREAM_FAULT and retryable: true", () => {
    const providerErr = new ProviderTransientError("Provider is currently unavailable.");
    providerErr.code = "PROVIDER_UNAVAILABLE";
    providerErr.statusCode = 503;
    providerErr.retryable = true;

    const formatted = formatWorkflowError(providerErr, { node_id: "generate" });

    assert.equal(
      formatted.code,
      "PROVIDER_UNAVAILABLE",
      `Expected code PROVIDER_UNAVAILABLE, got ${formatted.code}`
    );
    assert.equal(
      formatted.category,
      ERROR_CATEGORIES.UPSTREAM_FAULT,
      `Expected category UPSTREAM_FAULT, got ${formatted.category} (must NOT be SERVER_FAULT)`
    );
    assert.equal(
      formatted.retryable,
      true,
      `Expected retryable to be true, got ${formatted.retryable}`
    );
  });

  it("TEST 2: toRuntimeError preserves retryable: true for transient provider errors", () => {
    const providerErr = {
      code: "PROVIDER_UNAVAILABLE",
      message: "Provider is currently unavailable.",
      retryable: true,
    };

    const runtimeErr = toRuntimeError(providerErr);

    assert.equal(runtimeErr.code, "PROVIDER_UNAVAILABLE");
    assert.equal(runtimeErr.category, ERROR_CATEGORIES.UPSTREAM_FAULT);
    assert.equal(runtimeErr.retryable, true);
  });

  it("TEST 3: RUNTIME_ERROR_CODES includes PROVIDER_UNAVAILABLE", () => {
    assert.ok(
      RUNTIME_ERROR_CODES.PROVIDER_UNAVAILABLE,
      "RUNTIME_ERROR_CODES must define PROVIDER_UNAVAILABLE"
    );
    assert.equal(RUNTIME_ERROR_CODES.PROVIDER_UNAVAILABLE, "PROVIDER_UNAVAILABLE");
  });

  it("TEST 4: normalizeError preserves terminal: true and retryable: false for polling terminal failures", async () => {
    const { normalizeError } = await import("../../src/models/execution/errorNormalizer.js");
    const terminalErr = new Error("LTX job failed: Service unavailable on worker");
    terminalErr.terminal = true;
    terminalErr.retryable = false;
    terminalErr.code = "PROVIDER_JOB_FAILED";

    const normalized = normalizeError(terminalErr);

    assert.equal(normalized.terminal, true, "Expected normalized.terminal to be true");
    assert.equal(normalized.retryable, false, "Expected normalized.retryable to be false (must NOT retry dead job)");
    assert.equal(normalized.code, "PROVIDER_JOB_FAILED");
  });

  it("TEST 5: RuntimeExecutor does NOT retry when an error is marked terminal", async () => {
    const { RuntimeExecutor } = await import("../../src/models/execution/runtimeExecutor.js");
    const executor = new RuntimeExecutor();

    let attempts = 0;
    const terminalErr = new Error("LTX job failed terminally");
    terminalErr.terminal = true;
    terminalErr.retryable = false;
    terminalErr.code = "PROVIDER_JOB_FAILED";

    const binding = { id: "test-binding", streaming: false };
    const provider = { id: "test-provider" };

    await assert.rejects(
      async () => {
        await executor.execute({
          provider,
          binding,
          providerPayload: {},
          credential: "mock-key",
          modelId: "test-model",
          bindingId: "test-binding",
          options: {
            maxRetries: 3,
            providerExecutor: async () => {
              attempts++;
              throw terminalErr;
            },
          },
        });
      },
      (err) => {
        assert.equal(err.message, "LTX job failed terminally");
        return true;
      }
    );

    assert.equal(
      attempts,
      1,
      `Expected exactly 1 attempt without duplicate re-submissions, got ${attempts}`
    );
  });
});
