/**
 * testLiveCharacterSheet.mjs
 *
 * Runs a live test on the updated 3-panel character-sheet template
 * using the real LLM compiler service.
 */

import "dotenv/config";
import { executePromptBuilder } from "../../src/v2/nodes/promptBuilderNode.js";
import { loadRegistries } from "../../src/v2/registry/registryLoader.js";
import { promptCompilerService } from "../../src/container.js";

async function run() {
  console.log("=== V2 Live 3-Panel Character Sheet Compiler Test ===\n");
  console.log(`Using GROQ Model: ${promptCompilerService.textProvider.model}\n`);

  const registries = loadRegistries();

  const ctx = {
    runId: "live-char-test-01",
    nodeId: "build_prompt",
    userId: "test-user",
    traceId: "live-char-trace-01",
    registries,
    deps: { promptCompilerService }
  };

  console.log("Compiling Character Sheet for: \"A young man with curly dark hair, brown shirt, white pants\" matching @image1...");

  try {
    const result = await executePromptBuilder(
      {
        prompt: "A young man with curly dark hair, open brown shirt, white pants, matching @image1",
        references: [
          { id: "ref-1", type: "character", label: "Marcus", url: "https://example.com/face.jpg" }
        ],
        profile: "character-sheet",
        model: "gpt-image-2"
      },
      ctx
    );

    console.log("\n✅ Character Sheet Compiled Successfully!");
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
