import { run as runUseCase } from "./src/use-cases/useCaseRunner.js";
import { registerAllUseCases } from "./src/use-cases/registerUseCases.js";
import { loadRegistries } from "./src/v2/registry/registryLoader.js";

async function testUseCaseLogging() {
  console.log("--- Testing Clean Stage Logging for Use Cases ---\n");

  // Bootstrap registries
  registerAllUseCases();
  const registries = await loadRegistries();

  const mockWorkflowRunner = {
    startWorkflowRun: async (plan, runtimeInput) => {
      return { run_id: "run-e2e-12345", status: "completed" };
    }
  };

  const mockWallet = { getBalance: async () => 100 };
  const mockPricing = { getPrice: async () => 1 };

  await runUseCase({
    useCaseId: "simple-image-generation",
    input: { prompt: "A cinematic dragon flying over snow mountains", count: 1 },
    userId: "usr-demo",
    walletService: mockWallet,
    pricingService: mockPricing,
    workflowRunner: mockWorkflowRunner,
    registries
  });
}

testUseCaseLogging().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
