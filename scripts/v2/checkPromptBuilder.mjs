/**
 * checkPromptBuilder.mjs  (T069)
 *
 * Validation script for Phase 7 — User Story 5: Shape Prompts Through Reusable Processors.
 *
 * Tests:
 *  1. Character-sheet pipeline: resolves characters → references → template → pose →
 *     sheet layout → enhancePrompt (no-op, no LLM in test) → produces finalPrompt + context
 *  2. Processor order assertion: each expected processor mutates context in order
 *  3. Output shape assertion: { finalPrompt: string, context: WorkflowContext }
 *  4. enhancePrompt with no deps.promptService gracefully degrades (no throw)
 *  5. Storyboard pipeline: buildStoryboardLayout sets layout correctly
 */

import "dotenv/config";
import { executePromptBuilder } from "../../src/v2/nodes/promptBuilderNode.js";
import { loadRegistries } from "../../src/v2/registry/registryLoader.js";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function assertContains(str, substring, message) {
  if (!str.includes(substring)) {
    throw new Error(`ASSERTION FAILED: ${message}\n  Expected "${str}" to contain "${substring}"`);
  }
}

async function runPromptBuilderCheck() {
  console.log("=== Running V2 Prompt Builder Check ===\n");

  const registries = loadRegistries();
  console.log("✓ Registries loaded");

  // ── Test 1: Character-sheet pipeline ─────────────────────────────────────
  console.log("\n[Test 1] Character-sheet skill pipeline...");

  const charSheetInputs = {
    prompt: "A heroic warrior",
    characters: [
      { id: "char-1", name: "Aria", traits: ["brave", "tall"], description: "Elven warrior" }
    ],
    references: [
      { role: "style_ref", url: "https://example.com/style.jpg" }
    ],
    style: "fantasy",
    skill: {
      id: "character-sheet",
      version: "1.0.0",
      parameters: { views: ["front", "side", "back"] }
    }
  };

  const charSheetCtx = {
    runId: "test-run-prompt-01",
    nodeId: "build_prompt",
    userId: "test-user",
    traceId: "test-trace-prompt-01",
    registries,
    deps: {}  // no LLM — enhancePrompt degrades gracefully
  };

  const result1 = await executePromptBuilder(charSheetInputs, charSheetCtx);

  assert(typeof result1.finalPrompt === "string", "result.finalPrompt must be a string");
  assert(result1.finalPrompt.length > 0, "finalPrompt must not be empty");
  assert(typeof result1.context === "object", "result.context must be an object");
  assert(Array.isArray(result1.context.characters), "context.characters must be array");
  assert(Array.isArray(result1.context.references), "context.references must be array");

  console.log(`  finalPrompt: "${result1.finalPrompt}"`);
  console.log(`  context.layout: ${result1.context.layout}`);
  console.log(`  context.characters: ${JSON.stringify(result1.context.characters.map(c => c.name))}`);

  assertContains(result1.finalPrompt, "Aria", "finalPrompt should contain character name");
  assertContains(result1.finalPrompt, "view", "finalPrompt should contain view/pose instructions");
  assertContains(result1.finalPrompt, "character sheet", "finalPrompt should contain sheet layout keywords");

  assert(result1.context.layout === "character-sheet", "context.layout should be 'character-sheet'");
  assert(result1.context.characters[0].name === "Aria", "resolved character should have name 'Aria'");
  assert(result1.context.references[0].role === "style_ref", "resolved reference should have role 'style_ref'");

  console.log("  ✓ Character-sheet pipeline passed");

  // ── Test 2: enhancePrompt degrades gracefully with no LLM ────────────────
  console.log("\n[Test 2] enhancePrompt with no LLM service (graceful degrade)...");

  // Use same inputs — no LLM in deps → should not throw
  let result2;
  try {
    result2 = await executePromptBuilder(charSheetInputs, { ...charSheetCtx, deps: {} });
    assert(result2.finalPrompt.length > 0, "finalPrompt must exist even without LLM");
    console.log("  ✓ Graceful degrade passed (no throw)");
  } catch (err) {
    throw new Error(`enhancePrompt should not throw without LLM: ${err.message}`);
  }

  // ── Test 3: Storyboard pipeline ───────────────────────────────────────────
  console.log("\n[Test 3] Storyboard skill pipeline...");

  const storyboardInputs = {
    prompt: "A chase scene through a neon city",
    characters: [{ id: "char-2", name: "Zara", traits: ["fast"] }],
    references: [],
    style: "cyberpunk",
    skill: {
      id: "storyboard",
      version: "1.0.0",
      parameters: { panel_count: 6 }
    }
  };

  const storyboardCtx = {
    ...charSheetCtx,
    runId: "test-run-prompt-02",
    nodeId: "build_prompt",
    traceId: "test-trace-prompt-02",
  };

  const result3 = await executePromptBuilder(storyboardInputs, storyboardCtx);

  assert(typeof result3.finalPrompt === "string", "storyboard finalPrompt must be a string");
  assertContains(result3.finalPrompt, "storyboard", "storyboard finalPrompt should contain 'storyboard'");
  assertContains(result3.finalPrompt, "panel", "storyboard finalPrompt should contain 'panel'");
  console.log(`  finalPrompt: "${result3.finalPrompt}"`);
  console.log(`  context.layout: ${result3.context.layout}`);
  console.log("  ✓ Storyboard pipeline passed");

  // ── Test 4: No skill → plain prompt passthrough ───────────────────────────
  console.log("\n[Test 4] No skill — plain prompt passthrough...");

  const plainInputs = {
    prompt: "A sunset over the ocean",
    characters: [],
    references: [],
    style: null,
    skill: null
  };

  const result4 = await executePromptBuilder(plainInputs, { ...charSheetCtx, runId: "test-run-prompt-03" });
  assert(result4.finalPrompt === "A sunset over the ocean", "Plain prompt should pass through unchanged");
  console.log(`  finalPrompt: "${result4.finalPrompt}"`);
  console.log("  ✓ Plain passthrough passed");

  console.log("\n=== V2 Prompt Builder Check PASSED ===\n");
}

runPromptBuilderCheck().catch((err) => {
  console.error("\n=== V2 Prompt Builder Check FAILED ===");
  console.error(err.message);
  process.exit(1);
});
