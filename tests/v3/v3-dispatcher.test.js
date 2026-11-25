import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExecutionEngine } from "../../src/systems/generation/internal/v3/core/ExecutionEngine.js";
import { createJobExecutionContext } from "../../src/systems/generation/internal/v3/core/JobExecutionContext.js";
import { NodeRegistry } from "../../src/systems/generation/internal/v3/core/NodeRegistry.js";
import { WorkflowExecutor } from "../../src/systems/generation/internal/v3/core/WorkflowExecutor.js";

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
    onSuccess: ({ runId }) => {
      events.push(`onSuccess:${runId}`);
    },
    onFailure: ({ stage, errorCode, input }) => {
      events.push(`onFailure:${stage}:${input?.media_id || "none"}:${errorCode}`);
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

describe("ExecutionEngine — Domain-Agnostic Black-Box Launch, Execution & Lifecycle Hooks", () => {
  it("executes full happy path: Ownership -> Compile -> Queue -> Execute -> onSuccess", async () => {
    const { engine, workflow, events } = createEngineTestSetup();

    const launchRes = await engine.launch({
      workflow,
      input: {
        prompt: "A futuristic palace",
        model: "flux-pro",
        media_id: "media-pending-1",
        characters: ["char-001"],
      },
      userId: "user-42",
      executionId: "run-happy-1",
    });

    assert.equal(launchRes.status, "queued");
    assert.equal(launchRes.runId, "run-happy-1");

    const workerRes = await engine.execute({
      workflow,
      input: {
        prompt: "A futuristic palace",
        model: "flux-pro",
        media_id: "media-pending-1",
      },
      userId: "user-42",
      runId: launchRes.runId,
    });

    assert.equal(workerRes.status, "completed");
    assert.equal(workerRes.state.status, "completed");
    assert.deepEqual(events, [
      "assertOwns:character:char-001:user-42",
      "queueDispatch:ok:run-happy-1",
      "execute:image_generate:flux-pro",
      "execute:save_media:media-pending-1",
      "onSuccess:run-happy-1",
    ]);
  });

  it("invokes onFailure hook when queue dispatch fails", async () => {
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
            media_id: "media-pending-1",
          },
          userId: "user-42",
          executionId: "run-qfail-1",
        }),
      /Failed to enqueue workflow/
    );

    assert.deepEqual(events, [
      "queueDispatch:failed",
      "onFailure:launch:media-pending-1:QUEUE_DISPATCH_FAILED",
    ]);
  });

  it("invokes onFailure hook (and never onSuccess) when worker execution fails", async () => {
    const { engine, workflow, events } = createEngineTestSetup({
      shouldNodeFail: true,
    });

    const launchRes = await engine.launch({
      workflow,
      input: {
        prompt: "A futuristic palace",
        model: "flux-pro",
        media_id: "media-pending-1",
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
            media_id: "media-pending-1",
          },
          userId: "user-42",
          runId: launchRes.runId,
        }),
      /Upstream GPU out of memory/
    );

    assert.ok(events.includes("onFailure:execute:media-pending-1:PROVIDER_CRASH"));
    assert.ok(!events.some((e) => e.startsWith("onSuccess")));
  });

  it("wires default jobQueueService cleanly without raw db/billing coupling and resolves V1 UseCase aliases", () => {
    const defaultEngine = new ExecutionEngine();
    assert.ok(defaultEngine.jobQueueService, "default jobQueueService should be wired");
    assert.equal(typeof defaultEngine.jobQueueService.addUseCaseJob, "function");
    assert.equal("db" in defaultEngine, false, "ExecutionEngine must not hold raw db reference");
    assert.equal("walletService" in defaultEngine, false, "ExecutionEngine must not hold walletService");

    const resolvedImg = defaultEngine.resolveWorkflow("image-generation-v1");
    assert.equal(resolvedImg.id, "image-generation-v3");

    const resolvedVid = defaultEngine.resolveWorkflow("video-generation-v1");
    assert.equal(resolvedVid.id, "video-generation-v3");

    const resolvedChar = defaultEngine.resolveWorkflow("character-sheet-v1");
    assert.equal(resolvedChar.id, "character-sheet-v3");
  });

  it("runs completely generic non-media workflows (e.g. custom.send_email) as a pure Black Box without media_id or userId", async () => {
    const sentEmails = [];
    const registry = new NodeRegistry();
    registry.register({
      type: "custom.send_email",
      OUTPUT_NODE: true,
      CACHEABLE: false,
      INPUT_TYPES: {
        required: {
          to: { type: "STRING" },
          subject: { type: "STRING" },
          body: { type: "STRING" },
        },
      },
      RETURN_TYPES: { delivered: "BOOLEAN", messageId: "STRING" },
      async execute(inputs) {
        sentEmails.push(inputs);
        return { delivered: true, messageId: `msg-${sentEmails.length}` };
      },
    });

    const emailWorkflow = {
      id: "send-welcome-email",
      nodes: [
        {
          id: "email",
          type: "custom.send_email",
          inputs: {
            to: { fromInput: "to" },
            subject: { fromInput: "subject" },
            body: { fromInput: "body" },
          },
        },
      ],
    };

    const queued = [];
    const engine = new ExecutionEngine({
      registry,
      jobQueueService: {
        addUseCaseJob: async (payload) => {
          queued.push(payload);
          return { id: `job-${payload.executionId}` };
        },
      },
    });

    const launched = await engine.launch({
      workflow: emailWorkflow,
      input: { to: "alice@example.com", subject: "Welcome", body: "Hello Alice!" },
      executionId: "run-email-1",
    });

    assert.equal(launched.status, "queued");
    assert.equal(queued.length, 1);

    const execRes = await engine.execute({
      workflow: queued[0].workflow,
      input: queued[0].input,
      executionId: queued[0].executionId,
      runId: queued[0].workflowRunId,
    });

    assert.equal(execRes.status, "completed");
    assert.deepEqual(execRes.terminalOutputs.email, { delivered: true, messageId: "msg-1" });
    assert.deepEqual(sentEmails, [{ to: "alice@example.com", subject: "Welcome", body: "Hello Alice!" }]);
  });

  it("validates requiredInputs upfront from workflow contract before queueing", async () => {
    let queueCalls = 0;
    const engine = new ExecutionEngine({
      jobQueueService: {
        addUseCaseJob: async () => {
          queueCalls++;
          return { id: "should-not-queue" };
        },
      },
    });

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
    assert.equal(queueCalls, 0);
  });

  it("enforces error classification, fail-fast execution (0 retries), and sanitizeClientError via onFailure", async () => {
    const {
      sanitizeClientError,
      GenerationSafetyError,
      GenerationHoldExpiredError,
      GenerationUpstreamError,
      GenerationValidationError,
    } = await import("../../src/systems/generation/internal/errors.js");

    // A) Verify sanitizeClientError strips internal provider names, URLs, stack traces, and SQL leaks across all categories
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
    assert.ok(!/wavespeed|ltx|https|file\.js/i.test(upstreamSanitized.userMessage));

    const holdSanitized = sanitizeClientError(new GenerationHoldExpiredError("Hold expired for media-1"));
    assert.equal(holdSanitized.code, "HOLD_EXPIRED");
    assert.equal(holdSanitized.category, "HOLD_EXPIRED");
    assert.equal(holdSanitized.statusCode, 409);

    const sqlLeakSanitized = sanitizeClientError(
      new Error('SELECT * FROM media WHERE id = "123" relation "media" does not exist in supabase postgres')
    );
    assert.equal(sqlLeakSanitized.category, "SERVER_FAULT");
    assert.equal(sqlLeakSanitized.statusCode, 500);
    assert.ok(!/SELECT|supabase|postgres|relation/i.test(sqlLeakSanitized.userMessage));

    // B) Verify WorkflowExecutor runs single-attempt fail-fast across all error types
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
        throw new GenerationUpstreamError("Temporary 503 upstream glitch", {
          statusCode: 503,
          category: "UPSTREAM_FAULT",
          retryable: true,
        });
      },
    });

    const singleNodeWf = {
      id: "fail-fast-test-wf",
      nodes: [
        {
          id: "llm",
          type: "base.llm",
          inputs: { prompt: { fromInput: "prompt" } },
        },
      ],
    };
    const executor = new WorkflowExecutor(retryRegistry);

    await assert.rejects(
      () => executor.execute({ workflow: singleNodeWf, input: { prompt: "unsafe" } }),
      (err) => err.code === "CONTENT_SAFETY_VIOLATION"
    );
    assert.equal(safetyAttempts, 1);

    await assert.rejects(
      () => executor.execute({ workflow: singleNodeWf, input: { prompt: "bad_input" } }),
      (err) => err.code === "GENERATION_VALIDATION_ERROR"
    );
    assert.equal(userFaultAttempts, 1);

    await assert.rejects(
      () => executor.execute({ workflow: singleNodeWf, input: { prompt: "transient" } }),
      (err) => err.code === "GENERATION_UPSTREAM_ERROR"
    );
    assert.equal(upstreamAttempts, 1, "Fail-fast WorkflowExecutor executes transient faults strictly once");

    // C) Verify ExecutionEngine.execute writes sanitized errorMessage to onFailure hook
    const hookFailures = [];
    const failRegistry = new NodeRegistry();
    failRegistry.register({
      type: "base.image_generate",
      OUTPUT_NODE: true,
      CACHEABLE: false,
      INPUT_TYPES: { required: { prompt: { type: "STRING" } } },
      RETURN_TYPES: { image_url: "IMAGE_URL" },
      async execute() {
        throw new GenerationUpstreamError(
          "wavespeed internal failure at https://api.wavespeed.ai/v2/secret with SQL SELECT * FROM keys",
          { code: "WAVESPEED_502", category: "UPSTREAM_FAULT", statusCode: 502 }
        );
      },
    });

    const failEngine = new ExecutionEngine({
      registry: failRegistry,
      onFailure: (payload) => {
        hookFailures.push(payload);
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
        runId: "run-sanitize-1",
      })
    );

    assert.equal(hookFailures.length, 1);
    assert.equal(hookFailures[0].input.media_id, "media-sanitize-1");
    assert.ok(
      !/wavespeed|https|SELECT/i.test(hookFailures[0].errorMessage),
      "onFailure errorMessage must be sanitized and never leak provider names, URLs, or SQL"
    );
  });

  // =========================================================================
  // INDEPENDENT EXECUTION REGRESSION SCENARIOS (A, B, C, F + Compilation)
  // =========================================================================

  it("Scenario A: 1 user submits 10 identical prompts simultaneously -> 10 independent runs, 0 cross-run cache hits, 10 distinct provider invocations", async () => {
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
      identityTools: { assertOwns: async () => true, assertOwnsAny: async () => true },
      jobQueueService: {
        addUseCaseJob: async (payload) => {
          queuedPayloads.push(payload);
          return { id: `job-${payload.executionId}`, data: payload };
        },
      },
    });

    // Launch 10 identical prompts concurrently with caller-supplied media_id
    const launches = await Promise.all(
      Array.from({ length: 10 }, () =>
        engine.launch({
          workflow,
          input: { prompt: "identical neon cat", model: "nanobana_2", media_id: `media-a-${++mediaSeq}` },
          userId: "user-scenario-a",
        })
      )
    );

    assert.equal(launches.length, 10);
    assert.equal(new Set(launches.map((l) => l.executionId)).size, 10, "10 distinct executionIds");
    assert.equal(new Set(launches.map((l) => l.runId)).size, 10, "10 distinct runIds");
    assert.equal(new Set(launches.map((l) => l.jobId)).size, 10, "10 distinct jobIds");

    // Execute all 10 queued jobs concurrently
    const results = await Promise.all(
      queuedPayloads.map((p) =>
        engine.execute({
          workflow,
          input: p.input,
          userId: p.userId,
          executionId: p.executionId,
          runId: p.workflowRunId,
          jobId: `job-${p.executionId}`,
        })
      )
    );

    assert.equal(providerInvocations, 10, "10 distinct provider invocations (zero cross-run reuse)");
    for (const r of results) {
      assert.equal(r.status, "completed");
      assert.deepEqual(r.cacheHits, [], "0 cross-run cache hits");
    }
    assert.equal(new Set(savedOutputs.values()).size, 10, "10 distinct generated asset URLs");
  });

  it("Scenario B: 5 users x 10 generations (50 concurrent executions) -> 50 isolated JobExecutionContext states & cleared caches", async () => {
    const users = ["user-b-1", "user-b-2", "user-b-3", "user-b-4", "user-b-5"];
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
      identityTools: { assertOwns: async () => true, assertOwnsAny: async () => true },
      jobQueueService: {
        addUseCaseJob: async (payload) => ({ id: `job-${payload.executionId}`, data: payload }),
      },
    });

    const allTasks = [];
    for (const userId of users) {
      for (let i = 0; i < 10; i++) {
        allTasks.push(async () => {
          const mediaId = `media-b-${userId}-${++mediaSeq}`;
          const launched = await engine.launch({
            workflow,
            input: { prompt: `shared-prompt-${i}`, media_id: mediaId },
            userId,
          });
          const jobCtx = createJobExecutionContext({
            executionId: launched.executionId,
            runId: launched.runId,
            jobId: launched.jobId,
            userId,
            blueprintId: workflow.id,
          });
          jobContexts.push(jobCtx);
          const result = await engine.execute({
            workflow,
            input: { prompt: `shared-prompt-${i}`, media_id: mediaId },
            userId,
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
  });

  it("Scenario C: 1 execution fails while 9 sibling executions on a SHARED workflowId succeed -> ONLY failed execution notifies onFailure for its own mediaId", async () => {
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
      identityTools: { assertOwns: async () => true, assertOwnsAny: async () => true },
      onFailure: ({ input, errorCode, errorMessage }) => {
        const mediaId = input?.media_id;
        failedCalls.push({ mediaId, errorCode, errorMessage });
        mediaStatuses.set(mediaId, { status: "failed", errorCode, errorMessage });
      },
      jobQueueService: {
        addUseCaseJob: async (payload) => ({ id: `job-${payload.executionId}`, data: payload }),
      },
    });

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
            media_id: `media-c-${idx}`,
            serverWorkflowId: sharedWorkflowId,
            serverMediaIds: [`media-c-${idx}`],
          },
          userId: "user-scenario-c",
          runId: l.runId,
        })
      )
    );

    const rejected = outcomes.filter((o) => o.status === "rejected");
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    assert.equal(rejected.length, 1, "Exactly 1 execution failed");
    assert.equal(fulfilled.length, 9, "All 9 sibling executions succeeded untouched");

    assert.equal(failedCalls.length, 1, "onFailure called ONLY for the 1 failed mediaId");
    assert.equal(failedCalls[0].mediaId, "media-c-4");
    assert.equal(mediaStatuses.get("media-c-4").status, "failed");

    for (let idx = 0; idx < 10; idx++) {
      if (idx === 4) continue;
      assert.equal(mediaStatuses.get(`media-c-${idx}`).status, "success", `Sibling media-c-${idx} must remain success`);
    }
  });

  it("Scenario F: 2 different users reference the same <character:char-1> inline tag -> User B fails closed on ownership and NEVER hits User A's cached resolve_references", async () => {
    let resolveExecutions = 0;
    const ownershipChecks = [];
    const registry = new NodeRegistry();
    registry.register({
      type: "base.resolve_references",
      OUTPUT_NODE: false,
      CACHEABLE: true,
      INPUT_TYPES: { required: { prompt: { type: "STRING" } } },
      RETURN_TYPES: { prepared_prompt: "STRING" },
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
      input: { prompt: "Portrait of <character:char-1> at sunset", media_id: "media-f-user-A" },
      userId: "user-A",
    });
    const resA = await engine.execute({
      workflow,
      input: { prompt: "Portrait of <character:char-1> at sunset", media_id: "media-f-user-A" },
      userId: "user-A",
      runId: launchA.runId,
    });
    assert.equal(resA.status, "completed");
    assert.equal(resolveExecutions, 1);

    // 2. User B attempts launch with the SAME inline <character:char-1> tag -> fails closed at pre-queue ownership check!
    await assert.rejects(
      () =>
        engine.launch({
          workflow,
          input: { prompt: "Portrait of <character:char-1> at sunset", media_id: "media-f-user-B" },
          userId: "user-B",
        }),
      (err) => err.statusCode === 404
    );

    assert.equal(enqueuedJobs.length, 1, "User B must NOT enqueue any job");
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
});
