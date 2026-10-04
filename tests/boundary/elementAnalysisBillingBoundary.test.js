/**
 * Boundary Tests: F1 — Element Analysis Billing Context & LLMService Callers
 *
 * Verifies:
 * 1. LLMService throws BILLING_CONTEXT_MISSING (code, statusCode 400) when userId is missing
 * 2. Error message to client is clean (no internal reasons/leaks)
 * 3. ElementAnalysisService forwards userId to LLMService
 * 4. POST /api/v2/elements works end-to-end with mocked LLM for an authenticated user
 * 5. POST /api/v2/elements/analyze returns clean 400 error if billing context is missing
 * 6. CharacterGenerationService forwards userId to LLMService
 */

import { describe, it, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { llmService, LLMService } from "../../src/platform/ai/LLMService.js";
import { ElementAnalysisService } from "../../src/domain/element/ElementAnalysisService.js";
import { createElement, analyzeElement } from "../../controllers/elementController.js";
import { elementService, characterService, db } from "../../src/container.js";

after(() => {
  setTimeout(() => process.exit(0), 100).unref();
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

  // ── TEST 1: Missing userId throws BILLING_CONTEXT_MISSING with statusCode 400 ──
  it("TEST 1: LLMService throws BILLING_CONTEXT_MISSING with code, statusCode 400, and clean message", async () => {
    try {
      await llmService.generate({
        prompt: "Describe this object",
        // userId and internal flag explicitly omitted
      });
      assert.fail("Should have thrown BILLING_CONTEXT_MISSING");
    } catch (err) {
      assert.strictEqual(err.code, "BILLING_CONTEXT_MISSING", "Error code must be BILLING_CONTEXT_MISSING");
      assert.strictEqual(err.statusCode, 400, "Error statusCode must be 400 (Bad Request), not 500");
      // Message must be clean: should NOT leak internal reasons list
      assert.doesNotMatch(err.message, /internal-platform-llm/i, "Must not leak internal platform reasons to client");
      assert.match(err.message, /billing context|userId/i, "Message must clearly state billing context is required");
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
      assert.strictEqual(err.statusCode, 400);
    }
  });

  // ── TEST 3: POST /api/v2/elements still works (LLM mocked) for an authenticated user ──
  it("TEST 3: POST /api/v2/elements creates element and forwards userId to LLM analysis", async () => {
    let capturedAnalysisUserId = null;
    llmService.analyzeVision = async (params) => {
      capturedAnalysisUserId = params.userId;
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
      ingestElementSources: async ({ workflowId, sourceImages, userId }) => ({
        mediaRecords: [{ id: "media-elem-1", url: "https://cdn.example.com/elem1.png" }],
        primaryMedia: { id: "media-elem-1", url: "https://cdn.example.com/elem1.png" },
        storageUrls: ["https://cdn.example.com/elem1.png"],
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

  // ── TEST 4: POST /api/v2/elements/analyze returns clean 400 error if billing context is missing ──
  it("TEST 4: POST /api/v2/elements/analyze returns 400 with clean error code when userId is missing", async () => {
    const mockReq = {
      user: null, // Unauthenticated / missing billing context
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

    assert.strictEqual(responseStatusCode, 400, "Must return HTTP 400 Bad Request, NOT 500");
    assert.strictEqual(responseBody?.error, true);
    assert.strictEqual(responseBody?.code, "BILLING_CONTEXT_MISSING", "Response must contain BILLING_CONTEXT_MISSING code");
    assert.doesNotMatch(responseBody?.message || "", /internal-platform-llm/i, "Message must not leak internals");
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
});
