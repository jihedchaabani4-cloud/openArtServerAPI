import "dotenv/config";
import { executeLLM } from "../src/v2/nodes/llmNode.js";

async function main() {
  console.log("[Test US2] Executing LLM Node with Vision input (image URL)...");
  const output = await executeLLM(
    {
      skills: ["llm/image-analyzer", "llm/json-output"],
      userPrompt: "Analyze this image and extract subject, visual traits, and style into JSON.",
      images: ["https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/1200px-Cat03.jpg"],
      jsonMode: true,
    },
    {
      runId: "run-us2-test",
      nodeId: "llm_vision",
      userId: "user-test",
      traceId: "run-us2-test",
    }
  );

  console.log("\n=== LLM Vision Output ===");
  console.log("Model Used:", output.model);
  console.log("Provider:", output.provider);
  console.log("Skills Used:", output.skillsUsed);
  console.log("Parsed JSON:\n", JSON.stringify(output.json, null, 2));

  if (!output.json || typeof output.json !== "object") {
    throw new Error("US2 Validation Failed: Vision output json is missing or not an object.");
  }

  console.log("\n✅ User Story 2 (Vision) validation PASSED.");
}

main().catch(err => {
  console.error("❌ US2 Validation Failed:", err);
  process.exit(1);
});
