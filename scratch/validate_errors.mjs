import "dotenv/config";
import { executeLLM } from "../src/v2/nodes/llmNode.js";

async function main() {
  console.log("[Test Errors] Running input validation error checks...");
  const ctx = { runId: "err-test", nodeId: "n1", traceId: "err-test" };

  let passed = 0;

  // Test 1: Empty skills
  try {
    await executeLLM({ skills: [], userPrompt: "hello" }, ctx);
  } catch (err) {
    if (err.message.includes("skills must be a non-empty array")) {
      console.log("✅ Test 1 Passed: Empty skills caught.");
      passed++;
    }
  }

  // Test 2: Empty userPrompt
  try {
    await executeLLM({ skills: ["llm/translation"], userPrompt: "   " }, ctx);
  } catch (err) {
    if (err.message.includes("userPrompt is required")) {
      console.log("✅ Test 2 Passed: Empty userPrompt caught.");
      passed++;
    }
  }

  // Test 3: Unknown skill ID
  try {
    await executeLLM({ skills: ["llm/nonexistent-skill"], userPrompt: "hello" }, ctx);
  } catch (err) {
    if (err.message.includes("Skill not found")) {
      console.log("✅ Test 3 Passed: Unknown skill ID caught:", err.message);
      passed++;
    }
  }

  if (passed === 3) {
    console.log("\n✅ All 3 Error Validation Tests PASSED.");
  } else {
    throw new Error(`Error validation incomplete: ${passed}/3 passed.`);
  }
}

main().catch(err => {
  console.error("❌ Error Validation Failed:", err);
  process.exit(1);
});
