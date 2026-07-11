import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadRegistries } from "../../src/v2/registry/registryLoader.js";
import { compileWorkflow } from "../../src/v2/compiler/compileWorkflow.js";
import { startWorkflowRun, initializeGateways } from "../../src/v2/runner/workflowRunner.js";
import { RunRepository } from "../../src/v2/runner/runRepository.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { v2WorkflowWorker } from "../../src/v2/queue/v2WorkflowWorker.js";
import { executeNode } from "../../src/v2/nodes/index.js";

const runRepo = new RunRepository();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runRetryFallbackCheck() {
  console.log("=== Running V2 Retry & Fallback Check ===");

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

  const registries = loadRegistries();
  
  // Custom mock workflow to trigger retry & fallback
  const mockWorkflow = {
    id: "retry-fallback-test",
    name: "Retry Fallback Test",
    version: "1.0.0",
    description: "Workflow to test retries and fallback",
    metadata: { category: "test", tags: [], author: "system" },
    input_schema: {
      required: ["prompt"],
      properties: { prompt: { type: "string" } }
    },
    nodes: {
      retry_node: {
        type: "image-generation", // retry: max_attempts: 2, fallback_provider: fal
        user_inputs: { prompt: "${input.prompt}" },
        config: { width: 1024, height: 1024 }
      }
    },
    outputs: {
      result: "${retry_node.output.assets}"
    }
  };

  const plan = compileWorkflow(mockWorkflow, registries);
  
  // Override node executor to mock provider behavior across attempts
  const originalGenerateNode = registries.nodes["image-generation"];
  
  let attempt1ForcedProvider = null;
  let attempt2ForcedProvider = null;

  // Let's modify executeNode behavior for check script
  // We can write a custom image-generation mock inside nodes/imageGenerationNode.js or intercept it
  // Since we are running the worker in this process, we can hijack node execution by changing the stub!
  // In nodeExecutor.js, executeNode is imported. But since we mock it, we can write a test flag or hijack.
  // Wait, let's look at executeNode. We can inject a check or let it read a global test hook!
  globalThis.__RETRY_FALLBACK_TEST_HOOK__ = (inputs, ctx) => {
    if (ctx.attempt === 1) {
      console.log("[Test Hook] Attempt 1: Simulating provider failure.");
      throw new Error("Primary provider failed connection.");
    }
    if (ctx.attempt === 2) {
      console.log("[Test Hook] Attempt 2: Resolving fallback.");
      attempt2ForcedProvider = inputs.forceProvider;
      return {
        assets: [{ id: "fallback-asset", type: "image", url: "https://fallback.com/image.png" }]
      };
    }
  };

  console.log("Submitting test workflow run...");
  const submitResult = await startWorkflowRun(plan, { prompt: "test retry" });
  const runId = submitResult.run_id;

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

  assert(runState.status === "completed", "Workflow should complete successfully after fallback retry.");
  
  const nodeRuns = await runRepo.listNodeRuns(runId);
  const nodeRun = nodeRuns.find(n => n.node_id === "retry_node");
  
  assert(nodeRun.attempt === 2, "Node should have executed 2 attempts.");
  assert(attempt2ForcedProvider === "fal", "Second attempt should have forced the fallback provider 'fal'.");
  assert(runState.outputs.result[0].url === "https://fallback.com/image.png", "Result should match the fallback image asset.");

  console.log("✓ Fallback provider forced on final attempt successfully!");

  // Clean up global hook
  delete globalThis.__RETRY_FALLBACK_TEST_HOOK__;

  // Clean up worker and redis connections
  await v2WorkflowWorker.close();
  await redisConnection.quit();
  await workerRedisConnection.quit();
  
  console.log("=== V2 Retry & Fallback Check PASSED ===");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runRetryFallbackCheck()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Check failed:", err);
      process.exit(1);
    });
}
