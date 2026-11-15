import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { V3Dispatcher } from "../../src/systems/generation/internal/v3/core/V3Dispatcher.js";
import { NodeRegistry } from "../../src/systems/generation/internal/v3/core/NodeRegistry.js";

function createDispatcherTestSetup({ shouldQueueFail = false, shouldNodeFail = false } = {}) {
  const events = [];
  const registry = new NodeRegistry();

  registry.register({
    type: "base.image_generate",
    OUTPUT_NODE: false,
    INPUT_TYPES: {
      required: {
        model: { type: "STRING" },
        prompt: { type: "STRING" },
      },
    },
    RETURN_TYPES: {
      image_url: "IMAGE_URL",
    },
    estimateCost: () => 25,
    async execute(inputs) {
      events.push(`execute:image_generate:${inputs.model}`);
      if (shouldNodeFail) {
        const err = new Error("Upstream GPU out of memory");
        err.code = "PROVIDER_CRASH";
        throw err;
      }
      return { image_url: "https://cdn.example.com/generated-v3.png" };
    },
  });

  registry.register({
    type: "base.save_media",
    OUTPUT_NODE: true,
    INPUT_TYPES: {
      required: {
        media_id: { type: "STRING" },
        asset_url: { type: "STRING" },
      },
    },
    RETURN_TYPES: {
      saved_media: "JSON",
    },
    estimateCost: () => 0,
    async execute(inputs) {
      events.push(`execute:save_media:${inputs.media_id}`);
      return {
        saved_media: {
          mediaId: inputs.media_id,
          url: inputs.asset_url,
          status: "completed",
        },
      };
    },
  });

  const workflow = {
    id: "test-image-v3",
    nodes: [
      {
        id: "gen",
        type: "base.image_generate",
        inputs: {
          model: { fromInput: "model" },
          prompt: { fromInput: "prompt" },
        },
      },
      {
        id: "save",
        type: "base.save_media",
        inputs: {
          media_id: { fromInput: "media_id" },
          asset_url: { fromNode: "gen", output: "image_url" },
        },
      },
    ],
  };

  const dispatcher = new V3Dispatcher({
    registry,
    identityTools: {
      assertOwns: async (type, id, uid) => {
        events.push(`assertOwns:${type}:${id}:${uid}`);
      },
      assertOwnsAny: async (types, id, uid) => {
        events.push(`assertOwnsAny:${id}:${uid}`);
      },
    },
    billingTools: {
      reserveHold: async ({ userId, amount, referenceId }) => {
        events.push(`reserveHold:${userId}:${amount}:${referenceId}`);
        return { referenceId, status: "held", amount };
      },
      settleHold: async ({ referenceId }) => {
        events.push(`settleHold:${referenceId}`);
        return { referenceId, status: "settled" };
      },
      releaseHold: async ({ referenceId }) => {
        events.push(`releaseHold:${referenceId}`);
        return { referenceId, status: "released" };
      },
      extendHold: async (referenceId, seconds) => {
        events.push(`extendHold:${referenceId}:${seconds}`);
      },
    },
    mediaTools: {
      createPendingMedia: async ({ userId, stepId }) => {
        events.push(`createPendingMedia:${userId}:${stepId}`);
        return { mediaId: "media-pending-1", status: "processing" };
      },
      markMediaFailed: async ({ mediaId, errorCode }) => {
        events.push(`markMediaFailed:${mediaId}:${errorCode}`);
        return { mediaId, status: "failed" };
      },
    },
    jobQueueService: {
      addUseCaseJob: async (payload) => {
        if (shouldQueueFail) {
          events.push("queueDispatch:failed");
          throw new Error("Redis connection refused");
        }
        events.push(`queueDispatch:ok:${payload.executionId}`);
        return { id: `job-${payload.executionId}`, data: payload };
      },
    },
  });

  return { dispatcher, workflow, events };
}

