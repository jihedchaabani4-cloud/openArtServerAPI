import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { executeLLMNode } from "../../src/v2/nodes/llmNode.js";
import { llmService } from "../../src/platform/ai/LLMService.js";
import { loadRegistries } from "../../src/v2/registry/registryLoader.js";

describe("Content Moderation Fail-Closed & Prompt Unification Boundary Tests (Task T9)", () => {
  let originalGenerate;

  after(() => {
    setTimeout(() => process.exit(0), 100);
  });

  beforeEach(() => {
    originalGenerate = llmService.generate;
  });

  afterEach(() => {
    llmService.generate = originalGenerate;
  });

  it("TEST 1: executeLLMNode must fail-closed (throw SAFETY_CHECK_FAILED) when LLM throws an upstream error", async () => {
    // Upstream provider timeout / 504 / network crash
    llmService.generate = async () => {
      const err = new Error("Upstream Gemini API gateway timeout (504)");
      err.code = "PROVIDER_TIMEOUT";
      throw err;
    };

    // FAIL-OPEN BUG: Previously this caught the error and returned { is_safe: true, text: userPrompt }
    await assert.rejects(
      async () => {
        await executeLLMNode(
          {
            userPrompt: "A dangerous unmoderated prompt",
            skills: ["llm/system-safety", "llm/translate"],
            jsonMode: true,
          },
          { runId: "run-t9-1", nodeId: "llm_translate", userId: "usr-1" }
        );
      },
      (err) => {
        assert.ok(
          err.code === "SAFETY_CHECK_FAILED" || err.code === "PROVIDER_TIMEOUT",
          `Expected SAFETY_CHECK_FAILED or upstream error code, got: ${err.code}`
        );
        assert.strictEqual(err.is_safe, false, "Error must indicate is_safe is false");
        return true;
      },
      "executeLLMNode must throw and never return { is_safe: true } when LLM service fails"
    );
  });

  it("TEST 2: executeLLMNode must throw CONTENT_SAFETY_VIOLATION when LLM flags prompt as unsafe", async () => {
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
        await executeLLMNode(
          {
            userPrompt: "generate explicit nudity",
            skills: ["llm/system-safety"],
            jsonMode: true,
          },
          { runId: "run-t9-2", nodeId: "llm_translate", userId: "usr-1" }
        );
      },
      (err) => {
        assert.strictEqual(err.code, "CONTENT_SAFETY_VIOLATION");
        assert.strictEqual(err.is_safe, false);
        return true;
      }
    );
  });

  it("TEST 3: executeLLMNode must throw CONTENT_SAFETY_VIOLATION when provider rejects prompt on safety policy", async () => {
    llmService.generate = async () => {
      const err = new Error("Safety Violation: Content blocked due to NSFW policy violation");
      err.code = "PROVIDER_CONTENT_POLICY_ERROR";
      throw err;
    };

    await assert.rejects(
      async () => {
        await executeLLMNode(
          {
            userPrompt: "blocked prompt",
            skills: ["llm/system-safety"],
            jsonMode: true,
          },
          { runId: "run-t9-3", nodeId: "llm_translate", userId: "usr-1" }
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

    // FAIL-OPEN BUG: Previously normalizeStructuredJSON(null, userPrompt) returned { is_safe: true, prompt: userPrompt }
    await assert.rejects(
      async () => {
        await executeLLMNode(
          {
            userPrompt: "A prompt that triggers bad JSON",
            skills: ["llm/system-safety", "llm/json-output"],
            jsonMode: true,
          },
          { runId: "run-t9-4", nodeId: "llm_translate", userId: "usr-1" }
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

  it("TEST 5: Strict schema validation - missing or non-boolean is_safe in safety mode must throw validation error", async () => {
    llmService.generate = async () => {
      return {
        raw: JSON.stringify({
          title: "Test Title",
          description: "Some translated text",
          // Notice: is_safe is omitted!
        }),
        json: {
          title: "Test Title",
          description: "Some translated text",
        },
        model: "gemini-3.1-flash-lite",
      };
    };

    // FAIL-OPEN BUG: Previously `isSafe = parsed.is_safe !== false` defaulted to true when missing!
    await assert.rejects(
      async () => {
        await executeLLMNode(
          {
            userPrompt: "Some prompt",
            skills: ["llm/system-safety", "llm/translate"],
            jsonMode: true,
          },
          { runId: "run-t9-5", nodeId: "llm_translate", userId: "usr-1" }
        );
      },
      (err) => {
        assert.ok(
          err.code === "SAFETY_CHECK_FAILED" || err.code === "OUTPUT_CONTRACT_VIOLATION",
          `Expected schema validation failure, got: ${err.code}`
        );
        return true;
      },
      "Missing is_safe boolean in safety evaluation mode must fail closed"
    );
  });

  it("TEST 6: character-sheet-v1 workflow registers llm/system-safety skill on llm_enrich node", async () => {
    const registries = loadRegistries();
    const workflow = registries.workflows["character-sheet-v1"];
    assert.ok(workflow, "character-sheet-v1 must be loadable");
    const llmEnrichNode = workflow.nodes?.llm_enrich;
    assert.ok(llmEnrichNode, "llm_enrich node must exist in character-sheet-v1");
    const skills = llmEnrichNode.config?.skills || [];
    assert.ok(
      skills.includes("llm/system-safety"),
      `character-sheet-v1 llm_enrich must include "llm/system-safety", but had: ${JSON.stringify(skills)}`
    );
  });
});
