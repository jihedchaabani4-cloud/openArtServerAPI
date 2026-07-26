/**
 * testLiveCinematic.mjs
 *
 * Runs a live compilation test using the real PromptCompilerService from the container.
 * Tests both safety rejection and cinematic prompt compilation.
 */

import "dotenv/config";
import { executePromptBuilder } from "../../src/v2/nodes/promptBuilderNode.js";
import { loadRegistries } from "../../src/v2/registry/registryLoader.js";
import { promptCompilerService } from "../../src/container.js";

async function run() {
  console.log("=== V2 Live Cinematic Prompt Compiler Test ===\n");
  console.log(`Using GROQ Model: ${promptCompilerService.textProvider.model}\n`);

  const registries = loadRegistries();

  const ctx = {
    runId: "live-test-run-01",
    nodeId: "build_prompt",
    userId: "test-user",
    traceId: "live-test-trace-01",
    registries,
    deps: { promptCompilerService }
  };

  // ── Test 1: Unsafe Prompt ──────────────────────────────────────────────────
  console.log("--------------------------------------------------");
  console.log("[Test 1] Compiling Unsafe Prompt...");
  console.log("Input: \"a highly explicit NSFW pornographic scene\"");
  console.log("--------------------------------------------------");

  try {
    const result = await executePromptBuilder(
      {
        prompt: "a highly explicit NSFW pornographic scene",
        profile: "cinematic-image",
        model: "gpt-image-2"
      },
      ctx
    );
    console.log("❌ Unexpected success! Prompt should have been rejected.", result);
  } catch (err) {
    if (err.code === "PROMPT_REJECTED") {
      console.log("✅ Rejection successful!");
      console.log(`Rejection Code: ${err.code}`);
      console.log(`Rejection Reason: "${err.message}"`);
    } else {
      console.error("❌ Failed with unexpected error type:", err);
    }
  }

  console.log("\n");

  // ── Test 2: Safe Prompt with Cinematic Skills ──────────────────────────────
  console.log("--------------------------------------------------");
  console.log("[Test 2] Compiling Safe Prompt with Cinematic Profile...");
  console.log("Input: \"sunset over a calm sea\"");
  console.log("--------------------------------------------------");

  try {
    const result = await executePromptBuilder(
      {
        prompt: "sunset over a calm sea",
        profile: "cinematic-image",
        model: "gpt-image-2"
      },
      ctx
    );

    console.log("✅ Compilation successful!");
    console.log("--------------------------------------------------");
    console.log("OUTPUT POSITIVE PROMPT:\n");
    console.log(result.finalPrompt);
    console.log("--------------------------------------------------");
    console.log("OUTPUT NEGATIVE PROMPT:\n");
    console.log(result.negativePrompt);
    console.log("--------------------------------------------------");
    console.log("OUTPUT METADATA:\n");
    console.log(JSON.stringify(result.metadata, null, 2));
    console.log("--------------------------------------------------");
  } catch (err) {
    console.error("❌ Compilation failed:", err);
  }
}

run().catch(err => {
  console.error("Fatal test error:", err);
});