describe("V3Dispatcher — 5-Step Pre-Queue Launch & 3-Step Worker Settlement", () => {
  it("executes full happy path: Ownership -> Cost -> Hold -> Placeholder -> Queue -> Execute -> Settle", async () => {
    const { dispatcher, workflow, events } = createDispatcherTestSetup();

    const launchRes = await dispatcher.prepareAndEnqueue({
      workflow,
      input: {
        prompt: "A futuristic palace",
        model: "flux-pro",
        characters: ["char-001"],
      },
      userId: "user-42",
      executionId: "run-happy-1",
    });

    assert.equal(launchRes.status, "queued");
    assert.equal(launchRes.totalEstimatedCredits, 25);
    assert.equal(launchRes.mediaId, "media-pending-1");
    assert.equal(launchRes.billingHoldId, "v3:test-image-v3:user-42:run-happy-1");

    const workerRes = await dispatcher.executeQueuedV3Run({
      workflow,
      input: {
        prompt: "A futuristic palace",
        model: "flux-pro",
        media_id: launchRes.mediaId,
      },
      userId: "user-42",
      billingHoldId: launchRes.billingHoldId,
      runId: launchRes.runId,
    });

    assert.equal(workerRes.status, "completed");
    assert.equal(workerRes.billingStatus, "settled");
    assert.deepEqual(events, [
      "assertOwns:character:char-001:user-42",
      "reserveHold:user-42:25:v3:test-image-v3:user-42:run-happy-1",
      "createPendingMedia:user-42:test-image-v3",
      "queueDispatch:ok:run-happy-1",
      "execute:image_generate:flux-pro",
      "execute:save_media:media-pending-1",
      "settleHold:v3:test-image-v3:user-42:run-happy-1",
    ]);
  });

  it("rolls back credit hold and marks placeholder media as failed when queue dispatch fails", async () => {
    const { dispatcher, workflow, events } = createDispatcherTestSetup({
      shouldQueueFail: true,
    });

    await assert.rejects(
      () =>
        dispatcher.prepareAndEnqueue({
          workflow,
          input: {
            prompt: "A futuristic palace",
            model: "flux-pro",
          },
          userId: "user-42",
          executionId: "run-qfail-1",
        }),
      /Failed to enqueue V3 workflow/
    );

    assert.deepEqual(events, [
      "reserveHold:user-42:25:v3:test-image-v3:user-42:run-qfail-1",
      "createPendingMedia:user-42:test-image-v3",
      "queueDispatch:failed",
      "releaseHold:v3:test-image-v3:user-42:run-qfail-1",
      "markMediaFailed:media-pending-1:QUEUE_DISPATCH_FAILED",
    ]);
  });

  it("releases credit hold and marks media failed when worker execution fails", async () => {
    const { dispatcher, workflow, events } = createDispatcherTestSetup({
      shouldNodeFail: true,
    });

    const launchRes = await dispatcher.prepareAndEnqueue({
      workflow,
      input: {
        prompt: "A futuristic palace",
        model: "flux-pro",
      },
      userId: "user-42",
      executionId: "run-wfail-1",
    });

    await assert.rejects(
      () =>
        dispatcher.executeQueuedV3Run({
          workflow,
          input: {
            prompt: "A futuristic palace",
            model: "flux-pro",
            media_id: launchRes.mediaId,
          },
          userId: "user-42",
          billingHoldId: launchRes.billingHoldId,
          runId: launchRes.runId,
        }),
      /Upstream GPU out of memory/
    );

    assert.ok(events.includes("releaseHold:v3:test-image-v3:user-42:run-wfail-1"));
    assert.ok(events.includes("markMediaFailed:media-pending-1:PROVIDER_CRASH"));
    assert.ok(!events.some((e) => e.startsWith("settleHold")));
  });

  it("wires default jobQueueService and extendHold from #billing/tools and resolves V1 UseCase aliases", () => {
    const defaultDispatcher = new V3Dispatcher();
    assert.ok(defaultDispatcher.jobQueueService, "default jobQueueService should be wired");
    assert.equal(typeof defaultDispatcher.jobQueueService.addUseCaseJob, "function");
    assert.equal(typeof defaultDispatcher.billingTools.extendHold, "function");

    const resolvedImg = defaultDispatcher.resolveWorkflow("image-generation-v1");
    assert.equal(resolvedImg.id, "image-generation-v3");

    const resolvedVid = defaultDispatcher.resolveWorkflow("video-generation-v1");
    assert.equal(resolvedVid.id, "video-generation-v3");

    const resolvedChar = defaultDispatcher.resolveWorkflow("character-sheet-v1");
    assert.equal(resolvedChar.id, "character-sheet-v3");
  });
});

