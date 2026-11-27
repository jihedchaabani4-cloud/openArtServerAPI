import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { executeLLM } from "#models/tools";
import { LLMService, llmService, ALLOWED_INTERNAL_REASONS } from "../../../src/systems/models/internal/services/LLMService.js";
import { run as runGoogle } from "../../../src/systems/models/internal/runtime/google/runner.js";
import { LlmNode } from "../../../src/systems/workflow-engine/internal/nodes/index.js";
import { ElementAnalysisService } from "#elements/tools";

// ─── Source: llmServiceNoChargeBoundary.test.js ───
{
describe("LLMService NoCharge Defense & UserId Enforcement (Task T5)", () => {
  let capturedRunOptions = [];
  let mockExecutor;

  beforeEach(() => {
    capturedRunOptions = [];
    mockExecutor = {
      execute: async ({ options }) => {
        capturedRunOptions.push(options);
        return {
          content: JSON.stringify({
            is_safe: true,
            safety_reason: null,
            description: "Mock response text",
            prompt: "Mock response text",
            keywords: ["art", "vibrant"],
            references: [],
            generationConfig: {},
            optimized_prompt: "Optimized mock prompt",
            original_language: "en",
            was_translated: false,
            was_enhanced: true,
            changes_summary: "Enhanced",
          }),
          metadata: { modelId: "mock-model" },
        };
      },
    };
  });

  // ── TEST 1: Missing userId and missing internal flag must THROW ──
  it("TEST 1: No userId and no internal flag -> throws error", async () => {
    await assert.rejects(
      async () => {
        await llmService.generate({
          prompt: "Generate an image description",
          options: { runtimeExecutor: mockExecutor },
        });
      },
      /(userId is required|noCharge|internal)/i,
      "Expected call without userId or internal flag to throw"
    );
    assert.strictEqual(capturedRunOptions.length, 0, "No model execution should have been dispatched");
  });

  // ── TEST 2: Missing userId with unapproved/random internal reason must THROW ──
  it("TEST 2: No userId with unapproved reason -> throws error", async () => {
    await assert.rejects(
      async () => {
        await llmService.generate({
          prompt: "Generate an image description",
          options: {
            internal: true,
            reason: "hacker-custom-free-tier",
            runtimeExecutor: mockExecutor,
          },
        });
      },
      /(approved internal platform reason|userId is required|allowed reasons)/i,
      "Expected call with unapproved internal reason to throw"
    );
    assert.strictEqual(capturedRunOptions.length, 0, "No model execution should have been dispatched");
  });

  // ── TEST 3: Approved internal flag + reason succeeds on noCharge path ──
  it("TEST 3: Approved internal flag with valid reason -> permits noCharge execution", async () => {
    const res = await llmService.generate({
      prompt: "Internal system moderation",
      options: {
        isInternal: true,
        reason: "internal-platform-llm",
        runtimeExecutor: mockExecutor,
      },
    });

    assert.ok(res, "Expected response from internal execution");
    assert.strictEqual(capturedRunOptions.length, 1);
    assert.strictEqual(capturedRunOptions[0].noCharge, true);
    assert.strictEqual(capturedRunOptions[0].reason, "internal-platform-llm");
  });

  // ── TEST 4: Valid userId runs on charged path (noCharge is false) ──
  it("TEST 4: Call with valid userId -> runs on charged path", async () => {
    const res = await llmService.generate({
      prompt: "User prompted text",
      userId: "user-paid-123",
      options: { runtimeExecutor: mockExecutor },
    });

    assert.ok(res);
    assert.strictEqual(capturedRunOptions.length, 1);
    assert.strictEqual(capturedRunOptions[0].userId, "user-paid-123");
    assert.strictEqual(capturedRunOptions[0].noCharge, false);
  });

  // ── TEST 5: Untrusted request body attempting to set noCharge:true is neutralized ──
  it("TEST 5: Caller passing noCharge:true with userId has noCharge neutralized", async () => {
    const res = await llmService.generate({
      prompt: "User prompted text",
      userId: "user-paid-123",
      options: {
        noCharge: true,
        reason: "internal-platform-llm",
        internal: true,
        runtimeExecutor: mockExecutor,
      },
    });

    assert.ok(res);
    assert.strictEqual(capturedRunOptions.length, 1);
    assert.strictEqual(capturedRunOptions[0].userId, "user-paid-123");
    // Crucial invariant: when userId is present, noCharge CANNOT be true!
    assert.strictEqual(capturedRunOptions[0].noCharge, false);
  });

  // ── TEST 6: LlmNode forwards run's userId to llmService ──
  it("TEST 6: LlmNode forwards context userId to llmService", async () => {
    let receivedUserId = null;
    const originalGenerate = llmService.generate;
    llmService.generate = async (params) => {
      receivedUserId = params.userId || params.options?.userId;
      return {
        raw: JSON.stringify({ is_safe: true, prompt: "Enriched prompt" }),
        content: "Enriched prompt",
        json: { is_safe: true, prompt: "Enriched prompt" },
        model: "gemini-3.1-flash-lite",
        durationMs: 10,
      };
    };

    try {
      await LlmNode.execute(
        { prompt: "A futuristic city", skills: ["system-safety", "translate"] },
        { runId: "run-abc-123", userId: "user-node-caller-888" }
      );

      assert.strictEqual(
        receivedUserId,
        "user-node-caller-888",
        "Expected LlmNode to forward ctx.userId to llmService.generate"
      );
    } finally {
      llmService.generate = originalGenerate;
    }
  });

  // ── TEST 7: ElementAnalysisService forwards userId to executeLLM / llmService.generate ──
  it("TEST 7: ElementAnalysisService forwards userId to llmService", async () => {
    let receivedUserId = null;
    const originalGenerate = llmService.generate;
    llmService.generate = async (params) => {
      receivedUserId = params.userId || params.options?.userId;
      return {
        raw: JSON.stringify({ description: "Artistic style element", keywords: ["oil", "classic"] }),
        content: "Artistic style element",
        json: { description: "Artistic style element", keywords: ["oil", "classic"] },
      };
    };

    try {
      const service = new ElementAnalysisService();
      await service.analyzeElement({
        imageUrls: ["https://cdn.example.com/ref.png"],
        elementType: "style",
        userId: "user-element-owner-456",
      });

      assert.strictEqual(
        receivedUserId,
        "user-element-owner-456",
        "Expected ElementAnalysisService to forward userId to llmService.generate via executeLLM"
      );
    } finally {
      llmService.generate = originalGenerate;
    }
  });

  // ── TEST 9: executeLLM forwards timeoutMs and enforces a real per-call timeout ──
  it("TEST 9: executeLLM forwards timeoutMs to runtimeExecutor options", async () => {
    const res = await executeLLM({
      prompt: "Quick prompt",
      userId: "user-timeout-forward",
      timeoutMs: 15000,
      runtimeExecutor: mockExecutor,
    });

    assert.ok(res);
    assert.strictEqual(capturedRunOptions.length, 1);
    assert.strictEqual(capturedRunOptions[0].timeoutMs, 15000);
  });

  it("TEST 10: executeLLM rejects cleanly with transient PROVIDER_TIMEOUT when timeoutMs expires", async () => {
    let timerHandle = null;
    const hangingExecutor = {
      execute: () =>
        new Promise((resolve) => {
          timerHandle = setTimeout(() => resolve({ content: "too late" }), 5000);
          if (typeof timerHandle.unref === "function") timerHandle.unref();
        }),
    };

    try {
      await assert.rejects(
        async () => {
          await executeLLM({
            prompt: "Hanging prompt",
            userId: "user-timeout-expire",
            timeoutMs: 35,
            runtimeExecutor: hangingExecutor,
          });
        },
        (err) =>
          err.code === "PROVIDER_TIMEOUT" &&
          err.statusCode === 504 &&
          err.retryable === true
      );
    } finally {
      if (timerHandle) clearTimeout(timerHandle);
    }
  });

  it("TEST 11: Google runner aborts and rejects with transient PROVIDER_TIMEOUT on timeoutMs expiry", async () => {
    let capturedSignal = null;
    let timerHandle = null;
    const hangingSdkClient = {
      models: {
        generateContent: (sdkPayload) => {
          capturedSignal = sdkPayload.config?.abortSignal || null;
          return new Promise((resolve) => {
            timerHandle = setTimeout(() => resolve({ text: "late" }), 5000);
            if (typeof timerHandle.unref === "function") timerHandle.unref();
          });
        },
      },
    };

    try {
      await assert.rejects(
        async () => {
          await runGoogle({
            binding: { providerModelId: "gemini-3.1-flash-lite", sdkMethod: "generateContent" },
            payload: { prompt: "Test timeout" },
            credential: "test-key",
            timeoutMs: 35,
            options: { sdkClient: hangingSdkClient },
          });
        },
        (err) =>
          err.code === "PROVIDER_TIMEOUT" &&
          err.statusCode === 504 &&
          err.retryable === true
      );
      assert.ok(capturedSignal, "Expected AbortSignal to be passed into Google SDK config");
      assert.strictEqual(capturedSignal.aborted, true, "Expected AbortSignal to be aborted on timeout");
    } finally {
      if (timerHandle) clearTimeout(timerHandle);
    }
  });
});
}
