import "dotenv/config";
import { executeLLM } from "../src/v2/nodes/llmNode.js";
import { registerAllManifests } from "../src/v2/nodes/manifests/registerManifests.js";
import { getManifest } from "../src/v2/nodes/manifests/nodeManifestRegistry.js";

async function runLiveTests() {
  console.log("\n=======================================================");
  console.log("🚀 STARTING LIVE TEST SUITE FOR V2 LLM NODE");
  console.log("=======================================================\n");

  // 1. Registry Test
  console.log("--- 1. Testing Manifest Registry ---");
  registerAllManifests();
  const manifest = getManifest("llm");
  console.log("✅ Manifest loaded:");
  console.log(`   - Type: ${manifest.type}`);
  console.log(`   - Billing: ${manifest.billing.type}`);
  console.log(`   - Category: ${manifest.category}`);

  const ctx = {
    runId: `run-test-${Date.now()}`,
    nodeId: "test_llm_node",
    traceId: `trace-${Date.now()}`,
  };

  // 2. Character Generation Test (Arabic Input -> English JSON)
  console.log("\n--- 2. Testing Character Description (Arabic Input -> JSON) ---");
  console.log("Input Prompt: 'محارب روبوتي قديم بأسلحة ملونة'");
  
  const charOutput = await executeLLM(
    {
      skills: ["llm/translation", "llm/character-description", "llm/json-output"],
      userPrompt: "محارب روبوتي قديم بأسلحة ملونة",
      temperature: 0.7,
      jsonMode: true,
      parameters: { style: "cinematic" },
    },
    ctx
  );

  console.log("\n✅ Result received:");
  console.log(`   - Model Used: ${charOutput.model}`);
  console.log(`   - Provider:   ${charOutput.provider}`);
  console.log(`   - Skills:     [${charOutput.skillsUsed.join(", ")}]`);
  console.log("\nGenerated JSON Output:");
  console.log(JSON.stringify(charOutput.json, null, 2));

  // 3. Vision Analysis Test
  console.log("\n--- 3. Testing Multimodal Vision Analysis (Image URL -> Traits) ---");
  const imageUrl = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/1200px-Cat03.jpg";
  console.log(`Image URL: ${imageUrl}`);

  const visionOutput = await executeLLM(
    {
      skills: ["llm/image-analyzer", "llm/json-output"],
      userPrompt: "Analyze this image and describe the subject, colors, and mood.",
      images: [imageUrl],
      jsonMode: true,
    },
    ctx
  );

  console.log("\n✅ Vision Analysis Result:");
  console.log(`   - Model Used: ${visionOutput.model}`);
  console.log(`   - Provider:   ${visionOutput.provider}`);
  console.log("\nExtracted Visual Data:");
  console.log(JSON.stringify(visionOutput.json, null, 2));

  // 4. Metadata Extractor Test
  console.log("\n--- 4. Testing Metadata Extractor ---");
  const metaOutput = await executeLLM(
    {
      skills: ["llm/metadata-extractor", "llm/json-output"],
      userPrompt: "Ancient robot warrior with colorful weapons in a neon rain city.",
      jsonMode: true,
    },
    ctx
  );

  console.log("\n✅ Metadata Extractor Result:");
  console.log(JSON.stringify(metaOutput.json, null, 2));

  console.log("\n=======================================================");
  console.log("🎉 ALL LLM NODE LIVE TESTS COMPLETED SUCCESSFULLY!");
  console.log("=======================================================\n");
}

runLiveTests().catch((err) => {
  console.error("\n❌ TEST SUITE FAILED:", err);
  process.exit(1);
});
