import "dotenv/config";
import { executeLLM } from "../src/v2/nodes/llmNode.js";
import { registerAllManifests } from "../src/v2/nodes/manifests/registerManifests.js";
import { getManifest } from "../src/v2/nodes/manifests/nodeManifestRegistry.js";

async function main() {
  console.log("[Test US1] Registering manifests...");
  registerAllManifests();

  const manifest = getManifest("llm");
  console.log("✅ Registered Manifest type:", manifest.type, "| billing:", manifest.billing.type);

  console.log("[Test US1] Executing LLM Node with Arabic concept prompt...");
  const output = await executeLLM(
    {
      skills: ["llm/translation", "llm/character-description", "llm/json-output"],
      userPrompt: "امرأة محاربة مستقبلية بشعر أبيض",
      temperature: 0.8,
      jsonMode: true,
      parameters: { style: "cinematic" },
    },
    {
      runId: "run-us1-test",
      nodeId: "llm_describe",
      userId: "user-test",
      traceId: "run-us1-test",
    }
  );

  console.log("\n=== LLM Node Output ===");
  console.log("Model Used:", output.model);
  console.log("Provider:", output.provider);
  console.log("Skills Used:", output.skillsUsed);
  console.log("Parsed JSON:\n", JSON.stringify(output.json, null, 2));

  if (!output.json || typeof output.json !== "object") {
    throw new Error("US1 Validation Failed: Output json is missing or not an object.");
  }

  console.log("\n✅ User Story 1 (MVP) validation PASSED.");
}

main().catch(err => {
  console.error("❌ US1 Validation Failed:", err);
  process.exit(1);
});
