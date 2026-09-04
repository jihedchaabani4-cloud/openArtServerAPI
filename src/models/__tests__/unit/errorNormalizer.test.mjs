import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeError, StandardErrorCodes } from "../../execution/errorNormalizer.js";

describe("Error Normalizer (US5)", () => {
  it("should normalize HTTP 429 into RATE_LIMITED with retryable: true", () => {
    const rawErr = new Error("Too many requests from this IP");
    rawErr.statusCode = 429;

    const normalized = normalizeError(rawErr);
    assert.equal(normalized.code, StandardErrorCodes.RATE_LIMITED);
    assert.equal(normalized.statusCode, 429);
    assert.equal(normalized.retryable, true);
  });

  it("should normalize HTTP 504 timeout into PROVIDER_TIMEOUT with retryable: true", () => {
    const rawErr = new Error("Gateway Timeout: upstream provider did not respond");
    rawErr.statusCode = 504;

    const normalized = normalizeError(rawErr);
    assert.equal(normalized.code, StandardErrorCodes.PROVIDER_TIMEOUT);
    assert.equal(normalized.statusCode, 504);
    assert.equal(normalized.retryable, true);
  });

  it("should normalize HTTP 503 outage into PROVIDER_UNAVAILABLE with retryable: true", () => {
    const rawErr = new Error("Service Unavailable");
    rawErr.statusCode = 503;

    const normalized = normalizeError(rawErr);
    assert.equal(normalized.code, StandardErrorCodes.PROVIDER_UNAVAILABLE);
    assert.equal(normalized.statusCode, 503);
    assert.equal(normalized.retryable, true);
  });

  it("should normalize HTTP 400 rejection into INVALID_INPUT_REJECTED_BY_PROVIDER with retryable: false", () => {
    const rawErr = new Error("Bad Request: prompt contains disallowed tokens");
    rawErr.statusCode = 400;

    const normalized = normalizeError(rawErr);
    assert.equal(normalized.code, StandardErrorCodes.INVALID_INPUT_REJECTED_BY_PROVIDER);
    assert.equal(normalized.statusCode, 400);
    assert.equal(normalized.retryable, false);
  });
});
