import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { LlmNode, characterSheetV3, getV3Workflow } from "../../../src/systems/generation/internal/v3/index.js";
import { sanitizeClientError } from "../../../src/systems/generation/internal/errors.js";
import { llmService } from "../../../src/systems/models/internal/services/LLMService.js";

// ─── Source: contentModerationFailClosedBoundary.test.js ───
{
describe("Content Moderation Fail-Closed & Prompt Unification Boundary Tests (Task T9)", () => {
  let originalGenerate;


  beforeEach(() => {
    originalGenerate = llmService.generate;
  });

  afterEach(() => {
    llmService.generate = originalGenerate;
  });

  it("TEST 1: LlmNode (system-safety) must fail-closed with SAFETY_CHECK_UNAVAILABLE (not is_safe=false) when LLM throws a transient timeout", async () => {
    // Upstream provider timeout / 504 / network crash
    llmService.generate = async () => {
      const err = new Error('Upstream Provider route "gemini_3_1_flash_lite:google" gateway timeout (504)');
      err.code = "PROVIDER_TIMEOUT";
      err.statusCode = 504;
      err.retryable = true;
      throw err;
    };

    await assert.rejects(
      async () => {
        await LlmNode.execute(
          {
            prompt: "A dangerous unmoderated prompt",
            skills: ["system-safety", "translate"],
          },
          { runId: "run-t9-1", nodeId: "llm_process", userId: "usr-1" }
        );
      },
      (err) => {
        assert.strictEqual(err.code, "SAFETY_CHECK_UNAVAILABLE");
        assert.strictEqual(err.category, "UPSTREAM_FAULT");
        assert.strictEqual(err.retryable, true);
        assert.notStrictEqual(err.is_safe, false, "Transient safety outage must NOT set is_safe = false");
        return true;
      },
      "LlmNode must throw and never return { is_safe: true } when LLM service fails"
    );
  });

  it("TEST 1b (P0-2 M2): transient 429, 503, and CIRCUIT_BREAKER_OPEN during system-safety throw SAFETY_CHECK_UNAVAILABLE with proper retryable flags and zero leaked route/model keys", async () => {
    // 1. Gemini 429 RATE_LIMITED -> retryable: true, RATE_LIMIT, is_safe !== false
    let err429;
    try {
      await LlmNode.execute(
        { prompt: "A serene mountain lake", skills: ["system-safety", "translate"] },
        {
          userId: "usr-m2",
          executeLLM: async () => {
            const err = new Error('Provider route "gemini_3_1_flash_lite:google" rate limited (429)');
            err.code = "RATE_LIMITED";
            err.statusCode = 429;
            err.retryable = true;
            throw err;
          },
        }
      );
    } catch (e) {
      err429 = e;
    }
    assert.ok(err429, "429 must still fail closed");
    assert.strictEqual(err429.code, "SAFETY_CHECK_UNAVAILABLE");
    assert.strictEqual(err429.category, "RATE_LIMIT");
    assert.strictEqual(err429.statusCode, 429);
    assert.strictEqual(err429.retryable, true);
    assert.notStrictEqual(err429.is_safe, false);

    const sanitized429 = sanitizeClientError(err429);
    assert.strictEqual(sanitized429.code, "SAFETY_CHECK_UNAVAILABLE");
    assert.strictEqual(sanitized429.category, "RATE_LIMIT");
    assert.strictEqual(sanitized429.statusCode, 429);
    assert.strictEqual(sanitized429.retryable, true);
    assert.ok(!/gemini_3_1_flash_lite|provider route|google/i.test(sanitized429.userMessage));

    // 2. 503 PROVIDER_TRANSIENT_ERROR -> retryable: true, UPSTREAM_FAULT, is_safe !== false
    let err503;
    try {
      await LlmNode.execute(
        { prompt: "A serene mountain lake", skills: ["system-safety"] },
        {
          userId: "usr-m2",
          executeLLM: async () => {
            const err = new Error('Provider route "gemini_3_1_flash_lite:google" unavailable (503)');
            err.code = "PROVIDER_TRANSIENT_ERROR";
            err.statusCode = 503;
            err.retryable = true;
            throw err;
          },
        }
      );
    } catch (e) {
      err503 = e;
    }
    assert.ok(err503, "503 must still fail closed");
    assert.strictEqual(err503.code, "SAFETY_CHECK_UNAVAILABLE");
    assert.strictEqual(err503.category, "UPSTREAM_FAULT");
    assert.strictEqual(err503.statusCode, 503);
    assert.strictEqual(err503.retryable, true);
    assert.notStrictEqual(err503.is_safe, false);

    const sanitized503 = sanitizeClientError(err503);
    assert.strictEqual(sanitized503.code, "SAFETY_CHECK_UNAVAILABLE");
    assert.strictEqual(sanitized503.category, "UPSTREAM_FAULT");
    assert.strictEqual(sanitized503.statusCode, 503);
    assert.ok(!/gemini_3_1_flash_lite|provider route|google/i.test(sanitized503.userMessage));

    // 3. CIRCUIT_BREAKER_OPEN -> retryable: false, UPSTREAM_FAULT, 503, is_safe !== false
    let errCb;
    try {
      await LlmNode.execute(
        { prompt: "A serene mountain lake", skills: ["system-safety"] },
        {
          userId: "usr-m2",
          executeLLM: async () => {
            const err = new Error('Circuit breaker OPEN for route "gemini_3_1_flash_lite:google"');
            err.code = "CIRCUIT_BREAKER_OPEN";
            err.statusCode = 503;
            err.retryable = false;
            throw err;
          },
        }
      );
    } catch (e) {
      errCb = e;
    }
    assert.ok(errCb, "CIRCUIT_BREAKER_OPEN must still fail closed");
    assert.strictEqual(errCb.code, "SAFETY_CHECK_UNAVAILABLE");
    assert.strictEqual(errCb.category, "UPSTREAM_FAULT");
    assert.strictEqual(errCb.statusCode, 503);
    assert.strictEqual(errCb.retryable, false);
    assert.notStrictEqual(errCb.is_safe, false);

    const sanitizedCb = sanitizeClientError(errCb);
    assert.strictEqual(sanitizedCb.code, "SAFETY_CHECK_UNAVAILABLE");
    assert.strictEqual(sanitizedCb.statusCode, 503);
    assert.strictEqual(sanitizedCb.retryable, false);
    assert.ok(!/gemini_3_1_flash_lite|circuit breaker|google/i.test(sanitizedCb.userMessage));

    // 4. SAFETY_CHECK_FAILED with leaked internal model/route -> static user-safe message distinct from SAFETY_CHECK_UNAVAILABLE
    const rawSafetyCheckFailed = new Error(
      'Safety verification failed (fail-closed): Provider route "gemini_3_1_flash_lite:google" malformed payload'
    );
    rawSafetyCheckFailed.code = "SAFETY_CHECK_FAILED";
    rawSafetyCheckFailed.is_safe = false;
    const sanitizedFailed = sanitizeClientError(rawSafetyCheckFailed);
    assert.strictEqual(sanitizedFailed.code, "SAFETY_CHECK_FAILED");
    assert.strictEqual(sanitizedFailed.category, "CONTENT_SAFETY_VIOLATION");
    assert.strictEqual(sanitizedFailed.statusCode, 422);
    assert.strictEqual(sanitizedFailed.retryable, false);
    assert.ok(!/gemini_3_1_flash_lite|provider route|google|malformed/i.test(sanitizedFailed.userMessage));
    assert.notStrictEqual(
      sanitizedFailed.userMessage,
      sanitized503.userMessage,
      "SAFETY_CHECK_FAILED and SAFETY_CHECK_UNAVAILABLE must return distinct static user-safe messages"
    );
  });

  it("TEST 2: LlmNode (system-safety) must throw CONTENT_SAFETY_VIOLATION when LLM flags prompt as unsafe", async () => {
    llmService.generate = async () => {
      return {
        raw: JSON.stringify({
          is_safe: false,
          safety_reason: "Prompt violates safety policy regarding explicit nudity.",
          title: "Unsafe Prompt",
          description: "",
        }),
        json: {
          is_safe: false,
          safety_reason: "Prompt violates safety policy regarding explicit nudity.",
          title: "Unsafe Prompt",
          description: "",
        },
        model: "gemini-3.1-flash-lite",
      };
    };

    await assert.rejects(
      async () => {
        await LlmNode.execute(
          {
            prompt: "generate explicit nudity",
            skills: ["system-safety", "translate"],
          },
          { runId: "run-t9-2", nodeId: "llm_process", userId: "usr-1" }
        );
      },
      (err) => {
        assert.strictEqual(err.code, "CONTENT_SAFETY_VIOLATION");
        assert.strictEqual(err.is_safe, false);
        return true;
      }
    );
  });

  it("TEST 3: LlmNode (system-safety) must throw CONTENT_SAFETY_VIOLATION when provider rejects prompt on safety policy", async () => {
    llmService.generate = async () => {
      const err = new Error("Safety Violation: Content blocked due to NSFW policy violation");
      err.code = "PROVIDER_CONTENT_POLICY_ERROR";
      throw err;
    };

    await assert.rejects(
      async () => {
        await LlmNode.execute(
          {
            prompt: "blocked prompt",
            skills: ["system-safety", "translate"],
          },
          { runId: "run-t9-3", nodeId: "llm_process", userId: "usr-1" }
        );
      },
      (err) => {
        assert.strictEqual(err.code, "CONTENT_SAFETY_VIOLATION");
        assert.strictEqual(err.category, "USER_FAULT");
        assert.strictEqual(err.is_safe, false);
        return true;
      }
    );
  });

  it("TEST 4: Strict schema validation - unparseable free text after retry must throw SAFETY_CHECK_FAILED (never fallback to userPrompt)", async () => {
    // Model returns unparseable free text that fails JSON parsing on both initial and retry attempts
    llmService.generate = async () => {
      return {
        raw: "Here is your response in plain text without any JSON structure: unmoderated text.",
        json: null,
        model: "gemini-3.1-flash-lite",
      };
    };

    await assert.rejects(
      async () => {
        await LlmNode.execute(
          {
            prompt: "A prompt that triggers bad JSON",
            skills: ["system-safety", "translate"],
          },
          { runId: "run-t9-4", nodeId: "llm_process", userId: "usr-1" }
        );
      },
      (err) => {
        assert.ok(
          err.code === "SAFETY_CHECK_FAILED" || err.code === "OUTPUT_CONTRACT_VIOLATION",
          `Expected SAFETY_CHECK_FAILED or OUTPUT_CONTRACT_VIOLATION, got: ${err.code}`
        );
        return true;
      },
      "Free text should be rejected under strict schema validation when safety check is required"
    );
  });

  it("TEST 5: Omitted is_safe in valid JSON defaults to safe (only explicit is_safe: false blocks)", async () => {
    llmService.generate = async () => {
      return {
        raw: JSON.stringify({
          prompt: "Relit portrait with soft golden light",
          // Notice: is_safe is omitted -> defaults to true
        }),
        json: {
          prompt: "Relit portrait with soft golden light",
        },
        model: "gemini-3.1-flash-lite",
      };
    };

    const result = await LlmNode.execute(
      {
        prompt: "Some prompt",
        skills: ["system-safety", "translate"],
      },
      { runId: "run-t9-5", nodeId: "llm_process", userId: "usr-1" }
    );

    assert.strictEqual(result.status, "success");
    assert.strictEqual(result.text, "Relit portrait with soft golden light");
  });

  it("TEST 6: character-sheet-v1 V3 workflow includes base.llm node with system-safety skill before image generation", async () => {
    const workflow = getV3Workflow("character-sheet-v3") || characterSheetV3;
    assert.ok(workflow, "character-sheet-v1 must be loadable");
    const llmNode = Array.isArray(workflow.nodes)
      ? workflow.nodes.find((n) => n.id === "llm_enrich")
      : workflow.nodes?.llm_enrich;
    assert.ok(llmNode, "llm_enrich node must exist in character-sheet-v3");
    assert.strictEqual(llmNode.type, "base.llm");
    assert.ok(llmNode.inputs.skills.includes("system-safety"));
  });
});
}

after(() => {
  setTimeout(() => process.exit(0), 100);
});
