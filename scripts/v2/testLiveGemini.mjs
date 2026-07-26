/**
 * testLiveGemini.mjs
 *
 * Performs a live test of Google Gemini 1.5 Pro compiler integration
 * using the configured GEMINI_API_KEY in the `.env` file.
 */

import "dotenv/config";
import { promptCompilerService } from "../../src/container.js";

async function run() {
  console.log("=== V2 Live Gemini Compiler Test ===\n");
  console.log(`Using Compiler Provider: ${process.env.COMPILER_PROVIDER}`);
  console.log(`Using Compiler Model: ${promptCompilerService.textProvider.model}\n`);

  const userPrompt = "cat f wost l sky w f wost so7ob m3a cenimatic view w cat 9a3da ti7 f wost smee";

  console.log("Original Input Prompt:");
  console.log(`"${userPrompt}"\n`);

  try {
    const result = await promptCompilerService.compile({
      userPrompt,
      targetModel: "gpt-image-2"
    });

    console.log("✅ Gemini compilation successful!");
    console.log("--------------------------------------------------");
    console.log("COMPILED POSITIVE PROMPT:\n");
    console.log(result.prompt);
    console.log("--------------------------------------------------");
    console.log("COMPILED NEGATIVE PROMPT:\n");
    console.log(result.negativePrompt);
    console.log("--------------------------------------------------");
  } catch (err) {
    console.error("❌ Live Gemini compilation failed:", err);
  }
}

run().catch(err => {
  console.error("Fatal test error:", err);
});
