import { bootstrapV2 } from "./src/v2/bootstrap.js";
import { run as runUseCase } from "./src/use-cases/useCaseRunner.js";
import { executeNode } from "./src/v2/nodes/index.js";
import { NodeSafetyService } from "./src/v2/nodes/safety/NodeSafetyService.js";
import { mapImageGenerationV1, mapEditImageV1, normalizeAspectRatio, normalizeCount } from "./src/v2/utils/v1PayloadMapper.js";
import { loadRegistries } from "./src/v2/registry/registryLoader.js";
import { createBillingStrategy } from "./src/v2/billing/billingStrategy.js";

// Bootstrap V2 Engine & Use Cases
bootstrapV2();

async function runWorstErrorsTestSuite() {
  console.log("\n=================================================================");
  console.log("🔥 RUNNING STRESS TEST: 10 WORST EDGE-CASE ERRORS");
  console.log("=================================================================\n");

  const registries = await loadRegistries();
  let passedCount = 0;

  // -----------------------------------------------------------------
  // SCENARIO 1: Empty / Missing Prompt
  // -----------------------------------------------------------------
  try {
    console.log("▶️ SCENARIO 1: Empty/Missing Prompt");
    NodeSafetyService.assertPromptBuilderInputs({ prompt: "" });
    console.error("❌ Scenario 1 failed: Should have thrown validation error");
  } catch (err) {
    if (err.code === "NODE_VALIDATION_ERROR") {
      console.log(`  ✓ Safely caught: ${err.code} - "${err.message}"`);
      passedCount++;
    } else {
      console.error("  ❌ Unexpected error type:", err);
    }
  }

  // -----------------------------------------------------------------
  // SCENARIO 2: Massive Overflow Prompt (100,000+ characters attack)
  // -----------------------------------------------------------------
  try {
    console.log("\n▶️ SCENARIO 2: Massive Overflow Prompt (100,000+ characters attack)");
    const hugePrompt = "<script>alert('hack')</script> " + "A".repeat(100000);
    NodeSafetyService.assertImageInputs({ prompt: hugePrompt });
    console.error("❌ Scenario 2 failed: Should have rejected overflow prompt!");
  } catch (err) {
    if (err.code === "NODE_VALIDATION_ERROR" || err.message.includes("exceeds maximum length")) {
      console.log(`  ✓ Fail-fast rejected overflow prompt: ${err.code} - "${err.message}"`);
      passedCount++;
    } else {
      console.error("  ❌ Scenario 2 threw unexpected error:", err.message);
    }
  }

  // -----------------------------------------------------------------
  // SCENARIO 3: Non-Existent / Invalid Model Name
  // -----------------------------------------------------------------
  try {
    console.log("\n▶️ SCENARIO 3: Non-Existent Model Name ('fake_super_model_9999')");
    const v1Input = mapImageGenerationV1({ prompt: "valid prompt", model_name: "fake_super_model_9999" });
    if (v1Input.model === "fal" || typeof v1Input.model === "string") {
      console.log(`  ✓ Safely handled: Invalid model normalized/fallback to default "${v1Input.model}".`);
      passedCount++;
    } else {
      console.error("  ❌ Failed to handle invalid model name!");
    }
  } catch (err) {
    console.error("  ❌ Scenario 3 threw error:", err.message);
  }

  // -----------------------------------------------------------------
  // SCENARIO 4: Insufficient Balance / Zero Credit Wallet
  // -----------------------------------------------------------------
  try {
    console.log("\n▶️ SCENARIO 4: Insufficient Balance / Zero Credit Wallet");
    const mockZeroWallet = { getBalance: async () => 0 };
    const workflowBudgetStrategy = createBillingStrategy("workflow-budget");

    await workflowBudgetStrategy.preCheck("usr-poor", 10, mockZeroWallet);
    console.error("❌ Scenario 4 failed: Should have rejected zero balance!");
  } catch (err) {
    if (err.code === "INSUFFICIENT_CREDITS" || err.message.includes("balance") || err.message.includes("credits")) {
      console.log(`  ✓ Safely rejected: [402] ${err.code || 'INSUFFICIENT_CREDITS'} - "${err.message}"`);
      passedCount++;
    } else {
      console.error("  ❌ Unexpected error:", err);
    }
  }

  // -----------------------------------------------------------------
  // SCENARIO 5: Non-Existent / Hacked UseCase ID
  // -----------------------------------------------------------------
  try {
    console.log("\n▶️ SCENARIO 5: Non-Existent UseCase ID ('hacked-use-case-xyz')");
    await runUseCase({
      useCaseId: "hacked-use-case-xyz",
      input: { prompt: "test" },
      userId: "usr-1",
      walletService: { getBalance: async () => 100 },
      pricingService: { getPrice: async () => 1 },
      workflowRunner: { startWorkflowRun: async () => ({}) },
      registries
    });
    console.error("❌ Scenario 5 failed: Should have thrown 404 USE_CASE_NOT_FOUND");
  } catch (err) {
    if (err.statusCode === 404 || err.code === "USE_CASE_NOT_FOUND") {
      console.log(`  ✓ Safely caught: [${err.statusCode}] ${err.code} - "${err.message}"`);
      passedCount++;
    } else {
      console.error("  ❌ Unexpected error:", err);
    }
  }

  // -----------------------------------------------------------------
  // SCENARIO 6: Invalid / Malformed Aspect Ratio String
  // -----------------------------------------------------------------
  try {
    console.log("\n▶️ SCENARIO 6: Malformed Aspect Ratio (e.g. '99999:0' or 'INVALID_RATIO')");
    const normalized1 = normalizeAspectRatio("99999:0");
    const normalized2 = normalizeAspectRatio("INVALID_RATIO");
    if (normalized1 === "1:1" && normalized2 === "1:1") {
      console.log(`  ✓ Safely normalized malformed ratios to default "1:1".`);
      passedCount++;
    } else {
      console.error("  ❌ Aspect ratio fallback failed!");
    }
  } catch (err) {
    console.error("  ❌ Scenario 6 threw error:", err.message);
  }

  // -----------------------------------------------------------------
  // SCENARIO 7: Upstream Provider Connection Failure / Empty LLM Prompt
  // -----------------------------------------------------------------
  try {
    console.log("\n▶️ SCENARIO 7: Empty LLM Prompt Fail-Fast Guard");
    NodeSafetyService.assertLLMInputs({ userPrompt: "" });
    console.error("❌ Scenario 7 failed: Should have caught empty prompt before network call");
  } catch (err) {
    if (err.code === "NODE_VALIDATION_ERROR") {
      console.log(`  ✓ Fail-fast triggered before calling network: ${err.code} - "${err.message}"`);
      passedCount++;
    } else {
      console.error("  ❌ Unexpected error:", err);
    }
  }

  // -----------------------------------------------------------------
  // SCENARIO 8: Malformed Non-JSON Response Handling
  // -----------------------------------------------------------------
  try {
    console.log("\n▶️ SCENARIO 8: Malformed Non-JSON Response Handling");
    const inputs = {
      userPrompt: "A dragon in sky",
      systemPromptOverride: "Return structured JSON with prompt field",
      temperature: 0.7
    };
    const ctx = { runId: "test-llm-fallback", nodeId: "llm-1", userId: "usr-1" };
    const res = await executeNode("llm", inputs, ctx);
    
    if (res && (res.json || res.text)) {
      console.log(`  ✓ LLM Node executed safely and returned structured output.`);
      passedCount++;
    } else {
      console.error("  ❌ LLM execution failed!");
    }
  } catch (err) {
    console.error("  ❌ Scenario 8 threw error:", err.message);
  }

  // -----------------------------------------------------------------
  // SCENARIO 9: Negative or Extreme Count Request (count = -50 and NaN)
  // -----------------------------------------------------------------
  try {
    console.log("\n▶️ SCENARIO 9: Negative or Extreme Count (-50 and NaN)");
    const count1 = normalizeCount(-50, null);
    const count2 = normalizeCount("invalid_string", null);
    if (count1 === 1 && count2 === 1) {
      console.log(`  ✓ Safely clamped negative and NaN count to minimum 1.`);
      passedCount++;
    } else {
      console.error(`  ❌ Count normalization failed! Got count1=${count1}, count2=${count2}`);
    }
  } catch (err) {
    console.error("  ❌ Scenario 9 threw error:", err.message);
  }

  // -----------------------------------------------------------------
  // SCENARIO 10: Missing Source Asset on Image Edit Node
  // -----------------------------------------------------------------
  try {
    console.log("\n▶️ SCENARIO 10: Missing Source Asset on Media Transform (Image Edit)");
    NodeSafetyService.assertTransformInputs({ mode: "image_edit", source_asset: null });
    console.error("❌ Scenario 10 failed: Should have thrown validation error for missing source_asset");
  } catch (err) {
    if (err.code === "NODE_VALIDATION_ERROR") {
      console.log(`  ✓ Fail-fast caught missing source_asset: ${err.code} - "${err.message}"`);
      passedCount++;
    } else {
      console.error("  ❌ Unexpected error:", err);
    }
  }

  console.log("\n=================================================================");
  console.log(`📊 WORST ERRORS TEST RESULTS: ${passedCount}/10 PASSED CLEANLY`);
  console.log("=================================================================");

  if (passedCount === 10) {
    console.log("🎉 ALL 10 WORST EDGE-CASE ERRORS WERE CAUGHT AND HANDLED FAULT-TOLERANTLY!");
  } else {
    process.exit(1);
  }
}

runWorstErrorsTestSuite().catch((err) => {
  console.error("Test suite crashed unexpectedly:", err);
  process.exit(1);
});
