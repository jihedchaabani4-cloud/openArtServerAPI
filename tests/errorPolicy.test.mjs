import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ERROR_POLICY } from "../src/runtime/errorPolicy.js";

const VALID_CATEGORIES = new Set(["USER_FAULT", "SERVER_FAULT", "UPSTREAM_FAULT", "BILLING_FAULT"]);
const VALID_BILLING_ACTIONS = new Set(["NONE", "RELEASE", "COMMIT", "ROLLBACK"]);

describe("errorPolicy.js Unit Tests (§3 & §8)", () => {
  it("should have all required fields for every code in ERROR_POLICY", () => {
    const codes = Object.keys(ERROR_POLICY);
    assert.ok(codes.length >= 6, "ERROR_POLICY must have at least the 6 baseline codes");

    for (const code of codes) {
      const entry = ERROR_POLICY[code];
      assert.ok(entry, `Entry for ${code} must exist`);
      assert.ok(VALID_CATEGORIES.has(entry.category), `Code ${code} has invalid category: ${entry.category}`);
      assert.equal(typeof entry.retryable, "boolean", `Code ${code} retryable must be boolean`);
      assert.ok(VALID_BILLING_ACTIONS.has(entry.billingAction), `Code ${code} has invalid billingAction: ${entry.billingAction}`);
      assert.equal(typeof entry.statusCode, "number", `Code ${code} statusCode must be number`);
      assert.ok(entry.statusCode >= 400 && entry.statusCode < 600, `Code ${code} statusCode must be HTTP error status`);
      assert.equal(typeof entry.userMessage, "string", `Code ${code} userMessage must be string`);
      assert.ok(entry.userMessage.length > 0, `Code ${code} userMessage must not be empty`);
    }
  });

  describe("Specific Policy Rules Verification", () => {
    it("PROVIDER_TIMEOUT: UPSTREAM_FAULT, retryable=true, RELEASE, 502", () => {
      const policy = ERROR_POLICY.PROVIDER_TIMEOUT;
      assert.equal(policy.category, "UPSTREAM_FAULT");
      assert.equal(policy.retryable, true);
      assert.equal(policy.billingAction, "RELEASE");
      assert.equal(policy.statusCode, 502);
    });

    it("PROVIDER_QUOTA_EXCEEDED: SERVER_FAULT, retryable=false, RELEASE, 500", () => {
      const policy = ERROR_POLICY.PROVIDER_QUOTA_EXCEEDED;
      assert.equal(policy.category, "SERVER_FAULT");
      assert.equal(policy.retryable, false);
      assert.equal(policy.billingAction, "RELEASE");
      assert.equal(policy.statusCode, 500);
      assert.doesNotMatch(policy.userMessage, /quota|provider/i, "Must not leak quota or provider to user");
    });

    it("CONTENT_SAFETY_VIOLATION: USER_FAULT, retryable=false, RELEASE, 422", () => {
      const policy = ERROR_POLICY.CONTENT_SAFETY_VIOLATION;
      assert.equal(policy.category, "USER_FAULT");
      assert.equal(policy.retryable, false);
      assert.equal(policy.billingAction, "RELEASE");
      assert.equal(policy.statusCode, 422);
      assert.match(policy.userMessage, /content policy/i);
    });

    it("INSUFFICIENT_CREDITS: BILLING_FAULT, retryable=false, NONE, 402", () => {
      const policy = ERROR_POLICY.INSUFFICIENT_CREDITS;
      assert.equal(policy.category, "BILLING_FAULT");
      assert.equal(policy.retryable, false);
      assert.equal(policy.billingAction, "NONE");
      assert.equal(policy.statusCode, 402);
      assert.match(policy.userMessage, /credits/i);
    });

    it("PROVIDER_AUTH_FAILED: SERVER_FAULT, retryable=false, ROLLBACK, 500", () => {
      const policy = ERROR_POLICY.PROVIDER_AUTH_FAILED;
      assert.equal(policy.category, "SERVER_FAULT");
      assert.equal(policy.retryable, false);
      assert.equal(policy.billingAction, "ROLLBACK");
      assert.equal(policy.statusCode, 500);
    });

    it("PROGRAMMER_ERROR: SERVER_FAULT, retryable=false, ROLLBACK, 500", () => {
      const policy = ERROR_POLICY.PROGRAMMER_ERROR;
      assert.equal(policy.category, "SERVER_FAULT");
      assert.equal(policy.retryable, false);
      assert.equal(policy.billingAction, "ROLLBACK");
      assert.equal(policy.statusCode, 500);
    });
  });
});
