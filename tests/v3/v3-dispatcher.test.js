import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExecutionEngine } from "../../src/systems/generation/internal/v3/core/ExecutionEngine.js";
import { createJobExecutionContext } from "../../src/systems/generation/internal/v3/core/JobExecutionContext.js";
import { NodeRegistry } from "../../src/systems/generation/internal/v3/core/NodeRegistry.js";
import { WorkflowExecutor } from "../../src/systems/generation/internal/v3/core/WorkflowExecutor.js";
import { InMemoryWalletService } from "../helpers/inMemoryWalletService.js";

function createEngineTestSetup({ shouldQueueFail = false, shouldNodeFail = false } = {}) {
  const events = [];
  const registry = new NodeRegistry();

  registry.register({
    type: "base.image_generate",
    OUTPUT_NODE: false,
    CACHEABLE: false,
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

  const engine = new ExecutionEngine({
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
      reserveCredits: async ({ userId, amount, referenceId }) => {
        events.push(`reserveCredits:${userId}:${amount}:${referenceId}`);
        return { referenceId, status: "held", amount };
      },
      settleCredits: async ({ referenceId }) => {
        events.push(`settleCredits:${referenceId}`);
        return { referenceId, status: "settled", settled: true };
      },
      rollbackCredits: async ({ referenceId }) => {
        events.push(`rollbackCredits:${referenceId}`);
        return { referenceId, status: "released", rolledBack: true };
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

  return { engine, workflow, events };
}

describe("ExecutionEngine — Independent Pre-Queue Launch, Isolated Execution & Settlement", () => {
  it("executes full happy path: Ownership -> Cost -> Hold -> Placeholder -> Queue -> Execute -> Settle", async () => {
    const { engine, workflow, events } = createEngineTestSetup();

    const launchRes = await engine.launch({
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
    assert.equal(launchRes.billingHoldId, "exec:test-image-v3:user-42:run-happy-1");

    const workerRes = await engine.execute({
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
    assert.equal(workerRes.state.status, "completed");
    assert.deepEqual(events, [
      "assertOwns:character:char-001:user-42",
      "reserveCredits:user-42:25:exec:test-image-v3:user-42:run-happy-1",
      "createPendingMedia:user-42:test-image-v3",
      "queueDispatch:ok:run-happy-1",
      "execute:image_generate:flux-pro",
      "execute:save_media:media-pending-1",
      "settleCredits:exec:test-image-v3:user-42:run-happy-1",
    ]);
  });

  it("rolls back credit hold and marks placeholder media as failed when queue dispatch fails", async () => {
    const { engine, workflow, events } = createEngineTestSetup({
      shouldQueueFail: true,
    });

    await assert.rejects(
      () =>
        engine.launch({
          workflow,
          input: {
            prompt: "A futuristic palace",
            model: "flux-pro",
          },
          userId: "user-42",
          executionId: "run-qfail-1",
        }),
      /Failed to enqueue workflow/
    );

    assert.deepEqual(events, [
      "reserveCredits:user-42:25:exec:test-image-v3:user-42:run-qfail-1",
      "createPendingMedia:user-42:test-image-v3",
      "queueDispatch:failed",
      "rollbackCredits:exec:test-image-v3:user-42:run-qfail-1",
      "markMediaFailed:media-pending-1:QUEUE_DISPATCH_FAILED",
    ]);
  });

  it("releases credit hold and marks media failed when worker execution fails", async () => {
    const { engine, workflow, events } = createEngineTestSetup({
      shouldNodeFail: true,
    });

    const launchRes = await engine.launch({
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
        engine.execute({
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

    assert.ok(events.includes("rollbackCredits:exec:test-image-v3:user-42:run-wfail-1"));
    assert.ok(events.includes("markMediaFailed:media-pending-1:PROVIDER_CRASH"));
    assert.ok(!events.some((e) => e.startsWith("settleCredits")));
  });

  it("wires default jobQueueService and extendHold from #billing/tools and resolves V1 UseCase aliases", () => {
    const defaultEngine = new ExecutionEngine();
    assert.ok(defaultEngine.jobQueueService, "default jobQueueService should be wired");
    assert.equal(typeof defaultEngine.jobQueueService.addUseCaseJob, "function");
    assert.equal(typeof defaultEngine.billingTools.extendHold, "function");
    assert.equal("db" in defaultEngine, false, "ExecutionEngine must not hold raw db reference");

    const resolvedImg = defaultEngine.resolveWorkflow("image-generation-v1");
    assert.equal(resolvedImg.id, "image-generation-v3");

    const resolvedVid = defaultEngine.resolveWorkflow("video-generation-v1");
    assert.equal(resolvedVid.id, "video-generation-v3");

    const resolvedChar = defaultEngine.resolveWorkflow("character-sheet-v1");
    assert.equal(resolvedChar.id, "character-sheet-v3");
  });

  it("reuses caller-supplied media_id directly without calling createPendingMedia", async () => {
    const { engine, workflow, events } = createEngineTestSetup();

    const launchRes = await engine.launch({
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
    const engine = new ExecutionEngine({
      identityTools: {
        assertOwns: async () => true,
        assertOwnsAny: async () => true,
      },
      billingTools: {
        reserveCredits: async ({ referenceId, amount }) => ({ referenceId, amount, status: "held" }),
        settleCredits: async ({ referenceId }) => ({ referenceId, status: "settled", settled: true }),
        rollbackCredits: async ({ referenceId }) => ({ referenceId, status: "released", rolledBack: true }),
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
        engine.launch({
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
    await engine.launch({
      useCaseId: "imageGeneration",
      input: { prompt: "A serene lake" },
      userId: "user-contract-1",
      executionId: "run-img-contract",
    });

    // 3. video-generation-v3 (or alias videoGeneration): mediaType="video", role="output", saveType="video_output"
    await engine.launch({
      useCaseId: "videoGeneration",
      input: { prompt: "Ocean waves crashing" },
      userId: "user-contract-1",
      executionId: "run-vid-contract",
    });

    // 4. character-sheet-v3 (or alias characterSheet): mediaType="image", role="sheet", saveType="character_sheet"
    await engine.launch({
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

  it("enforces the 4 error categories, retry rules, HOLD_EXPIRED guard, and sanitizeClientError via mediaTools.markMediaFailed", async () => {
    const {
      sanitizeClientError,
      GenerationSafetyError,
      GenerationHoldExpiredError,
      GenerationUpstreamError,
      GenerationValidationError,
    } = await import("../../src/systems/generation/internal/errors.js");

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
      CACHEABLE: false,
      INPUT_TYPES: { required: { prompt: { type: "STRING" } } },
      RETURN_TYPES: { text: "STRING" },
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
        return { text: "Recovered on attempt 3" };
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

    // C) Verify ExecutionEngine.execute releases hold and writes sanitized errorMessage via mediaTools.markMediaFailed
    const markedFailedCalls = [];
    const releasedHolds = [];

    const failRegistry = new NodeRegistry();
    failRegistry.register({
      type: "base.image_generate",
      OUTPUT_NODE: true,
      CACHEABLE: false,
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

    const failEngine = new ExecutionEngine({
      registry: failRegistry,
      billingTools: {
        reserveCredits: async ({ referenceId }) => ({ referenceId }),
        settleCredits: async () => ({ settled: true }),
        rollbackCredits: async (args) => {
          releasedHolds.push(args);
          return { rolledBack: true };
        },
        extendHold: async () => {},
      },
      mediaTools: {
        createPendingMedia: async () => ({ mediaId: "media-sanitize-1" }),
        markMediaFailed: async (args) => {
          markedFailedCalls.push(args);
        },
      },
    });

    await assert.rejects(() =>
      failEngine.execute({
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
    assert.equal(markedFailedCalls.length, 1);
    assert.equal(markedFailedCalls[0].mediaId, "media-sanitize-1");
    assert.ok(
      !/wavespeed|https|SELECT/i.test(markedFailedCalls[0].errorMessage),
      "markMediaFailed errorMessage must be sanitized and never leak provider names, URLs, or SQL"
    );
  });

  // =========================================================================
  // INDEPENDENT EXECUTION REGRESSION SCENARIOS (A, B, C, F + H4)
  // =========================================================================

  it("Scenario A: 1 user submits 10 identical prompts simultaneously -> 10 independent runs, 0 cross-run cache hits, 10 distinct provider invocations", async () => {
    const wallet = new InMemoryWalletService();
    await wallet.setBalance("user-scenario-a", 1000);

    let providerInvocations = 0;
    let mediaSeq = 0;
    const queuedPayloads = [];
    const savedOutputs = new Map();

    const registry = new NodeRegistry();
    registry.register({
      type: "base.resolve_references",
      OUTPUT_NODE: false,
      CACHEABLE: true,
      INPUT_TYPES: { required: { prompt: { type: "STRING" } } },
      RETURN_TYPES: { prepared_prompt: "STRING" },
      estimateCost: () => 0,
      async execute(inputs, ctx) {
        return { prepared_prompt: `${inputs.prompt} [${ctx.runId}]` };
      },
    });
    registry.register({
      type: "base.image_generate",
      OUTPUT_NODE: false,
      CACHEABLE: false,
      INPUT_TYPES: { required: { model: { type: "STRING" }, prompt: { type: "STRING" } } },
      RETURN_TYPES: { image_url: "IMAGE_URL" },
      estimateCost: () => 10,
      async execute(inputs, ctx) {
        const callNum = ++providerInvocations;
        await new Promise((r) => setTimeout(r, 2));
        return { image_url: `https://cdn.example.com/a/${ctx.runId}/${callNum}.png` };
      },
    });
    registry.register({
      type: "base.save_media",
      OUTPUT_NODE: true,
      INPUT_TYPES: { required: { media_id: { type: "STRING" }, asset_url: { type: "STRING" } } },
      RETURN_TYPES: { saved_media: "JSON" },
      estimateCost: () => 0,
      async execute(inputs) {
        savedOutputs.set(inputs.media_id, inputs.asset_url);
        return { saved_media: { id: inputs.media_id, url: inputs.asset_url } };
      },
    });

    const workflow = {
      id: "scenario-a-wf",
      nodes: [
        { id: "resolve", type: "base.resolve_references", inputs: { prompt: { fromInput: "prompt" } } },
        {
          id: "gen",
          type: "base.image_generate",
          inputs: { model: "nanobana_2", prompt: { fromNode: "resolve", output: "prepared_prompt" } },
        },
        {
          id: "save",
          type: "base.save_media",
          inputs: { media_id: { fromInput: "media_id" }, asset_url: { fromNode: "gen", output: "image_url" } },
        },
      ],
    };

    const engine = new ExecutionEngine({
      registry,
      walletService: wallet,
      identityTools: { assertOwns: async () => true, assertOwnsAny: async () => true },
      mediaTools: {
        createPendingMedia: async () => ({ mediaId: `media-a-${++mediaSeq}`, status: "processing" }),
        markMediaFailed: async () => {},
      },
      jobQueueService: {
        addUseCaseJob: async (payload) => {
          queuedPayloads.push(payload);
          return { id: `job-${payload.executionId}`, data: payload };
        },
      },
    });

    // Launch 10 identical prompts concurrently
    const launches = await Promise.all(
      Array.from({ length: 10 }, () =>
        engine.launch({
          workflow,
          input: { prompt: "identical neon cat", model: "nanobana_2" },
          userId: "user-scenario-a",
        })
      )
    );

    assert.equal(launches.length, 10);
    assert.equal(new Set(launches.map((l) => l.executionId)).size, 10, "10 distinct executionIds");
    assert.equal(new Set(launches.map((l) => l.runId)).size, 10, "10 distinct runIds");
    assert.equal(new Set(launches.map((l) => l.mediaId)).size, 10, "10 distinct mediaIds");
    assert.equal(new Set(launches.map((l) => l.jobId)).size, 10, "10 distinct jobIds");
    assert.equal(new Set(launches.map((l) => l.billingHoldId)).size, 10, "10 distinct billingHoldIds");

    // Execute all 10 queued jobs concurrently
    const results = await Promise.all(
      queuedPayloads.map((p) =>
        engine.execute({
          workflow,
          input: p.input,
          userId: p.userId,
          billingHoldId: p.billingHoldId,
          executionId: p.executionId,
          runId: p.workflowRunId,
          jobId: `job-${p.executionId}`,
        })
      )
    );

    assert.equal(providerInvocations, 10, "10 distinct provider invocations (zero cross-run reuse)");
    for (const r of results) {
      assert.equal(r.status, "completed");
      assert.equal(r.billingStatus, "settled");
      assert.deepEqual(r.cacheHits, [], "0 cross-run cache hits");
    }
    assert.equal(new Set(savedOutputs.values()).size, 10, "10 distinct generated asset URLs");
    assert.equal(await wallet.getBalance("user-scenario-a"), 900, "Exactly 10 x 10 = 100 credits settled");
  });

  it("Scenario B: 5 users x 10 generations (50 concurrent executions) -> 50 isolated JobExecutionContext states & cleared caches", async () => {
    const wallet = new InMemoryWalletService();
    const users = ["user-b-1", "user-b-2", "user-b-3", "user-b-4", "user-b-5"];
    for (const u of users) {
      await wallet.setBalance(u, 500);
    }

    let mediaSeq = 0;
    const jobContexts = [];
    const seenContextScopes = [];

    const registry = new NodeRegistry();
    registry.register({
      type: "base.resolve_references",
      OUTPUT_NODE: false,
      CACHEABLE: true,
      INPUT_TYPES: { required: { prompt: { type: "STRING" } } },
      RETURN_TYPES: { prepared_prompt: "STRING" },
      estimateCost: () => 0,
      async execute(inputs, ctx) {
        return { prepared_prompt: `${ctx.userId}:${inputs.prompt}` };
      },
    });
    registry.register({
      type: "base.image_generate",
      OUTPUT_NODE: false,
      CACHEABLE: false,
      INPUT_TYPES: { required: { prompt: { type: "STRING" } } },
      RETURN_TYPES: { image_url: "IMAGE_URL" },
      estimateCost: () => 5,
      async execute(inputs, ctx) {
        seenContextScopes.push({ userId: ctx.userId, runId: ctx.runId, prompt: inputs.prompt });
        return { image_url: `https://cdn.example.com/b/${ctx.userId}/${ctx.runId}.png` };
      },
    });
    registry.register({
      type: "base.save_media",
      OUTPUT_NODE: true,
      INPUT_TYPES: { required: { media_id: { type: "STRING" }, asset_url: { type: "STRING" } } },
      RETURN_TYPES: { saved_media: "JSON" },
      estimateCost: () => 0,
      async execute(inputs) {
        return { saved_media: { id: inputs.media_id, url: inputs.asset_url } };
      },
    });

    const workflow = {
      id: "scenario-b-wf",
      nodes: [
        { id: "resolve", type: "base.resolve_references", inputs: { prompt: { fromInput: "prompt" } } },
        { id: "gen", type: "base.image_generate", inputs: { prompt: { fromNode: "resolve", output: "prepared_prompt" } } },
        { id: "save", type: "base.save_media", inputs: { media_id: { fromInput: "media_id" }, asset_url: { fromNode: "gen", output: "image_url" } } },
      ],
    };

    const engine = new ExecutionEngine({
      registry,
      walletService: wallet,
      identityTools: { assertOwns: async () => true, assertOwnsAny: async () => true },
      mediaTools: {
        createPendingMedia: async ({ userId }) => ({ mediaId: `media-b-${userId}-${++mediaSeq}` }),
        markMediaFailed: async () => {},
      },
      jobQueueService: {
        addUseCaseJob: async (payload) => ({ id: `job-${payload.executionId}`, data: payload }),
      },
    });

    const allTasks = [];
    for (const userId of users) {
      for (let i = 0; i < 10; i++) {
        allTasks.push(async () => {
          const launched = await engine.launch({
            workflow,
            input: { prompt: `shared-prompt-${i}` },
            userId,
          });
          const jobCtx = createJobExecutionContext({
            executionId: launched.executionId,
            runId: launched.runId,
            jobId: launched.jobId,
            userId,
            blueprintId: workflow.id,
            billingHoldId: launched.billingHoldId,
            mediaId: launched.mediaId,
          });
          jobContexts.push(jobCtx);
          const result = await engine.execute({
            workflow,
            input: { prompt: `shared-prompt-${i}`, media_id: launched.mediaId },
            userId,
            billingHoldId: launched.billingHoldId,
            executionId: launched.executionId,
            runId: launched.runId,
            jobId: launched.jobId,
            jobContext: jobCtx,
          });
          return { launched, result, jobCtx };
        });
      }
    }

    const completed = await Promise.all(allTasks.map((fn) => fn()));

    assert.equal(completed.length, 50);
    assert.equal(new Set(completed.map((c) => c.launched.jobId)).size, 50, "50 unique jobIds");
    assert.equal(new Set(completed.map((c) => c.launched.mediaId)).size, 50, "50 unique mediaIds");
    assert.equal(seenContextScopes.length, 50);

    for (const { result, jobCtx } of completed) {
      assert.equal(result.status, "completed");
      assert.equal(jobCtx.state.status, "completed");
      assert.ok(jobCtx.state.startedAt && jobCtx.state.finishedAt);
      assert.equal(jobCtx.cache.size, 0, "Every JobExecutionContext cache must be cleared after completion");
      assert.ok(
        result.terminalOutputs.save.saved_media.url.includes(`/${jobCtx.identity.userId}/${jobCtx.identity.runId}.png`),
        "No cross-tenant output leakage"
      );
    }

    for (const u of users) {
      assert.equal(await wallet.getBalance(u), 450, `User ${u} paid exactly 10 x 5 = 50 credits`);
    }
  });

  it("Scenario C: 1 execution fails while 9 sibling executions on a SHARED workflowId succeed -> ONLY failed execution rolls back & fails its own mediaId", async () => {
    const wallet = new InMemoryWalletService();
    await wallet.setBalance("user-scenario-c", 500);

    const sharedWorkflowId = "shared-wf-scenario-c";
    const mediaStatuses = new Map();
    const failedCalls = [];

    const registry = new NodeRegistry();
    registry.register({
      type: "base.image_generate",
      OUTPUT_NODE: false,
      CACHEABLE: false,
      INPUT_TYPES: { required: { prompt: { type: "STRING" } } },
      RETURN_TYPES: { image_url: "IMAGE_URL" },
      estimateCost: () => 10,
      async execute(inputs, ctx) {
        if (inputs.prompt === "trigger-failure") {
          const err = new Error("Single run GPU crash");
          err.code = "PROVIDER_CRASH";
          throw err;
        }
        return { image_url: `https://cdn.example.com/c/${ctx.runId}.png` };
      },
    });
    registry.register({
      type: "base.save_media",
      OUTPUT_NODE: true,
      INPUT_TYPES: { required: { media_id: { type: "STRING" }, asset_url: { type: "STRING" } } },
      RETURN_TYPES: { saved_media: "JSON" },
      estimateCost: () => 0,
      async execute(inputs) {
        mediaStatuses.set(inputs.media_id, { status: "success", url: inputs.asset_url });
        return { saved_media: { id: inputs.media_id, url: inputs.asset_url } };
      },
    });

    const workflow = {
      id: "scenario-c-wf",
      nodes: [
        { id: "gen", type: "base.image_generate", inputs: { prompt: { fromInput: "prompt" } } },
        { id: "save", type: "base.save_media", inputs: { media_id: { fromInput: "media_id" }, asset_url: { fromNode: "gen", output: "image_url" } } },
      ],
    };

    const engine = new ExecutionEngine({
      registry,
      walletService: wallet,
      identityTools: { assertOwns: async () => true, assertOwnsAny: async () => true },
      mediaTools: {
        createPendingMedia: async () => {
          throw new Error("should reuse supplied media_id");
        },
        markMediaFailed: async ({ mediaId, errorCode, errorMessage }) => {
          failedCalls.push({ mediaId, errorCode, errorMessage });
          mediaStatuses.set(mediaId, { status: "failed", errorCode, errorMessage });
        },
      },
      jobQueueService: {
        addUseCaseJob: async (payload) => ({ id: `job-${payload.executionId}`, data: payload }),
      },
    });

    // Launch 10 sibling runs sharing the SAME workflowId, each with its own mediaId
    const launches = await Promise.all(
      Array.from({ length: 10 }, (_, idx) => {
        const mediaId = `media-c-${idx}`;
        mediaStatuses.set(mediaId, { status: "processing" });
        return engine.launch({
          workflow,
          workflowId: sharedWorkflowId,
          input: {
            prompt: idx === 4 ? "trigger-failure" : `valid-prompt-${idx}`,
            media_id: mediaId,
            serverWorkflowId: sharedWorkflowId,
            serverMediaIds: [mediaId],
          },
          userId: "user-scenario-c",
        });
      })
    );

    const outcomes = await Promise.allSettled(
      launches.map((l, idx) =>
        engine.execute({
          workflow,
          input: {
            prompt: idx === 4 ? "trigger-failure" : `valid-prompt-${idx}`,
            media_id: l.mediaId,
            serverWorkflowId: sharedWorkflowId,
            serverMediaIds: [l.mediaId],
          },
          userId: "user-scenario-c",
          billingHoldId: l.billingHoldId,
          runId: l.runId,
        })
      )
    );

    const rejected = outcomes.filter((o) => o.status === "rejected");
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    assert.equal(rejected.length, 1, "Exactly 1 execution failed");
    assert.equal(fulfilled.length, 9, "All 9 sibling executions succeeded untouched");

    // Verify ONLY media-c-4 was marked failed!
    assert.equal(failedCalls.length, 1, "markMediaFailed called ONLY for the 1 failed mediaId");
    assert.equal(failedCalls[0].mediaId, "media-c-4");
    assert.equal(mediaStatuses.get("media-c-4").status, "failed");

    for (let idx = 0; idx < 10; idx++) {
      if (idx === 4) continue;
      assert.equal(mediaStatuses.get(`media-c-${idx}`).status, "success", `Sibling media-c-${idx} must remain success`);
    }

    // Verify ONLY the failed run's hold was released and the 9 siblings were committed
    assert.equal(wallet.reservations.get(launches[4].billingHoldId).status, "released");
    for (let idx = 0; idx < 10; idx++) {
      if (idx === 4) continue;
      assert.equal(wallet.reservations.get(launches[idx].billingHoldId).status, "committed");
    }
    assert.equal(await wallet.getBalance("user-scenario-c"), 410, "500 - 9*10 = 410 (failed run refunded)");
  });

  it("Scenario F: 2 different users reference the same <character:char-1> inline tag -> User B fails closed on ownership and NEVER hits User A's cached resolve_references", async () => {
    const wallet = new InMemoryWalletService();
    await wallet.setBalance("user-A", 100);
    await wallet.setBalance("user-B", 100);

    let resolveExecutions = 0;
    const ownershipChecks = [];
    const registry = new NodeRegistry();
    registry.register({
      type: "base.resolve_references",
      OUTPUT_NODE: false,
      CACHEABLE: true,
      INPUT_TYPES: { required: { prompt: { type: "STRING" } } },
      RETURN_TYPES: { prepared_prompt: "STRING" },
      estimateCost: () => 0,
      async execute(inputs, ctx) {
        resolveExecutions++;
        if (ctx.userId !== "user-A") {
          const err = new Error("Forbidden character reference");
          err.code = "OWNERSHIP_VERIFICATION_FAILED";
          throw err;
        }
        return { prepared_prompt: `${inputs.prompt} [Secret Character Sheet of User A]` };
      },
    });
    registry.register({
      type: "base.save_media",
      OUTPUT_NODE: true,
      INPUT_TYPES: { required: { media_id: { type: "STRING" }, final_prompt: { type: "STRING" } } },
      RETURN_TYPES: { saved_media: "JSON" },
      estimateCost: () => 10,
      async execute(inputs) {
        return { saved_media: { id: inputs.media_id, prompt: inputs.final_prompt } };
      },
    });

    const workflow = {
      id: "scenario-f-wf",
      nodes: [
        { id: "resolve", type: "base.resolve_references", inputs: { prompt: { fromInput: "prompt" } } },
        {
          id: "save",
          type: "base.save_media",
          inputs: { media_id: { fromInput: "media_id" }, final_prompt: { fromNode: "resolve", output: "prepared_prompt" } },
        },
      ],
    };

    const enqueuedJobs = [];
    const engine = new ExecutionEngine({
      registry,
      walletService: wallet,
      identityTools: {
        assertOwns: async (type, id, uid) => {
          ownershipChecks.push({ type, id, uid });
          if (type === "character" && id === "char-1" && uid !== "user-A") {
            const err = new Error(`Character ${id} not found`);
            err.code = "NOT_FOUND";
            err.statusCode = 404;
            throw err;
          }
          return true;
        },
        assertOwnsAny: async () => true,
      },
      mediaTools: {
        createPendingMedia: async ({ userId }) => ({ mediaId: `media-f-${userId}` }),
        markMediaFailed: async () => {},
      },
      jobQueueService: {
        addUseCaseJob: async (payload) => {
          enqueuedJobs.push(payload);
          return { id: `job-${payload.executionId}` };
        },
      },
    });

    // 1. User A launches & executes with inline <character:char-1>
    const launchA = await engine.launch({
      workflow,
      input: { prompt: "Portrait of <character:char-1> at sunset" },
      userId: "user-A",
    });
    const resA = await engine.execute({
      workflow,
      input: { prompt: "Portrait of <character:char-1> at sunset", media_id: launchA.mediaId },
      userId: "user-A",
      billingHoldId: launchA.billingHoldId,
      runId: launchA.runId,
    });
    assert.equal(resA.status, "completed");
    assert.equal(resolveExecutions, 1);

    // 2. User B attempts launch with the SAME inline <character:char-1> tag -> fails closed at pre-queue ownership check!
    await assert.rejects(
      () =>
        engine.launch({
          workflow,
          input: { prompt: "Portrait of <character:char-1> at sunset" },
          userId: "user-B",
        }),
      (err) => err.statusCode === 404
    );

    assert.equal(enqueuedJobs.length, 1, "User B must NOT enqueue any job");
    assert.equal(await wallet.getBalance("user-B"), 100, "User B must NOT be charged");
    assert.ok(
      ownershipChecks.some((c) => c.type === "character" && c.id === "char-1" && c.uid === "user-B"),
      "ExecutionEngine.launch must validate inline <character:char-1> ownership for User B"
    );

    // 3. Defense-in-depth: even if User B reached execute(), User B NEVER hits User A's cached resolve_references
    await assert.rejects(
      () =>
        engine.execute({
          workflow,
          input: { prompt: "Portrait of <character:char-1> at sunset", media_id: "media-f-user-B" },
          userId: "user-B",
          runId: "run-b-defense",
        }),
      /Forbidden character reference/
    );
    assert.equal(resolveExecutions, 2, "resolve_references ran fresh for User B (zero cross-tenant cache hit)");
  });

  it("H4: ExecutionEngine.launch fails closed on unknown model / pricing error instead of silently reserving 1 credit", async () => {
    const wallet = new InMemoryWalletService();
    await wallet.setBalance("user-h4", 100);

    let pendingMediaCreated = 0;
    let queuedCount = 0;

    const engine = new ExecutionEngine({
      walletService: wallet,
      identityTools: { assertOwns: async () => true, assertOwnsAny: async () => true },
      mediaTools: {
        createPendingMedia: async () => {
          pendingMediaCreated++;
          return { mediaId: "should-not-create" };
        },
        markMediaFailed: async () => {},
      },
      jobQueueService: {
        addUseCaseJob: async () => {
          queuedCount++;
          return { id: "should-not-queue" };
        },
      },
    });

    await assert.rejects(
      () =>
        engine.launch({
          useCaseId: "image-generation-v3",
          input: {
            prompt: "A castle in the clouds",
            model: "totally_unknown_model_does_not_exist_xyz",
          },
          userId: "user-h4",
        }),
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );

    assert.equal(wallet.reservations.size, 0, "MUST NOT silently fall back to reserving 1 credit");
    assert.equal(await wallet.getBalance("user-h4"), 100, "User balance untouched");
    assert.equal(pendingMediaCreated, 0, "No pending media created on compilation/pricing failure");
    assert.equal(queuedCount, 0, "No job enqueued on compilation/pricing failure");
  });
});
