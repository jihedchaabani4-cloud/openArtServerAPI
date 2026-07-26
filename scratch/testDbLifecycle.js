import "dotenv/config";
import { db, mediaWorkflowLifecycleService } from "../src/container.js";

async function runTest() {
  const userId = "7d40bff4-7cac-4f2d-8994-2642c90e40e4";
  console.log("=== Creating placeholder workflow + media ===");
  const placeholders = await mediaWorkflowLifecycleService.startPlaceholders({
    userId,
    nodeType: "image-generation",
    input: { prompt: "Test prompt" },
    count: 1,
    runId: "test-run-id-123",
    workflowId: "simple-image-v1"
  });

  console.log("Placeholders created:", placeholders);
  if (placeholders.length === 0) {
    console.error("❌ Placeholder creation failed!");
    return;
  }

  const placeholder = placeholders[0];
  console.log(`=== Finalizing media placeholder ${placeholder.mediaId} ===`);
  
  const asset = {
    url: "https://example.com/test-output-image.png",
    width: 512,
    height: 512
  };

  const ok = await mediaWorkflowLifecycleService.completePlaceholder(placeholder.mediaId, asset);
  console.log("Placeholder finalization result:", ok);

  if (!ok) {
    console.error("❌ Finalization failed!");
  } else {
    console.log("✓ Success!");
  }
}

runTest().then(() => process.exit(0)).catch(err => {
  console.error("Execution error:", err);
  process.exit(1);
});
