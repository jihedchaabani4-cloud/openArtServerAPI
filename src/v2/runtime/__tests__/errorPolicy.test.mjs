import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ERROR_CATEGORIES,
  DEFAULT_APOLOGY_MESSAGE,
  RUNTIME_ERROR_CODES,
  getErrorDecision,
  normalizeCode,
  formatWorkflowError,
  toRuntimeError,
  sanitizeClientError,
  processSystemError,
  ErrorSystem,
} from "../errorPolicy.js";

describe("Centralized Error Policy & Classification System", () => {
  describe("1. USER_FAULT classification", () => {
    it("should classify CONTENT_SAFETY_VIOLATION as USER_FAULT with clear safety message", () => {
      const decision = getErrorDecision(RUNTIME_ERROR_CODES.CONTENT_SAFETY_VIOLATION);
      assert.equal(decision.category, ERROR_CATEGORIES.USER_FAULT);
      assert.equal(decision.retryable, false);
      assert.equal(decision.billingAction, "rollback");
      assert.match(decision.userMessage, /content safety policy/i);
      assert.notEqual(decision.userMessage, DEFAULT_APOLOGY_MESSAGE);
    });

    it("should classify PROVIDER_CONTENT_POLICY_ERROR as USER_FAULT", () => {
      const decision = getErrorDecision("PROVIDER_CONTENT_POLICY_ERROR");
      assert.equal(decision.category, ERROR_CATEGORIES.USER_FAULT);
      assert.match(decision.userMessage, /content safety policy/i);
    });

    it("should semantically detect NSFW / sexual keywords in error message as USER_FAULT", () => {
      const rawError = new Error("Fal AI blocked request: Prompt contains NSFW explicit content");
      const decision = getErrorDecision(rawError);
      assert.equal(decision.code, RUNTIME_ERROR_CODES.CONTENT_SAFETY_VIOLATION);
      assert.equal(decision.category, ERROR_CATEGORIES.USER_FAULT);
      assert.match(decision.userMessage, /content safety policy/i);
    });

    it("should classify INVALID_INPUT and VALIDATION_ERROR as USER_FAULT", () => {
      const decision = getErrorDecision(RUNTIME_ERROR_CODES.INVALID_INPUT);
      assert.equal(decision.category, ERROR_CATEGORIES.USER_FAULT);
      assert.match(decision.userMessage, /invalid generation settings/i);
    });
  });

  describe("2. BILLING_FAULT classification", () => {
    it("should classify INSUFFICIENT_CREDITS as BILLING_FAULT with wallet top-up message", () => {
      const decision = getErrorDecision(RUNTIME_ERROR_CODES.INSUFFICIENT_CREDITS);
      assert.equal(decision.category, ERROR_CATEGORIES.BILLING_FAULT);
      assert.equal(decision.billingAction, "none");
      assert.match(decision.userMessage, /enough credits/i);
      assert.notEqual(decision.userMessage, DEFAULT_APOLOGY_MESSAGE);
    });

    it("should semantically detect 'not enough credits' message as BILLING_FAULT", () => {
      const rawError = new Error("User 123 has not enough credits for this operation");
      const decision = getErrorDecision(rawError);
      assert.equal(decision.code, RUNTIME_ERROR_CODES.INSUFFICIENT_CREDITS);
      assert.equal(decision.category, ERROR_CATEGORIES.BILLING_FAULT);
    });
  });

  describe("3. SERVER_FAULT classification (Zero Leakage + Apology Message)", () => {
    it("should classify CREDENTIAL_ERROR as SERVER_FAULT and return apology message", () => {
      const rawError = {
        code: "CREDENTIAL_ERROR",
        message: "Fal API Key 401 Unauthorized: Provider balance is $0.00",
      };
      const decision = getErrorDecision(rawError);
      assert.equal(decision.category, ERROR_CATEGORIES.SERVER_FAULT);
      assert.equal(decision.userMessage, DEFAULT_APOLOGY_MESSAGE);
      assert.doesNotMatch(decision.userMessage, /401|API Key|balance/i);
      assert.equal(decision.internalMessage, rawError.message);
    });

    it("should classify internal javascript bugs as SERVER_FAULT with apology message", () => {
      const rawError = new TypeError("Cannot read properties of undefined (reading 'url')");
      const decision = getErrorDecision(rawError);
      assert.equal(decision.category, ERROR_CATEGORIES.SERVER_FAULT);
      assert.equal(decision.userMessage, DEFAULT_APOLOGY_MESSAGE);
      assert.doesNotMatch(decision.userMessage, /TypeError|properties of undefined/i);
    });

    it("should classify PERSISTENCE_FAILED as SERVER_FAULT with apology message", () => {
      const decision = getErrorDecision(RUNTIME_ERROR_CODES.PERSISTENCE_FAILED);
      assert.equal(decision.category, ERROR_CATEGORIES.SERVER_FAULT);
      assert.equal(decision.userMessage, DEFAULT_APOLOGY_MESSAGE);
    });
  });

  describe("4. UPSTREAM_FAULT classification", () => {
    it("should classify PROVIDER_TIMEOUT as UPSTREAM_FAULT with apology message and retryable=true", () => {
      const decision = getErrorDecision(RUNTIME_ERROR_CODES.PROVIDER_TIMEOUT);
      assert.equal(decision.category, ERROR_CATEGORIES.UPSTREAM_FAULT);
      assert.equal(decision.retryable, true);
      assert.equal(decision.userMessage, DEFAULT_APOLOGY_MESSAGE);
    });

    it("should semantically detect 429 Too Many Requests as PROVIDER_RATE_LIMIT with apology", () => {
      const rawError = new Error("OpenAI error: 429 Too Many Requests");
      const decision = getErrorDecision(rawError);
      assert.equal(decision.code, RUNTIME_ERROR_CODES.PROVIDER_RATE_LIMIT);
      assert.equal(decision.category, ERROR_CATEGORIES.UPSTREAM_FAULT);
      assert.equal(decision.retryable, true);
      assert.equal(decision.userMessage, DEFAULT_APOLOGY_MESSAGE);
    });
  });

  describe("5. formatWorkflowError helper", () => {
    it("should format a clean, safe workflow run error payload for USER_FAULT", () => {
      const rawError = {
        code: "CONTENT_SAFETY_VIOLATION",
        message: "Blocked by safety filter",
      };
      const failedNode = { node_id: "image_gen_1" };
      const formatted = formatWorkflowError(rawError, failedNode);

      assert.equal(formatted.code, "CONTENT_SAFETY_VIOLATION");
      assert.equal(formatted.category, ERROR_CATEGORIES.USER_FAULT);
      assert.match(formatted.message, /content safety policy/i);
      assert.equal(formatted.nodeId, "image_gen_1");
      assert.equal(formatted.retryable, false);
      assert.equal(formatted.internalDetails, "Blocked by safety filter");
    });

    it("should format a safe workflow run error payload for SERVER_FAULT with apology message", () => {
      const rawError = new Error("Database connection failed: syntax error in persistence query");
      const failedNode = { node_id: "persistence_node" };
      const formatted = formatWorkflowError(rawError, failedNode);

      assert.equal(formatted.category, ERROR_CATEGORIES.SERVER_FAULT);
      assert.equal(formatted.message, DEFAULT_APOLOGY_MESSAGE);
      assert.equal(formatted.nodeId, "persistence_node");
      assert.match(formatted.internalDetails, /Database connection failed/i);
    });
  });

  describe("6. toRuntimeError helper for node envelopes", () => {
    it("should wrap error with category and userMessage for envelopes", () => {
      const envelopeErr = toRuntimeError(new Error("Generic server glitch"));
      assert.equal(envelopeErr.category, ERROR_CATEGORIES.SERVER_FAULT);
      assert.equal(envelopeErr.message, DEFAULT_APOLOGY_MESSAGE);
    });
  });

  describe("7. sanitizeClientError (Zero Information Leakage to End Users)", () => {
    it("should strip internal stack traces and secrets on SERVER_FAULT", () => {
      const internalServerCrash = {
        code: "INTERNAL_ERROR",
        message: "Database connection failed at postgres://user:secret_pass@127.0.0.1:5432/main",
        details: "Stack trace: at runQuery (db.js:123)",
        internalDetails: "Internal confidential SQL",
      };

      const sanitized = sanitizeClientError(internalServerCrash);

      // Client MUST receive only code, category, message, retryable
      assert.equal(sanitized.category, ERROR_CATEGORIES.SERVER_FAULT);
      assert.equal(sanitized.message, DEFAULT_APOLOGY_MESSAGE);
      assert.equal(sanitized.internalDetails, undefined);
      assert.equal(sanitized.details, undefined);
      assert.doesNotMatch(JSON.stringify(sanitized), /postgres|secret_pass|db\.js|Stack trace/i);
    });

    it("should return clear content safety violation on USER_FAULT", () => {
      const nsfwError = {
        code: "CONTENT_SAFETY_VIOLATION",
        message: "Fal content moderation flagged explicit sexual imagery",
      };

      const sanitized = sanitizeClientError(nsfwError);

      assert.equal(sanitized.category, ERROR_CATEGORIES.USER_FAULT);
      assert.match(sanitized.message, /content safety policy/i);
    });

    it("should return null for null input safely", () => {
      assert.equal(sanitizeClientError(null), null);
      assert.equal(sanitizeClientError(undefined), null);
    });
  });

  describe("8. processSystemError / ErrorSystem.process (Dual-View Decomposition)", () => {
    it("should cleanly separate user vs system vs actions for a server fault", () => {
      const serverErr = new Error("Provider fal.ai API key quota exceeded (balance $0)");
      serverErr.stack = "Error: Provider fal.ai...\n    at callFal (fal.js:42:11)";

      const result = ErrorSystem.process(serverErr, {
        nodeId: "flux_pro_node",
        runId: "run_abc123",
        userId: "user_789",
      });

      // 1. What the USER sees
      assert.equal(result.user.category, ERROR_CATEGORIES.SERVER_FAULT);
      assert.equal(result.user.message, DEFAULT_APOLOGY_MESSAGE);
      assert.equal(result.user.nodeId, "flux_pro_node");
      assert.equal(result.user.statusCode, 500);
      assert.doesNotMatch(JSON.stringify(result.user), /fal\.ai|quota|balance/i);

      // 2. What the SYSTEM sees
      assert.equal(result.system.nodeId, "flux_pro_node");
      assert.equal(result.system.traceId, "run_abc123");
      assert.equal(result.system.userId, "user_789");
      assert.match(result.system.rawMessage, /fal\.ai API key quota exceeded/i);
      assert.match(result.system.stack, /callFal/i);
      assert.ok(result.system.timestamp);

      // 3. Operational actions
      assert.equal(result.actions.billingAction, "rollback");
      assert.equal(result.actions.workflowAction, "stop");
      assert.equal(result.actions.shouldRefund, true);
    });

    it("should cleanly separate user vs system vs actions for an NSFW prompt violation", () => {
      const nsfwErr = new Error("Blocked: prompt contains explicit sexual content");

      const result = processSystemError(nsfwErr, { nodeId: "prompt_filter" });

      // 1. What the USER sees
      assert.equal(result.user.category, ERROR_CATEGORIES.USER_FAULT);
      assert.match(result.user.message, /content safety policy/i);
      assert.equal(result.user.statusCode, 422);

      // 2. What the SYSTEM sees
      assert.match(result.system.rawMessage, /explicit sexual content/i);

      // 3. Operational actions
      assert.equal(result.actions.billingAction, "rollback");
      assert.equal(result.actions.shouldRefund, true);
      assert.equal(result.actions.retryable, false);
    });
  });
});
