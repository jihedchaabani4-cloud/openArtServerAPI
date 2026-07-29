import "dotenv/config";
import { executeLLM } from "../src/v2/nodes/llmNode.js";

async function main() {
  console.log("[Test US3] Executing LLM Node with metadata-extractor skill...");
  const output = await executeLLM(
    {
      skills: ["llm/metadata-extractor", "llm/json-output"],
      userPrompt: "Generate metadata for a futuristic cyberpunk warrior character concept art image.",
      jsonMode: true,
    },
    {
      runId: "run-us3-test",
      nodeId: "llm_metadata",
      userId: "user-test",
      traceId: "run-us3-test",
    }
  );

  console.log("\n=== LLM Metadata Output ===");
  console.log("Model Used:", output.model);
  console.log("Provider:", output.provider);
  console.log("Skills Used:", output.skillsUsed);
  console.log("Parsed JSON:\n", JSON.stringify(output.json, null, 2));

  if (!output.json || typeof output.json !== "object") {
    throw new Error("US3 Validation Failed: Metadata output json is missing or not an object.");
  }

  console.log("\n✅ User Story 3 (Metadata Extraction) validation PASSED.");
}

main().catch(err => {
  console.error("❌ US3 Validation Failed:", err);
  process.exit(1);
});
