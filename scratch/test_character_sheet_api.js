import "dotenv/config";

const API_BASE = "http://localhost:5000/api";
const PROJECT_ID = "be13135e-cd0e-48b6-90d1-143a5a9f02d8";

async function testCharacterSheetPipeline() {
  console.log("==================================================");
  console.log("🧪 TESTING CHARACTER SHEET PIPELINE (E2E API)");
  console.log("==================================================\n");

  // Step 1: Test AI Description Generation
  console.log("Step 1: Generating Haute-Couture Description...");
  const descRes = await fetch(`${API_BASE}/character-sheet/generate-description`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      concept: "The Eccentric",
      archetype: "eccentric",
    }),
  });

  const descData = await descRes.json();
  console.log("Status:", descRes.status);
  console.log("Generated Title:", descData.title);
  console.log("Generated Description:\n", descData.description);
  console.log("Keywords:", descData.keywords);

  if (!descData.description) {
    throw new Error("Failed to generate character description!");
  }

  // Step 2: Test Character Sheet Workflow Creation
  console.log("\nStep 2: Creating Character Sheet Workflow...");
  const sheetRes = await fetch(`${API_BASE}/element-sheet/character`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: PROJECT_ID,
      prompt: descData.description,
      type: "character",
      features: {
        identity: { archetype: descData.title },
      },
    }),
  });

  const sheetData = await sheetRes.json();
  console.log("Status:", sheetRes.status);
  console.log("Response Body:\n", JSON.stringify(sheetData, null, 2));

  const createdWorkflowId = sheetData?.workflow?.id || sheetData?.workflows?.[0]?.id || sheetData?.v1WorkflowId;
  console.log("\n✅ SUCCESS: Created Character Sheet Workflow ID:", createdWorkflowId);
  console.log("==================================================");
}

testCharacterSheetPipeline().catch((err) => {
  console.error("❌ Test Failed:", err);
  process.exit(1);
});
