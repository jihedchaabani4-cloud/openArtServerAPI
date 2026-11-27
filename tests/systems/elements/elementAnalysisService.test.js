import { describe, it, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { LLMService, llmService } from "../../../src/systems/models/internal/services/LLMService.js";
import { LlmNode } from "../../../src/systems/workflow-engine/internal/nodes/index.js";
import { ElementAnalysisService } from "#elements/tools";
import { createElement, analyzeElement } from "../../../src/systems/elements/internal/controllers/elementController.js";
import { elementService, characterService, db } from "../../../src/container.js";
import { redisConnection, workerRedisConnection } from "#shared/redis";

// ─── Source: elementAnalysisBillingBoundary.test.js ───
{
/**
 * Boundary Tests: F1 — Element Analysis Billing Context & LLMService Callers
 *
 * Verifies:
 * 1. LLMService throws BILLING_CONTEXT_MISSING (code, statusCode 500, category SERVER_FAULT) when userId is missing
 * 2. Error message to client is clean and generic (no internal reasons/leaks)
 * 3. ElementAnalysisService forwards userId to LLMService
 * 4. POST /api/v2/elements works end-to-end with mocked LLM for an authenticated user
 * 5. POST /api/v2/elements/analyze returns clean 500 SERVER_FAULT error if billing context is missing
 * 6. CharacterGenerationService forwards userId to LLMService
 * 7. llmNode fails with BILLING_CONTEXT_MISSING when run has no userId (no free execution)
 */


after(async () => {
  try {
    await redisConnection.quit().catch(() => redisConnection.disconnect());
    await workerRedisConnection.quit().catch(() => workerRedisConnection.disconnect());
  } catch {}
});

describe("F1 — Element Analysis & LLMService Billing Context Boundary Tests", () => {
  let originalAnalyzeVision;
  let originalGenerate;

  beforeEach(() => {
    originalAnalyzeVision = llmService.analyzeVision;
    originalGenerate = llmService.generate;
  });

  afterEach(() => {
    llmService.analyzeVision = originalAnalyzeVision;
    llmService.generate = originalGenerate;
  });

  // ── TEST 1: Missing userId throws BILLING_CONTEXT_MISSING with statusCode 500 SERVER_FAULT ──
  it("TEST 1: LLMService throws BILLING_CONTEXT_MISSING with code, statusCode 500, category SERVER_FAULT, and clean message", async () => {
    try {
      await llmService.generate({
        prompt: "Describe this object",
        // userId and internal flag explicitly omitted
      });
      assert.fail("Should have thrown BILLING_CONTEXT_MISSING");
    } catch (err) {
      assert.strictEqual(err.code, "BILLING_CONTEXT_MISSING", "Error code must be BILLING_CONTEXT_MISSING");
      assert.strictEqual(err.statusCode, 500, "Error statusCode must be 500 (SERVER_FAULT), not 400 or generic");
      assert.strictEqual(err.category, "SERVER_FAULT", "Category must be SERVER_FAULT");
      // Message must be clean: should NOT leak internal reasons list
      assert.doesNotMatch(err.message, /internal-platform-llm/i, "Must not leak internal platform reasons to client");
      assert.match(err.message, /userId is required/i, "Message must state userId is required");
    }
  });

  // ── TEST 2: ElementAnalysisService throws BILLING_CONTEXT_MISSING when userId is omitted ──
  it("TEST 2: ElementAnalysisService propagates BILLING_CONTEXT_MISSING when userId is missing", async () => {
    const analysisService = new ElementAnalysisService();
    try {
      await analysisService.analyzeElement({
        imageUrls: ["https://cdn.example.com/item.png"],
        elementType: "object",
        userId: null,
      });
      assert.fail("Should have thrown BILLING_CONTEXT_MISSING");
    } catch (err) {
      assert.strictEqual(err.code, "BILLING_CONTEXT_MISSING");
      assert.strictEqual(err.statusCode, 500);
      assert.strictEqual(err.category, "SERVER_FAULT");
    }
  });

  // ── TEST 3: POST /api/v2/elements still works (LLM mocked) for an authenticated user ──
  it("TEST 3: POST /api/v2/elements creates element and forwards userId to LLM analysis", async () => {
    let capturedAnalysisUserId = null;
    llmService.generate = async (params) => {
      capturedAnalysisUserId = params.userId;
      if (!params.userId) {
        const err = new Error("User billing context required");
        err.code = "BILLING_CONTEXT_MISSING";
        err.statusCode = 500;
        throw err;
      }
      return {
        raw: JSON.stringify({ description: "Futuristic neon chair", keywords: ["neon", "cyberpunk"] }),
        content: "Futuristic neon chair",
        json: { description: "Futuristic neon chair", keywords: ["neon", "cyberpunk"] },
        model: "gemini-3.1-flash-lite",
      };
    };

    // Mock DB calls on elementService to isolate from live Supabase
    const originalDb = elementService.db;
    const originalMediaService = elementService.mediaService;

    elementService.db = {
      workflows: {
        createWorkflow: async ({ project_id, display_name }) => ({
          id: "wf-elem-test-1",
          project_id,
          display_name,
        }),
      },
      elements: {
        create: async (data) => ({
          id: "elem-test-1",
          ...data,
        }),
      },
    };

    elementService.mediaService = {
      addReferenceMedia: async () => ({
        media: { id: "media-elem-1", url: "https://cdn.example.com/elem1.png" },
        url: "https://cdn.example.com/elem1.png",
      }),
    };

    const originalFindByUser = db.projects?.findByUser;
    db.projects = {
      ...db.projects,
      findByUser: async (userId, id) => [{ id, user_id: userId }],
    };

    try {
      const mockReq = {
        user: { id: "user-auth-elem-999" },
        body: {
          name: "Neon Chair",
          projectId: "proj-elem-test",
          sourceImages: ["https://example.com/chair.png"],
          element_type: "object",
        },
      };

      let responseStatusCode = null;
      let responseBody = null;
      const mockRes = {
        status(code) {
          responseStatusCode = code;
          return this;
        },
        json(data) {
          responseBody = data;
          return this;
        },
      };

      await createElement(mockReq, mockRes);

      assert.strictEqual(responseStatusCode, 201, "Element creation must return 201 Created");
      assert.strictEqual(responseBody?.status, "created");
      assert.strictEqual(responseBody?.element?.id, "elem-test-1");

      // Give background non-blocking analysis a moment to trigger
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(capturedAnalysisUserId, "user-auth-elem-999", "Authenticated userId must reach LLMService");
    } finally {
      elementService.db = originalDb;
      elementService.mediaService = originalMediaService;
      if (db.projects) db.projects.findByUser = originalFindByUser;
    }
  });

  // ── TEST 4: POST /api/v2/elements/analyze returns clean 500 SERVER_FAULT error if billing context is missing ──
  it("TEST 4: POST /api/v2/elements/analyze returns 500 with clean error code when userId is missing", async () => {
    const mockReq = {
      user: null, // Missing billing context
      body: {
        projectId: "proj-1",
        workflowId: "wf-1",
        imageUrls: ["https://cdn.example.com/ref.png"],
        elementName: "Sample",
        elementType: "object",
      },
    };

    let responseStatusCode = null;
    let responseBody = null;
    const mockRes = {
      status(code) {
        responseStatusCode = code;
        return this;
      },
      json(data) {
        responseBody = data;
        return this;
      },
    };

    await analyzeElement(mockReq, mockRes);

    assert.strictEqual(responseStatusCode, 500, "Must return HTTP 500 (SERVER_FAULT) for server billing invariant failure");
    assert.strictEqual(responseBody?.error, true);
    assert.strictEqual(responseBody?.code, "INTERNAL_ERROR", "Response must contain generic INTERNAL_ERROR code for client");
    assert.ok(responseBody?.traceId, "Response must include traceId for debugging");
    assert.strictEqual(responseBody?.category, "SERVER_FAULT");
    assert.strictEqual(responseBody?.message, "An unexpected error occurred. Please try again later.", "Must return generic apology message to client");
  });

  // ── TEST 5: CharacterGenerationService forwards userId to LLMService ──
  it("TEST 5: CharacterGenerationService forwards userId to LLMService", async () => {
    let capturedUserId = null;
    llmService.generate = async (params) => {
      capturedUserId = params.userId;
      return {
        raw: JSON.stringify({ title: "Neon Samurai", description: "A cybernetic warrior", keywords: ["cyber", "neon"] }),
        content: "A cybernetic warrior",
        json: { title: "Neon Samurai", description: "A cybernetic warrior", keywords: ["cyber", "neon"] },
        model: "gemini-3.1-flash-lite",
      };
    };

    const result = await characterService.generateDescription({
      concept: "Cybernetic Ronin",
      userId: "user-char-auth-777",
    });

    assert.ok(result);
    assert.strictEqual(capturedUserId, "user-char-auth-777", "generateDescription must forward userId to llmService");
  });

  // ── TEST 6: Workflow run with LlmNode without userId fails with BILLING_CONTEXT_MISSING (no LLM call, no free execution) ──
  it("TEST 6: LlmNode without userId fails with BILLING_CONTEXT_MISSING, never free execution", async () => {
    // Node invoked with null userId (e.g. ad-hoc or unauthenticated run)
    await assert.rejects(
      async () => {
        await LlmNode.execute(
          { prompt: "A beautiful landscape", skills: ["system-safety"] },
          { runId: "run-no-user", userId: null }
        );
      },
      (err) => {
        assert.strictEqual(err.code, "BILLING_CONTEXT_MISSING", "Must throw BILLING_CONTEXT_MISSING");
        assert.strictEqual(err.statusCode, 500, "Status code must be 500");
        assert.strictEqual(err.category, "SERVER_FAULT", "Category must be SERVER_FAULT");
        return true;
      }
    );
  });

  // ── TEST 8: LlmNode uses ONLY ctx.userId and ignores spoofed inputs.userId ──
  it("TEST 8: LlmNode derives userId ONLY from ctx.userId, ignoring spoofed input.userId", async () => {
    let capturedUserId = null;
    llmService.generate = async (params) => {
      capturedUserId = params.userId;
      if (!params.userId) {
        const err = new Error("Billing context missing");
        err.code = "BILLING_CONTEXT_MISSING";
        err.statusCode = 500;
        throw err;
      }
      return {
        raw: JSON.stringify({ is_safe: true, prompt: "clean" }),
        content: JSON.stringify({ is_safe: true, prompt: "clean" }),
        json: { is_safe: true, prompt: "clean" },
        model: "gemini-3.1-flash-lite",
      };
    };

    await LlmNode.execute(
      {
        prompt: "A landscape",
        skills: ["system-safety"],
        userId: "victim-attacker-spoofed-id", // Malicious spoof in input
      },
      {
        runId: "run-spoof-test",
        userId: "server-authenticated-user-123", // Server-side context
      }
    );

    assert.strictEqual(
      capturedUserId,
      "server-authenticated-user-123",
      "Attributed userId must come strictly from ctx.userId, never inputs.userId"
    );

    // Subcase 8B: Context has NO userId (ctx.userId: null), but input carries a victim's userId
    // Must reject with BILLING_CONTEXT_MISSING rather than charging the spoofed victim!
    await assert.rejects(
      async () => {
        await LlmNode.execute(
          {
            prompt: "A landscape",
            skills: ["system-safety"],
            userId: "victim-attacker-spoofed-id",
          },
          {
            runId: "run-spoof-no-context-user",
            userId: null,
          }
        );
      },
      (err) => {
        assert.strictEqual(err.code, "BILLING_CONTEXT_MISSING");
        return true;
      }
    );
  });

  // ── TEST 9: Regression for code-review bugs (authClient.getUserById, workflowSync.updateById, positional getWorkflowVisualMedia) ──
  it("TEST 9: authClient exposes getUserById for checkout and ElementAnalysisService delegates workflowSync + positional visual media", async () => {
    const { authClient } = await import("../../../src/systems/identity/internal/db/authClient.js");
    assert.strictEqual(typeof authClient.getUserById, "function", "authClient.getUserById must exist for checkout flow");

    const updatedCalls = [];
    const analysis = new ElementAnalysisService({
      workflowSync: {
        findWorkflow: async (id) => ({ id, metadata: { existing: true }, element_type: "style" }),
        updateWorkflow: async (id, patch) => {
          updatedCalls.push({ id, patch });
          return { id, ...patch };
        },
      },
    });

    await analysis.persistElementMetadata("wf-elem-sync-1", { description: "Warm cinema tone" });
    assert.strictEqual(updatedCalls.length, 1);
    assert.strictEqual(updatedCalls[0].id, "wf-elem-sync-1");
    assert.deepStrictEqual(updatedCalls[0].patch, {
      metadata: { existing: true, description: "Warm cinema tone" },
    });

    const ctx = await analysis.fetchWorkflowContext("proj-1", "wf-elem-sync-1");
    assert.strictEqual(ctx.elementType, "style");
    assert.ok(Array.isArray(ctx.urls));
  });
});
}
