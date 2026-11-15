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

  it("reuses caller-supplied media_id directly without calling createPendingMedia", async () => {
    const { dispatcher, workflow, events } = createDispatcherTestSetup();

    const launchRes = await dispatcher.prepareAndEnqueue({
      workflow,
      input: {
        prompt: "Character turnaround",
        model: "flux-pro",
        media_id: "prelinked-char-media-99",
      },
      userId: "user-42",
      executionId: "run-prelinked-1",
    });

    assert.equal(launchRes.status, "queued");
    assert.equal(launchRes.mediaId, "prelinked-char-media-99");
    assert.ok(
      !events.some((e) => e.startsWith("createPendingMedia")),
      "createPendingMedia must NOT be called when media_id is already provided"
    );
  });

  it("reads mediaType, mediaRole, saveType, and requiredInputs from the 3 workflow contracts when creating automatic pending media", async () => {
    const pendingMediaCalls = [];
    const dispatcher = new V3Dispatcher({
      identityTools: {
        assertOwns: async () => true,
        assertOwnsAny: async () => true,
      },
      billingTools: {
        reserveHold: async ({ referenceId, amount }) => ({ referenceId, amount, status: "held" }),
        settleHold: async ({ referenceId }) => ({ referenceId, status: "settled" }),
        releaseHold: async ({ referenceId }) => ({ referenceId, status: "released" }),
        extendHold: async () => {},
      },
      mediaTools: {
        createPendingMedia: async (args) => {
          pendingMediaCalls.push(args);
          return { mediaId: `pending-${args.stepId}`, status: "processing" };
        },
        markMediaFailed: async () => {},
      },
      jobQueueService: {
        addUseCaseJob: async (payload) => ({ id: `job-${payload.executionId}` }),
      },
    });

    // 1. Missing requiredInput ("prompt") throws GenerationValidationError (USER_FAULT, 400) before holding or queueing
    await assert.rejects(
      () =>
        dispatcher.prepareAndEnqueue({
          useCaseId: "image-generation-v3",
          input: { model: "nanobana_2" },
          userId: "user-contract-1",
        }),
      (err) => {
        assert.equal(err.code, "GENERATION_VALIDATION_ERROR");
        assert.equal(err.category, "USER_FAULT");
        assert.equal(err.statusCode, 400);
        assert.equal(err.retryable, false);
        assert.equal(err.field, "prompt");
        return true;
      }
    );
    assert.equal(pendingMediaCalls.length, 0);

    // 2. image-generation-v3 (or alias imageGeneration): mediaType="image", role="output", saveType="workflow_output"
    await dispatcher.prepareAndEnqueue({
      useCaseId: "imageGeneration",
      input: { prompt: "A serene lake" },
      userId: "user-contract-1",
      executionId: "run-img-contract",
    });

    // 3. video-generation-v3 (or alias videoGeneration): mediaType="video", role="output", saveType="video_output"
    await dispatcher.prepareAndEnqueue({
      useCaseId: "videoGeneration",
      input: { prompt: "Ocean waves crashing" },
      userId: "user-contract-1",
      executionId: "run-vid-contract",
    });

    // 4. character-sheet-v3 (or alias characterSheet): mediaType="image", role="sheet", saveType="character_sheet"
    await dispatcher.prepareAndEnqueue({
      useCaseId: "characterSheet",
      input: { prompt: "Elven archer" },
      userId: "user-contract-1",
      executionId: "run-char-contract",
    });

    assert.equal(pendingMediaCalls.length, 3);
    assert.deepEqual(
      pendingMediaCalls.map((c) => ({
        stepId: c.stepId,
        role: c.role,
        saveType: c.saveType,
        mediaType: c.mediaType,
        width: c.width,
        height: c.height,
      })),
      [
        {
          stepId: "image-generation-v3",
          role: "output",
          saveType: "workflow_output",
          mediaType: "image",
          width: 1024,
          height: 1024,
        },
        {
          stepId: "video-generation-v3",
          role: "output",
          saveType: "video_output",
          mediaType: "video",
          width: 1024,
          height: 1024,
        },
        {
          stepId: "character-sheet-v3",
          role: "sheet",
          saveType: "character_sheet",
          mediaType: "image",
          width: 1344,
          height: 768,
        },
      ]
    );
  });

  it("enforces the 4 error categories, retry rules, HOLD_EXPIRED guard, and sanitizeClientError on media.error_message", async () => {
    const {
      sanitizeClientError,
      GenerationSafetyError,
      GenerationHoldExpiredError,
      GenerationUpstreamError,
      GenerationValidationError,
    } = await import("../../src/systems/generation/internal/errors.js");
    const { WorkflowExecutor } = await import(
      "../../src/systems/generation/internal/v3/core/WorkflowExecutor.js"
    );

    // A) Verify sanitizeClientError strips internal provider names, URLs, stack traces, and SQL leaks across all 4 categories
    const safetySanitized = sanitizeClientError(
      new GenerationSafetyError("Rejected by gemini safety filter at https://internal.googleapis.com/v1/models")
    );
    assert.equal(safetySanitized.code, "CONTENT_SAFETY_VIOLATION");
    assert.equal(safetySanitized.category, "CONTENT_SAFETY_VIOLATION");
    assert.equal(safetySanitized.statusCode, 422);
    assert.equal(safetySanitized.retryable, false);
    assert.ok(!/gemini|googleapis|http/i.test(safetySanitized.userMessage));

    const upstreamSanitized = sanitizeClientError(
      new GenerationUpstreamError("wavespeed ltx 502 error from https://api.wavespeed.ai/v1/tasks\n    at execute (file.js:10:2)")
    );
    assert.equal(upstreamSanitized.category, "UPSTREAM_FAULT");
    assert.equal(upstreamSanitized.statusCode, 502);
    assert.equal(upstreamSanitized.retryable, true);
    assert.ok(!/wavespeed|ltx|https|file\.js/i.test(upstreamSanitized.userMessage));

    const holdSanitized = sanitizeClientError(new GenerationHoldExpiredError("Hold expired for media-1"));
    assert.equal(holdSanitized.code, "HOLD_EXPIRED");
    assert.equal(holdSanitized.category, "HOLD_EXPIRED");
    assert.equal(holdSanitized.statusCode, 409);
    assert.equal(holdSanitized.retryable, false);

    const sqlLeakSanitized = sanitizeClientError(
      new Error('SELECT * FROM media WHERE id = "123" relation "media" does not exist in supabase postgres')
    );
    assert.equal(sqlLeakSanitized.category, "SERVER_FAULT");
    assert.equal(sqlLeakSanitized.statusCode, 500);
    assert.equal(sqlLeakSanitized.retryable, false);
    assert.ok(!/SELECT|supabase|postgres|relation/i.test(sqlLeakSanitized.userMessage));

    // B) Verify WorkflowExecutor never retries CONTENT_SAFETY_VIOLATION, USER_FAULT, or HOLD_EXPIRED,
    //    and ONLY retries UPSTREAM_FAULT / RATE_LIMIT
    const retryRegistry = new NodeRegistry();
    let safetyAttempts = 0;
    let userFaultAttempts = 0;
    let upstreamAttempts = 0;

    retryRegistry.register({
      type: "base.llm",
      OUTPUT_NODE: true,
      INPUT_TYPES: { required: { prompt: { type: "STRING" } } },
      RETURN_TYPES: { final_prompt: "STRING" },
      retryPolicy: {
        maxAttempts: 3,
        backoffMs: 0,
        retryableCategories: ["UPSTREAM_FAULT", "RATE_LIMIT"],
      },
      estimateCost: () => 1,
      async execute(inputs) {
        if (inputs.prompt === "unsafe") {
          safetyAttempts++;
          throw new GenerationSafetyError("Unsafe prompt rejected");
        }
        if (inputs.prompt === "bad_input") {
          userFaultAttempts++;
          throw new GenerationValidationError("Invalid input format");
        }
        upstreamAttempts++;
        if (upstreamAttempts < 3) {
          throw new GenerationUpstreamError("Temporary 503 upstream glitch", {
            statusCode: 503,
            category: "UPSTREAM_FAULT",
            retryable: true,
          });
        }
        return { final_prompt: "Recovered on attempt 3" };
      },
    });

    const singleNodeWf = {
      id: "retry-test-wf",
      nodes: [
        {
          id: "llm",
          type: "base.llm",
          inputs: { prompt: { fromInput: "prompt" } },
        },
      ],
    };
    const executor = new WorkflowExecutor(retryRegistry, { sleepFn: async () => {} });

    await assert.rejects(
      () => executor.execute({ workflow: singleNodeWf, input: { prompt: "unsafe" } }),
      (err) => err.code === "CONTENT_SAFETY_VIOLATION"
    );
    assert.equal(safetyAttempts, 1, "CONTENT_SAFETY_VIOLATION must NEVER be retried");

    await assert.rejects(
      () => executor.execute({ workflow: singleNodeWf, input: { prompt: "bad_input" } }),
      (err) => err.code === "GENERATION_VALIDATION_ERROR"
    );
    assert.equal(userFaultAttempts, 1, "USER_FAULT must NEVER be retried");

    const recovered = await executor.execute({
      workflow: singleNodeWf,
      input: { prompt: "transient_ok" },
    });
    assert.equal(recovered.status, "completed");
    assert.equal(upstreamAttempts, 3, "UPSTREAM_FAULT must be retried according to retryPolicy");

    // C) Verify V3Dispatcher.executeQueuedV3Run releases hold and writes sanitized error_message on failure
    const updatedMediaRecords = [];
    const markedFailedCalls = [];
    const releasedHolds = [];

    const failRegistry = new NodeRegistry();
    failRegistry.register({
      type: "base.image_generate",
      OUTPUT_NODE: true,
      INPUT_TYPES: { required: { prompt: { type: "STRING" } } },
      RETURN_TYPES: { image_url: "IMAGE_URL" },
      estimateCost: () => 10,
      async execute() {
        throw new GenerationUpstreamError(
          "wavespeed internal failure at https://api.wavespeed.ai/v2/secret with SQL SELECT * FROM keys",
          { code: "WAVESPEED_502", category: "UPSTREAM_FAULT", statusCode: 502 }
        );
      },
    });

    const failDispatcher = new V3Dispatcher({
      registry: failRegistry,
      billingTools: {
        reserveHold: async ({ referenceId }) => ({ referenceId }),
        settleHold: async () => {},
        releaseHold: async (args) => {
          releasedHolds.push(args);
        },
        extendHold: async () => {},
      },
      mediaTools: {
        createPendingMedia: async () => ({ mediaId: "media-sanitize-1" }),
        markMediaFailed: async (args) => {
          markedFailedCalls.push(args);
        },
      },
      db: {
        media: {
          updateMedia: async (id, fields) => {
            updatedMediaRecords.push({ id, ...fields });
          },
        },
      },
    });

    await assert.rejects(() =>
      failDispatcher.executeQueuedV3Run({
        workflow: {
          id: "sanitize-wf",
          nodes: [
            {
              id: "gen",
              type: "base.image_generate",
              inputs: { prompt: { fromInput: "prompt" } },
            },
          ],
        },
        input: { prompt: "test", media_id: "media-sanitize-1" },
        userId: "user-1",
        billingHoldId: "hold-sanitize-1",
        runId: "run-sanitize-1",
      })
    );

    assert.equal(releasedHolds.length, 1);
    assert.equal(releasedHolds[0].referenceId, "hold-sanitize-1");
    assert.equal(updatedMediaRecords.length, 1);
    assert.equal(updatedMediaRecords[0].status, "failed");
    assert.ok(
      !/wavespeed|https|SELECT/i.test(updatedMediaRecords[0].error_message),
      "DB media.error_message must be sanitized and never leak provider names, URLs, or SQL"
    );
    assert.equal(markedFailedCalls.length, 1);
    assert.equal(markedFailedCalls[0].errorMessage, updatedMediaRecords[0].error_message);
  });
});
