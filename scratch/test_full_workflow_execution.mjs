import { bootstrapV2 } from "../src/v2/bootstrap.js";
import { run as runUseCase } from "../src/use-cases/useCaseRunner.js";
import { walletService, pricingService } from "../src/container.js";

bootstrapV2();

async function testFullWorkflow() {
  console.log("🧪 Testing Full Workflow Execution with Node Job Worker Fix...");

  const runResult = await runUseCase({
    useCaseId: "character-sheet-v1",
    input: {
      prompt: "A futuristic cyberpunk warrior in neon rain city",
      model: "nanobana",
      characters: [{ name: "Cyberpunk Warrior", description: "Neon armor warrior" }],
    },
    userId: "0d5ade78-e895-4d84-8e29-88a63253c76d",
    walletService,
    pricingService,
  });

  console.log(`\n✅ UseCase Dispatched to Queue! Run ID: ${runResult.executionId}`);
  console.log("⏳ Waiting 10 seconds for Worker to execute nodes (LLM -> PromptBuilder -> ImageGen)...");

  await new Promise((resolve) => setTimeout(resolve, 10000));
  console.log("🎉 Test script completed!");
  process.exit(0);
}

testFullWorkflow().catch((err) => {
  console.error("💥 Full Workflow Test Error:", err);
  process.exit(1);
});
