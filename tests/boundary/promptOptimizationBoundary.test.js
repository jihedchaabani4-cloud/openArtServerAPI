import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import promptRouter from "../../routes/prompt.js";
import { RATE_LIMIT_POLICIES } from "../../src/config/rateLimitPolicies.js";
import { promptService } from "../../src/container.js";

describe("Prompt Optimization Security & Boundary Tests (Task T1)", () => {
  let server;
  let baseUrl;
  const testSecret = "test-internal-secret-phase0";
  const originalSecret = process.env.INTERNAL_SECRET;
  let originalOptimizePrompt;

  before(async () => {
    process.env.INTERNAL_SECRET = testSecret;

    const app = express();
    app.use(express.json());
    app.use("/api/prompt", promptRouter);
    app.use((err, req, res, next) => {
      res.status(err.statusCode || 500).json({
        ok: false,
        message: err.message,
      });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    process.env.INTERNAL_SECRET = originalSecret;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    setTimeout(() => process.exit(0), 100);
  });

  beforeEach(() => {
    originalOptimizePrompt = promptService.optimizePrompt;
    // Default safe stub to guarantee NO real provider/LLM calls under any circumstances
    promptService.optimizePrompt = async (prompt, opts = {}) => ({
      optimized: `Optimized: ${prompt}`,
      originalLanguage: "en",
      wasTranslated: false,
      wasEnhanced: true,
      changesSummary: "Enhanced for testing",
    });
  });

  afterEach(() => {
    promptService.optimizePrompt = originalOptimizePrompt;
  });

  it("TEST 1: Configuration: promptOptimization policy is defined in RATE_LIMIT_POLICIES", () => {
    const policy = RATE_LIMIT_POLICIES.promptOptimization;
    assert.ok(policy, "RATE_LIMIT_POLICIES.promptOptimization must be defined");
    assert.strictEqual(policy.points, 30, "promptOptimization points must be 30");
    assert.strictEqual(policy.duration, 60, "promptOptimization duration must be 60s");
    assert.strictEqual(policy.keyBy, "user", "promptOptimization keyBy must be 'user'");
  });

  it("TEST 2: Authentication: rejects unauthenticated requests with 401", async () => {
    const res = await fetch(`${baseUrl}/api/prompt/optimize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "A cinematic portrait of an astronaut" }),
    });

    const body = await res.json();
    assert.strictEqual(res.status, 401, `Expected status 401 but got ${res.status}`);
    assert.strictEqual(body.ok, false);
  });

  it("TEST 3: Identity & Billing: forwards authenticated userId to promptService", async () => {
    let capturedOptions = null;

    promptService.optimizePrompt = async (prompt, opts) => {
      capturedOptions = opts;
      return {
        optimized: "Cinematic portrait, volumetric lighting",
        originalLanguage: "en",
        wasTranslated: false,
        wasEnhanced: true,
        changesSummary: "Enhanced lighting",
      };
    };

    const res = await fetch(`${baseUrl}/api/prompt/optimize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": testSecret,
        "x-user-id": "user-test-777",
      },
      body: JSON.stringify({ prompt: "A cinematic portrait" }),
    });

    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.optimized, "Cinematic portrait, volumetric lighting");

    assert.ok(capturedOptions, "promptService.optimizePrompt must be called with options");
    assert.strictEqual(capturedOptions.userId, "user-test-777", "userId must be passed to promptService");
  });

  it("TEST 4: PromptService.optimizePrompt forwards userId into completeJSON options", async () => {
    // Test the real PromptService.prototype.optimizePrompt method
    const realOptimizePrompt = originalOptimizePrompt.bind(promptService);
    let capturedLlmOptions = null;
    const originalCompleteJSON = promptService.completeJSON;

    promptService.completeJSON = async ({ systemPrompt, userPrompt, temperature, options }) => {
      capturedLlmOptions = options;
      return {
        optimized_prompt: "Enhanced prompt",
        original_language: "en",
        was_translated: false,
        was_enhanced: true,
        changes_summary: "summary",
      };
    };

    try {
      await realOptimizePrompt("A cute puppy", {
        mode: "image",
        userId: "user-test-999",
      });

      assert.ok(capturedLlmOptions, "completeJSON must receive options");
      assert.strictEqual(
        capturedLlmOptions.userId,
        "user-test-999",
        "completeJSON options must include userId to prevent noCharge bypass"
      );
    } finally {
      promptService.completeJSON = originalCompleteJSON;
    }
  });

  it("TEST 5: Rate Limiting: blocks requests exceeding limit with 429 and Retry-After", async () => {
    const rateLimitedUser = "user-rate-limited-123";

    // Hit endpoint 30 times (allowed)
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${baseUrl}/api/prompt/optimize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": testSecret,
          "x-user-id": rateLimitedUser,
        },
        body: JSON.stringify({ prompt: `Prompt request ${i}` }),
      });
      assert.strictEqual(res.status, 200, `Request ${i + 1} should succeed`);
    }

    // 31st request should be blocked with 429
    const blockedRes = await fetch(`${baseUrl}/api/prompt/optimize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": testSecret,
        "x-user-id": rateLimitedUser,
      },
      body: JSON.stringify({ prompt: "Exceeded prompt" }),
    });

    assert.strictEqual(blockedRes.status, 429, "31st request must be rate limited with 429");
    const blockedBody = await blockedRes.json();
    assert.strictEqual(blockedBody.ok, false);
    assert.strictEqual(blockedBody.code, "RATE_LIMIT_EXCEEDED");
    assert.ok(blockedRes.headers.get("retry-after"), "Must include Retry-After header");
  });
});
