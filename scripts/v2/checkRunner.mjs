import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadRegistries } from "../../src/v2/registry/registryLoader.js";
import { compileWorkflowById } from "../../src/v2/compiler/compileWorkflow.js";
import { startWorkflowRun } from "../../src/v2/runner/workflowRunner.js";
import { RunRepository } from "../../src/v2/runner/runRepository.js";
import { initializeGateways } from "../../src/v2/runner/workflowRunner.js";
import { clearProviderRegistry, registerProviders } from "../../src/providers/providerRegistry.js";
import { createV2ImageAdapter } from "../../src/v2/providers/adapters/imageAdapter.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { v2WorkflowWorker } from "../../src/v2/queue/v2WorkflowWorker.js";

const runRepo = new RunRepository();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createImageRunner(providerId) {
  return {
    async execute(request) {
      const width = request.width ?? 1024;
      const height = request.height ?? 1024;
      const count = request.count ?? 1;
      return {
        outputs: Array.from({ length: count }, (_, index) => ({
          id: `${providerId}-img-${index + 1}`,
          type: "image",
          url: `https://example.test/${providerId}/${width}x${height}/${index + 1}.png`,
          width,
          height,
          metadata: {
            prompt: request.prompt,
            provider: providerId,
            ordinal: index + 1,
          },
        })),
      };
    },
  };
}

export async function runRunnerCheck() {
  console.log("=== Running V2 Runner E2E Check ===");

  // Initialize gateways with console mock for event recorder
  initializeGateways({
    billing: {
      reserve: async () => ({ status: "success", amount: 0 }),
      settle: async () => ({ status: "success" }),
      rollback: async () => ({ status: "success" })
    },
    storage: {
      createMediaPlaceholder: async () => null,
      finalizeMediaResult: async () => {},
      persistMediaResult: async (res) => ({ ...res, status: "stored" })
    },
    events: {
      record: (e) => console.log(`[Event Recorded] ${e.operation}: ${e.status}`)
    }
  });

  clearProviderRegistry();
  registerProviders([
    createV2ImageAdapter({
      providerId: "image-runners",
      runner: createImageRunner("image-runners"),
      cost: 10,
      latencyMs: 100,
      qualityTier: "standard",
    }),
    createV2ImageAdapter({
      providerId: "fal",
      runner: createImageRunner("fal"),
      cost: 15,
      latencyMs: 200,
      qualityTier: "standard",
    }),
  ], { replace: true });

  const registries = loadRegistries();
  const plan = compileWorkflowById("character-sheet-v1", registries);

  const runtimeInput = {
    prompt: "A beautiful sci-fi city landscape",
    characters: [
      { id: "char-1", name: "Neo", traits: { hair: "black" } }
    ],
    references: [],
    style: "cyberpunk"
  };

  // Submit the run
  console.log("Submitting workflow run...");
  const submitResult = await startWorkflowRun(plan, runtimeInput);
  const runId = submitResult.run_id;
  assert(runId, "Should return a valid run_id");
  assert(submitResult.status === "pending", "Initial status should be pending");

  // Poll database until workflow is completed
  console.log(`Polling status for run ${runId}...`);
  let maxAttempts = 30;
  let runState = null;
  
  while (maxAttempts > 0) {
    runState = await runRepo.getRun(runId);
    console.log(`Run status: ${runState.status}`);
    if (runState.status === "completed" || runState.status === "failed") {
      break;
    }
    await sleep(500);
    maxAttempts--;
  }

  assert(runState.status === "completed", `Workflow run should complete successfully. Got: ${runState.status}. Error: ${JSON.stringify(runState.error)}`);
  assert(runState.outputs && runState.outputs.main_asset, "Workflow outputs should contain main_asset");
  assert(runState.outputs.main_asset.length > 0, "main_asset array should not be empty");
  
  const mainAsset = runState.outputs.main_asset[0];
  assert(mainAsset.url === "https://example.test/image-runners/1024x1024/1.png", "Output asset url should match mock output");
  console.log("✓ Workflow run completed successfully with mock output!");

  // Verify node runs are created and completed
  const nodeRuns = await runRepo.listNodeRuns(runId);
  assert(nodeRuns.length === 2, "Should have 2 node runs (build_prompt and generate)");
  for (const nodeRun of nodeRuns) {
    assert(nodeRun.status === "completed", `Node ${nodeRun.node_id} status should be completed`);
    assert(nodeRun.attempt === 1, `Node ${nodeRun.node_id} should succeed on first attempt`);
  }
  console.log("✓ All node run states verified in database!");

  // Scenario: Skill version freeze (SC-004)
  console.log("Running Skill version freeze check...");
  
  // Verify plan's resolved_skill_versions
  assert(
    plan.resolved_skill_versions["character-sheet"] === "1.0.0",
    "Skill version resolved in compile plan should be 1.0.0"
  );
  assert(
    runState.execution_plan.resolved_skill_versions["character-sheet"] === "1.0.0",
    "Skill version in run execution_plan should be 1.0.0"
  );
  
  console.log("✓ Skill version freeze verified!");

  // Clean up worker and redis connections
  await v2WorkflowWorker.close();
  await redisConnection.quit();
  await workerRedisConnection.quit();
  console.log("=== V2 Runner E2E Check PASSED ===");
}

// Allow running directly
const isMain = process.argv[1] && (
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
);

if (isMain) {
  runRunnerCheck()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Check failed:", err);
      process.exit(1);
    });
}
