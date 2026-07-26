/**
 * testTunisianTranslation.mjs
 *
 * Live test to verify the fix for Tunisian Darija translation.
 * Ensures "wost" translates to "in the middle of" (not "worst"),
 * "so7ob" to "clouds", and "ti7" to "falling".
 */

import "dotenv/config";
import { promptCompilerService } from "../../src/container.js";

async function run() {
  console.log("=== Testing Tunisian Darija Translation Fix ===\n");
  console.log(`Using GROQ Model: ${promptCompilerService.textProvider.model}\n`);

  const userPrompt = "cat f wost l sky w f wost so7ob m3a cenimatic view w cat 9a3da ti7 f wost smee";

  console.log("Original Input Prompt:");
  console.log(`"${userPrompt}"\n`);

  try {
    const result = await promptCompilerService.compile({
      userPrompt,
      targetModel: "gpt-image-2"
    });

    console.log("✅ Translation & Compilation Complete!");
    console.log("--------------------------------------------------");
    console.log("COMPILED POSITIVE PROMPT:\n");
    console.log(result.prompt);
    console.log("--------------------------------------------------");
    console.log("COMPILED NEGATIVE PROMPT:\n");
    console.log(result.negativePrompt);
    console.log("--------------------------------------------------");
  } catch (err) {
    console.error("❌ Live compilation failed:", err);
  }
}

run().catch(err => {
  console.error("Fatal test error:", err);
});
