import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistries } from "../../src/v2/registry/registryLoader.js";
import { compileWorkflowById } from "../../src/v2/compiler/compileWorkflow.js";
import { startWorkflowRun, initializeGateways } from "../../src/v2/runner/workflowRunner.js";
import { RunRepository } from "../../src/v2/runner/runRepository.js";
import { clearProviderRegistry, registerProviders } from "../../src/providers/providerRegistry.js";
import { createV2VideoAdapter } from "../../src/v2/providers/adapters/videoAdapter.js";
import { createV2UpscaleAdapter } from "../../src/v2/providers/adapters/upscaleAdapter.js";
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

async function waitForRunCompletion(runId) {
  let attempts = 40;

  while (attempts > 0) {
    const run = await runRepo.getRun(runId);
    if (run?.status === "completed" || run?.status === "failed") {
      return run;
    }
    await sleep(500);
    attempts -= 1;
  }

  throw new Error(`Timed out while waiting for cinematic-video-v1 (${runId}) to finish.`);
}

function createVideoRunner(providerId) {
  return {
    async execute(request) {
      return {
        outputs: [{
          id: `${providerId}-video-1`,
          type: "video",
          url: `https://example.test/${providerId}/clip.mp4`,
          duration: request.duration ?? 5,
          metadata: {
            prompt: request.prompt,
            provider: providerId,
            fps: request.fps ?? 24,
          },
        }],
      };
    },
  };
}

function createUpscaleRunner(providerId) {
  return {
    async execute(request) {
      const asset = request.asset ?? {};
      const factor = Number(request.factor ?? 2) || 2;
      return {
        outputs: [{
          id: `${providerId}-upscale-1`,
          type: asset.type ?? "video",
          url: `https://example.test/${providerId}/upscaled.mp4`,
          width: (asset.width ?? 1920) * factor,
          height: (asset.height ?? 1080) * factor,
          duration: asset.duration ?? 5,
          metadata: {
            ...(asset.metadata || {}),
            provider: providerId,
            factor,
          },
        }],
      };
    },
  };
}

export async function runVideoWorkflowCheck() {
  console.log("=== Running V2 Video Workflow E2E Check ===");

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
    createV2VideoAdapter({
      providerId: "video-runners",
      runner: createVideoRunner("video-runners"),
      cost: 20,
      latencyMs: 200,
      qualityTier: "standard",
    }),
    createV2VideoAdapter({
      providerId: "runway",
      runner: createVideoRunner("runway"),
      cost: 30,
      latencyMs: 400,
      qualityTier: "standard",
    }),
    createV2UpscaleAdapter({
      providerId: "topaz",
      runner: createUpscaleRunner("topaz"),
      cost: 5,
      latencyMs: 150,
      qualityTier: "standard",
    }),
  ], { replace: true });

  const registries = loadRegistries();
  const plan = compileWorkflowById("cinematic-video-v1", registries);

  const submitResult = await startWorkflowRun(plan, {
    prompt: "A cinematic drone reveal over a floating city",
    characters: [{ id: "char-1", name: "Kael", description: "pilot" }],
    references: [],
    style: "epic",
  });

  const runState = await waitForRunCompletion(submitResult.run_id);

  assert(runState.status === "completed", "cinematic-video-v1 should complete successfully.");
  assert(runState.outputs?.main_asset, "cinematic-video-v1 should expose main_asset.");
  assert(runState.outputs.main_asset.type === "video", "Final output should remain a video asset.");
  assert(runState.outputs.main_asset.url === "https://example.test/topaz/upscaled.mp4", "Final output should come from the upscale node.");
  assert(runState.outputs.main_asset.metadata?.upscaled === true, "Final output should be marked as upscaled.");
  assert(runState.outputs.main_asset.metadata?.factor === 2, "Final output should record the upscale factor.");

  const nodeRuns = await runRepo.listNodeRuns(submitResult.run_id);
  assert(nodeRuns.length === 3, "cinematic-video-v1 should have 3 node runs.");
  assert(nodeRuns.every((nodeRun) => nodeRun.status === "completed"), "All cinematic-video-v1 node runs should complete.");

  const reserveEvents = billingEvents.filter((event) => event.type === "reserve");
  const settleEvents = billingEvents.filter((event) => event.type === "settle");
  const rollbackEvents = billingEvents.filter((event) => event.type === "rollback");

  assert(reserveEvents.length === 2, "Billing reserve should be called for video and upscale nodes.");
  assert(settleEvents.length === 2, "Billing settle should be called for video and upscale nodes.");
  assert(rollbackEvents.length === 0, "Billing rollback should not be called for a successful video workflow.");
  assert(storageEvents.length === 2, "Storage should persist one video asset and one enhanced asset.");

  console.log("✓ Cinematic video workflow completed with prompt-builder -> video-generation -> upscale");
  console.log("✓ Billing and storage gateway behavior verified for video workflow");

  await v2WorkflowWorker.close();
  await redisConnection.quit();
  await workerRedisConnection.quit();

  console.log("=== V2 Video Workflow E2E Check PASSED ===");
}

if (isMainModule()) {
  runVideoWorkflowCheck()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Check failed:", error);
      process.exit(1);
    });
}
