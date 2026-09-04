import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ErrorSystem } from "../src/runtime/ErrorSystem.js";
import {
  AppError,
  ProviderError,
  ValidationError,
  BillingError,
  SystemError,
} from "../src/errors/AppError.js";
import { ERROR_POLICY } from "../src/runtime/errorPolicy.js";

describe("ErrorSystem.process Unit Tests (§4 & §8)", () => {
  it("ProviderError: produces sanitized report.user and complete report.system", () => {
    const rawError = new ProviderError("PROVIDER_TIMEOUT", "Fal.ai upstream socket hang up after 60000ms", {
      type: "OPERATIONAL",
      category: "UPSTREAM_FAULT",
      context: { provider: "fal", model: "flux-pro" },
    });

    const report = ErrorSystem.process(rawError, {
      nodeId: "flux_node",
      runId: "run_provider_001",
      userId: "user_123",
    });

    // 1. report.user — Safe, zero leak
    assert.equal(report.user.code, "PROVIDER_TIMEOUT");
    assert.equal(report.user.category, "UPSTREAM_FAULT");
    assert.equal(report.user.statusCode, 502);
    assert.equal(report.user.retryable, true);
    assert.equal(report.user.nodeId, "flux_node");
    assert.doesNotMatch(JSON.stringify(report.user), /fal|socket|60000ms|hang up/i, "User message must never contain provider details");

    // 2. report.system — Full technical trace
    assert.equal(report.system.rawCode, "PROVIDER_TIMEOUT");
    assert.equal(report.system.rawMessage, "Fal.ai upstream socket hang up after 60000ms");
    assert.equal(report.system.type, "OPERATIONAL");
    assert.equal(report.system.severity, "warn");
    assert.equal(report.system.nodeId, "flux_node");
    assert.equal(report.system.traceId, "run_provider_001");
    assert.equal(report.system.userId, "user_123");
    assert.ok(report.system.stack, "System report must contain stack trace");

    // 3. report.actions
    assert.equal(report.actions.billingAction, "RELEASE");
    assert.equal(report.actions.shouldRefund, true);
    assert.equal(report.actions.retryable, true);
  });

  it("ValidationError: handles content safety violations correctly", () => {
    const rawError = new ValidationError("CONTENT_SAFETY_VIOLATION", "Prompt flagged for restricted content by moderation model", {
      type: "OPERATIONAL",
      category: "USER_FAULT",
    });

    const report = ErrorSystem.process(rawError, { nodeId: "safety_node" });

    assert.equal(report.user.code, "CONTENT_SAFETY_VIOLATION");
    assert.equal(report.user.category, "USER_FAULT");
    assert.equal(report.user.statusCode, 422);
    assert.equal(report.user.retryable, false);
    assert.match(report.user.message, /content policy/i);

    assert.equal(report.actions.billingAction, "RELEASE");
    assert.equal(report.actions.shouldRefund, true);
  });

  it("BillingError: handles insufficient credits correctly", () => {
    const rawError = new BillingError("INSUFFICIENT_CREDITS", "Wallet balance 3 is below required 20", {
      type: "OPERATIONAL",
      category: "BILLING_FAULT",
    });

    const report = ErrorSystem.process(rawError, { userId: "user_456" });

    assert.equal(report.user.code, "INSUFFICIENT_CREDITS");
    assert.equal(report.user.category, "BILLING_FAULT");
    assert.equal(report.user.statusCode, 402);
    assert.match(report.user.message, /credits/i);

    assert.equal(report.actions.billingAction, "NONE");
    assert.equal(report.actions.shouldRefund, false, "No refund should be issued when no hold was created");
  });

  it("SystemError: classifies programmer error as SERVER_FAULT with apology", () => {
    const rawError = new SystemError("PROGRAMMER_ERROR", "Null pointer exception in workflow compiler", {
      type: "PROGRAMMER",
      category: "SERVER_FAULT",
    });

    const report = ErrorSystem.process(rawError);

    assert.equal(report.user.category, "SERVER_FAULT");
    assert.equal(report.user.statusCode, 500);
    assert.equal(report.system.type, "PROGRAMMER");
    assert.equal(report.system.severity, "error");
    assert.equal(report.actions.billingAction, "ROLLBACK");
    assert.equal(report.actions.shouldRefund, true);
    assert.doesNotMatch(report.user.message, /Null pointer|compiler/i);
  });

  it("Native Error fallback: handles unclassified Error cleanly without throwing", () => {
    const rawError = new TypeError("Cannot read properties of undefined (reading 'token')");

    const report = ErrorSystem.process(rawError);

    assert.equal(report.system.type, "PROGRAMMER");
    assert.equal(report.system.rawCode, "INTERNAL_ERROR");
    assert.equal(report.user.category, "SERVER_FAULT");
    assert.equal(report.user.statusCode, 500);
    assert.equal(report.actions.billingAction, "ROLLBACK");
    assert.equal(report.actions.shouldRefund, true);
    assert.doesNotMatch(report.user.message, /TypeError|token/i);
  });

  it("Unknown code fallback: error with unrecognized code defaults to PROGRAMMER_ERROR", () => {
    const rawError = new AppError("COMPLETELY_UNKNOWN_CUSTOM_CODE", "Something weird happened");

    const report = ErrorSystem.process(rawError);

    assert.equal(report.user.code, "COMPLETELY_UNKNOWN_CUSTOM_CODE");
    assert.equal(report.user.category, ERROR_POLICY.PROGRAMMER_ERROR.category);
    assert.equal(report.user.statusCode, ERROR_POLICY.PROGRAMMER_ERROR.statusCode);
    assert.equal(report.actions.billingAction, ERROR_POLICY.PROGRAMMER_ERROR.billingAction);
    assert.equal(report.user.message, ERROR_POLICY.PROGRAMMER_ERROR.userMessage);
  });
});
