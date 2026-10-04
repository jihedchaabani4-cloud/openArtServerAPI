import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LLMService, llmService, ALLOWED_INTERNAL_REASONS } from "../../src/platform/ai/LLMService.js";
import { executeLLMNode } from "../../src/v2/nodes/llmNode.js";
import { ElementAnalysisService } from "../../src/domain/element/ElementAnalysisService.js";
import { PromptService } from "../../src/platform/ai/PromptService.js";

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

  // ── TEST 6: llmNode forwards run's userId to llmService ──
  it("TEST 6: executeLLMNode forwards context userId to llmService", async () => {
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
      await executeLLMNode(
        { userPrompt: "A futuristic city", systemPromptOverride: "Enrich prompt" },
        { runId: "run-abc-123", userId: "user-node-caller-888" }
      );

      assert.strictEqual(
        receivedUserId,
        "user-node-caller-888",
        "Expected executeLLMNode to forward ctx.userId to llmService.generate"
      );
    } finally {
      llmService.generate = originalGenerate;
    }
  });

  // ── TEST 7: ElementAnalysisService forwards userId to llmService.analyzeVision ──
  it("TEST 7: ElementAnalysisService forwards userId to llmService", async () => {
    let receivedUserId = null;
    const originalAnalyzeVision = llmService.analyzeVision;
    llmService.analyzeVision = async (params) => {
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
        "Expected ElementAnalysisService to forward userId to llmService.analyzeVision"
      );
    } finally {
      llmService.analyzeVision = originalAnalyzeVision;
    }
  });

  // ── TEST 8: PromptService optimizePrompt requires an authenticated userId ──
  it("TEST 8: PromptService optimizePrompt rejects when userId is missing", async () => {
    const promptService = new PromptService();
    await assert.rejects(
      async () => {
        await promptService.optimizePrompt("Make this prompt better", {
          // userId explicitly omitted
        });
      },
      /(userId is required|authenticated)/i,
      "Expected optimizePrompt without userId to throw"
    );
  });
});
