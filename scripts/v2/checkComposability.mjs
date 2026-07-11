import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistries } from "../../src/v2/registry/registryLoader.js";
import { compileWorkflowById } from "../../src/v2/compiler/compileWorkflow.js";
import { startWorkflowRun, initializeGateways } from "../../src/v2/runner/workflowRunner.js";
import { RunRepository } from "../../src/v2/runner/runRepository.js";
import { clearProviderRegistry, registerProviders } from "../../src/providers/providerRegistry.js";
import { createV2ImageAdapter } from "../../src/v2/providers/adapters/imageAdapter.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { v2WorkflowWorker } from "../../src/v2/queue/v2WorkflowWorker.js";

const runRepo = new RunRepository();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunCompletion(runId, label) {
  let attempts = 40;

  while (attempts > 0) {
    const run = await runRepo.getRun(runId);
    if (run?.status === "completed" || run?.status === "failed") {
      return run;
    }
    await sleep(500);
    attempts -= 1;
  }

  throw new Error(`Timed out while waiting for ${label} (${runId}) to finish.`);
}

function createImageRunner(providerId) {
  return {
    async execute(request) {
      const width = request.width ?? 1024;
      const height = request.height ?? 1024;
      const count = request.count ?? 1;
      return {
        outputs: Array.from({ length: count }, (_, index) => ({
          id: `${providerId}-asset-${index + 1}`,
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

export async function runComposabilityCheck() {
  console.log("=== Running V2 Composability Check ===");

  const billingEvents = [];
  const storageEvents = [];

  initializeGateways({
    billing: {
      reserve: async (payload) => {
        billingEvents.push({ type: "reserve", ...payload });
        return { status: "success", referenceId: payload.referenceId };
      },
      settle: async (referenceId) => {
        billingEvents.push({ type: "settle", referenceId });
        return { status: "success", referenceId };
      },
      rollback: async (referenceId) => {
        billingEvents.push({ type: "rollback", referenceId });
        return { status: "success", referenceId };
      },
    },
    storage: {
      createMediaPlaceholder: async () => null,
      finalizeMediaResult: async () => {},
      persistMediaResult: async (result) => {
        storageEvents.push(result);
        return { ...result, status: "stored" };
      },
    },
    events: {
      record: (event) => console.log(`[Event Recorded] ${event.operation}: ${event.status ?? "success"}`),
    },
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
  const expectedNodeTypes = new Set(["prompt-builder", "image-generation", "video-generation", "upscale"]);
  const scenarios = [
    {
      workflowId: "character-sheet-v1",
      skillId: "character-sheet",
      expectedCount: 4,
      expectedSize: "1024x1024",
      input: {
        prompt: "A polished character sheet for a sci-fi ranger",
        characters: [{ id: "char-1", name: "Nova", description: "ranger" }],
        references: [],
        style: "cinematic",
      },
    },
    {
      workflowId: "storyboard-v1",
      skillId: "storyboard",
      expectedCount: 6,
      expectedSize: "1920x1080",
      input: {
        prompt: "A six-panel chase through a rainy neon market",
        characters: [{ id: "char-2", name: "Rin", description: "detective" }],
        references: [],
        style: "neo-noir",
      },
    },
    {
      workflowId: "movie-poster-v1",
      skillId: "movie-poster",
      expectedCount: 1,
      expectedSize: "1024x1536",
      input: {
        prompt: "A dramatic key art poster for a rebellion on Mars",
        characters: [{ id: "char-3", name: "Aya", description: "rebel leader" }],
        references: [],
        style: "epic",
      },
    },
  ];

  for (const scenario of scenarios) {
    const plan = compileWorkflowById(scenario.workflowId, registries);

    assert(
      plan.nodes.every((node) => expectedNodeTypes.has(node.type)),
      `${scenario.workflowId} should compile using existing node types only.`,
    );
    assert(
      plan.resolved_skill_versions[scenario.skillId] === "1.0.0",
      `${scenario.workflowId} should freeze ${scenario.skillId} at version 1.0.0.`,
    );

    const submitResult = await startWorkflowRun(plan, scenario.input);
    const runState = await waitForRunCompletion(submitResult.run_id, scenario.workflowId);

    assert(runState.status === "completed", `${scenario.workflowId} should complete successfully.`);
    assert(Array.isArray(runState.outputs.main_asset), `${scenario.workflowId} should expose an asset array.`);
    assert(
      runState.outputs.main_asset.length === scenario.expectedCount,
      `${scenario.workflowId} should output ${scenario.expectedCount} assets.`,
    );
    assert(
      runState.outputs.main_asset.every((asset) => asset.url.includes(scenario.expectedSize)),
      `${scenario.workflowId} should emit ${scenario.expectedSize} assets.`,
    );

    const nodeRuns = await runRepo.listNodeRuns(submitResult.run_id);
    assert(
      nodeRuns.every((nodeRun) => nodeRun.status === "completed"),
      `${scenario.workflowId} should complete all node runs.`,
    );

    console.log(`✓ ${scenario.workflowId} compiles and runs with existing engine primitives`);
  }

  const reserveEvents = billingEvents.filter((event) => event.type === "reserve");
  const settleEvents = billingEvents.filter((event) => event.type === "settle");
  const rollbackEvents = billingEvents.filter((event) => event.type === "rollback");

  assert(reserveEvents.length === 3, "Billing reserve should be called once per composability workflow.");
  assert(settleEvents.length === 3, "Billing settle should be called once per composability workflow.");
  assert(rollbackEvents.length === 0, "Billing rollback should not be called for successful composability workflows.");
  assert(storageEvents.length === 11, "Storage should persist all generated assets across the three workflows.");

  console.log("✓ SC-002 composability proof verified");
  console.log("✓ SC-006 three workflow use cases complete end-to-end");

  await v2WorkflowWorker.close();
  await redisConnection.quit();
  await workerRedisConnection.quit();

  console.log("=== V2 Composability Check PASSED ===");
}

if (isMainModule()) {
  runComposabilityCheck()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Check failed:", error);
      process.exit(1);
    });
}
