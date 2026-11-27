import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExecutionEngine } from "../../../src/systems/workflow-engine/internal/core/ExecutionEngine.js";
import { createJobExecutionContext } from "../../../src/systems/workflow-engine/internal/core/JobExecutionContext.js";
import { NodeRegistry } from "../../../src/systems/workflow-engine/internal/core/NodeRegistry.js";
import { WorkflowExecutor } from "../../../src/systems/workflow-engine/internal/core/WorkflowExecutor.js";
import { WorkflowDispatchService } from "#generation/tools";
import { verifyInput, calculateCost, createWorkflowEngine } from "#workflow-engine/tools";

function createEngineAndDispatcherSetup({ shouldQueueFail = false, shouldNodeFail = false } = {}) {
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

  const dispatcher = new WorkflowDispatchService({
    verifyInput: (wf, input) => {
      const checkEngine = new ExecutionEngine({ registry });
      return checkEngine.verifyInput(wf, input);
    },
    queue: {
      add: async (_name, payload) => {
        if (shouldQueueFail) {
          events.push("queueDispatch:failed");
          throw new Error("Redis connection refused");
        }
        events.push(`queueDispatch:ok:${payload.executionId}`);
        return { id: `job-${payload.executionId}`, data: payload };
      },
    },
  });

  const engine = new ExecutionEngine({
    registry,
    onSuccess: ({ runId }) => {
      events.push(`onSuccess:${runId}`);
    },
    onFailure: ({ stage, errorCode, input }) => {
      events.push(`onFailure:${stage}:${input?.media_id || "none"}:${errorCode}`);
    },
  });

  return { dispatcher, engine, workflow, registry, events };
}

describe("WorkflowDispatchService & Pure ExecutionEngine — Separated Queue vs Black-Box Execution", () => {
  it("executes full happy path: WorkflowDispatchService.dispatch -> ExecutionEngine.runWorkflow -> onSuccess", async () => {
    const { dispatcher, engine, workflow, events } = createEngineAndDispatcherSetup();

    const dispatchRes = await dispatcher.dispatch({
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

    assert.equal(dispatchRes.status, "queued");
    assert.equal(dispatchRes.runId, "run-happy-1");
    assert.equal(dispatchRes.jobId, "job-run-happy-1");

    const workerRes = await engine.runWorkflow(
      workflow,
      {
        prompt: "A futuristic palace",
        model: "flux-pro",
        media_id: "media-pending-1",
      },
      {
        userId: "user-42",
        runId: dispatchRes.runId,
      }
    );

    assert.equal(workerRes.status, "completed");
    assert.equal(workerRes.state.status, "completed");
    assert.deepEqual(events, [
      "queueDispatch:ok:run-happy-1",
      "execute:image_generate:flux-pro",
      "execute:save_media:media-pending-1",
      "onSuccess:run-happy-1",
    ]);
  });

  it("throws 503 QUEUE_DISPATCH_FAILED without invoking ambient engine hooks when queue dispatch fails", async () => {
    const { dispatcher, workflow, events } = createEngineAndDispatcherSetup({
      shouldQueueFail: true,
    });

    await assert.rejects(
      () =>
        dispatcher.dispatch({
          workflow,
          input: {
            prompt: "A futuristic palace",
            model: "flux-pro",
            media_id: "media-pending-1",
          },
          userId: "user-42",
          executionId: "run-qfail-1",
        }),
      (err) => {
        assert.equal(err.code, "QUEUE_DISPATCH_FAILED");
        assert.equal(err.statusCode, 503);
        return true;
      }
    );

    assert.equal(events.filter((e) => e === "queueDispatch:failed").length, 3, "Retries queue enqueue up to 3 attempts");
    assert.ok(!events.some((e) => e.startsWith("onFailure:")), "Dispatch failure must never invoke ambient engine onFailure hooks");
  });

  it("invokes onFailure hook (and never onSuccess) when worker execution fails", async () => {
    const { dispatcher, engine, workflow, events } = createEngineAndDispatcherSetup({
      shouldNodeFail: true,
    });

    const dispatchRes = await dispatcher.dispatch({
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
        engine.runWorkflow(
          workflow,
          {
            prompt: "A futuristic palace",
            model: "flux-pro",
            media_id: "media-pending-1",
          },
          {
            userId: "user-42",
            runId: dispatchRes.runId,
          }
        ),
      /Upstream GPU out of memory/
    );

    assert.ok(events.includes("onFailure:execute:media-pending-1:PROVIDER_CRASH"));
    assert.ok(!events.some((e) => e.startsWith("onSuccess")));
  });

  it("ExecutionEngine is 100% queue-free, DB-free, and billing-free while resolving built-in V3 workflows", () => {
    const defaultEngine = createWorkflowEngine();
    assert.equal("jobQueueService" in defaultEngine, false, "ExecutionEngine must NOT hold jobQueueService");
    assert.equal("launch" in defaultEngine, false, "ExecutionEngine must NOT expose launch()");
    assert.equal("execute" in defaultEngine, false, "ExecutionEngine must NOT expose execute()");
    assert.equal("db" in defaultEngine, false, "ExecutionEngine must NOT hold raw db reference");
    assert.equal("walletService" in defaultEngine, false, "ExecutionEngine must NOT hold walletService");

    const resolvedImg = defaultEngine.resolveWorkflow("image-generation-v3");
    assert.equal(resolvedImg.id, "image-generation-v3");

    const resolvedVid = defaultEngine.resolveWorkflow("video-generation-v3");
    assert.equal(resolvedVid.id, "video-generation-v3");

    const resolvedChar = defaultEngine.resolveWorkflow("character-sheet-v3");
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
    const dispatcher = new WorkflowDispatchService({
      verifyInput: (wf, input) => new ExecutionEngine({ registry }).verifyInput(wf, input),
      queue: {
        add: async (_name, payload) => {
          queued.push(payload);
          return { id: `job-${payload.executionId}` };
        },
      },
    });
    const engine = new ExecutionEngine({ registry });

    const dispatched = await dispatcher.dispatch({
      workflow: emailWorkflow,
      input: { to: "alice@example.com", subject: "Welcome", body: "Hello Alice!" },
      executionId: "run-email-1",
    });

    assert.equal(dispatched.status, "queued");
    assert.equal(queued.length, 1);

    const execRes = await engine.runWorkflow(queued[0].workflow, queued[0].input, {
      executionId: queued[0].executionId,
      runId: queued[0].workflowRunId,
    });

    assert.equal(execRes.status, "completed");
    assert.deepEqual(execRes.terminalOutputs.email, { delivered: true, messageId: "msg-1" });
    assert.deepEqual(sentEmails, [{ to: "alice@example.com", subject: "Welcome", body: "Hello Alice!" }]);
  });

  it("WorkflowDispatchService validates requiredInputs upfront via verifyInput() before queueing", async () => {
    let queueCalls = 0;
    const dispatcher = new WorkflowDispatchService({
      queue: {
        add: async () => {
          queueCalls++;
          return { id: "should-not-queue" };
        },
      },
    });

    await assert.rejects(
      () =>
        dispatcher.dispatch({
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

  it("enforces error classification, fail-fast execution (0 retries), and sanitized errorMessage via onFailure", async () => {
    const {
      sanitizeClientError,
      GenerationSafetyError,
      GenerationHoldExpiredError,
      GenerationUpstreamError,
      GenerationValidationError,
    } = await import("../../../src/systems/generation/internal/errors.js");

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

    // A2) Runway provider names and raw 400 JSON payloads must never leak into client/DB error_message
    const { normalizeModelInvocationError } = await import(
      "../../../src/systems/workflow-engine/internal/nodes/base/mediaNodeHelpers.js"
    );
    const runwayModerationSanitized = sanitizeClientError(
      new GenerationSafetyError("[Runway] Task failed: RunwayML content moderation blocked prompt")
    );
    assert.equal(runwayModerationSanitized.category, "CONTENT_SAFETY_VIOLATION");
    assert.ok(!/runway|runwayml/i.test(runwayModerationSanitized.userMessage));

    const provider400 = Object.assign(
      new Error('Provider rejected input payload: [Runway] 400 {"error":"invalid dimension"}'),
      {
        code: "INVALID_INPUT_REJECTED_BY_PROVIDER",
        statusCode: 400,
        safeMessage: "The model rejected one of the input parameters.",
      }
    );
    const normalized400 = normalizeModelInvocationError(provider400, "gpt_image_2_5_flare");
    const sanitized400 = sanitizeClientError(normalized400);
    assert.equal(sanitized400.code, "INVALID_INPUT_REJECTED_BY_PROVIDER");
    assert.equal(sanitized400.userMessage, "The model rejected one of the input parameters.");
    assert.ok(!/runway|\{"error"/i.test(sanitized400.userMessage));

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

    // C) Verify ExecutionEngine.runWorkflow writes neutral sanitized errorMessage to onFailure hook
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
      failEngine.runWorkflow(
        {
          id: "sanitize-wf",
          nodes: [
            {
              id: "gen",
              type: "base.image_generate",
              inputs: { prompt: { fromInput: "prompt" } },
            },
          ],
        },
        { prompt: "test", media_id: "media-sanitize-1" },
        { userId: "user-1", runId: "run-sanitize-1" }
      )
    );

    assert.equal(hookFailures.length, 1);
    assert.equal(hookFailures[0].input.media_id, "media-sanitize-1");
    assert.ok(
      !/wavespeed|https|SELECT|credit|refund/i.test(hookFailures[0].errorMessage),
      "onFailure errorMessage must be neutral, sanitized, and never leak provider names, URLs, SQL, or billing copy"
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

    const dispatcher = new WorkflowDispatchService({
      verifyInput: (wf, input) => new ExecutionEngine({ registry }).verifyInput(wf, input),
      queue: {
        add: async (_name, payload) => {
          queuedPayloads.push(payload);
          return { id: `job-${payload.executionId}`, data: payload };
        },
      },
    });

    // Dispatch 10 identical prompts concurrently with caller-supplied media_id
    const dispatches = await Promise.all(
      Array.from({ length: 10 }, () =>
        dispatcher.dispatch({
          workflow,
          input: { prompt: "identical neon cat", model: "nanobana_2", media_id: `media-a-${++mediaSeq}` },
          userId: "user-scenario-a",
        })
      )
    );

    assert.equal(dispatches.length, 10);
    assert.equal(new Set(dispatches.map((l) => l.executionId)).size, 10, "10 distinct executionIds");
    assert.equal(new Set(dispatches.map((l) => l.runId)).size, 10, "10 distinct runIds");
    assert.equal(new Set(dispatches.map((l) => l.jobId)).size, 10, "10 distinct jobIds");

    // Execute all 10 queued jobs concurrently with a fresh ExecutionEngine per job
    const results = await Promise.all(
      queuedPayloads.map((p) => {
        const freshEngine = new ExecutionEngine({ registry });
        return freshEngine.runWorkflow(workflow, p.input, {
          userId: p.userId,
          executionId: p.executionId,
          runId: p.workflowRunId,
          jobId: `job-${p.executionId}`,
        });
      })
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

    const dispatcher = new WorkflowDispatchService({
      verifyInput: (wf, input) => new ExecutionEngine({ registry }).verifyInput(wf, input),
      queue: {
        add: async (_name, payload) => ({ id: `job-${payload.executionId}`, data: payload }),
      },
    });

    const allTasks = [];
    for (const userId of users) {
      for (let i = 0; i < 10; i++) {
        allTasks.push(async () => {
          const mediaId = `media-b-${userId}-${++mediaSeq}`;
          const dispatched = await dispatcher.dispatch({
            workflow,
            input: { prompt: `shared-prompt-${i}`, media_id: mediaId },
            userId,
          });
          const jobCtx = createJobExecutionContext({
            executionId: dispatched.executionId,
            runId: dispatched.runId,
            jobId: dispatched.jobId,
            userId,
            blueprintId: workflow.id,
          });
          jobContexts.push(jobCtx);
          const freshEngine = new ExecutionEngine({ registry });
          const result = await freshEngine.runWorkflow(
            workflow,
            { prompt: `shared-prompt-${i}`, media_id: mediaId },
            {
              userId,
              executionId: dispatched.executionId,
              runId: dispatched.runId,
              jobId: dispatched.jobId,
              jobContext: jobCtx,
            }
          );
          return { dispatched, result, jobCtx };
        });
      }
    }

    const completed = await Promise.all(allTasks.map((fn) => fn()));

    assert.equal(completed.length, 50);
    assert.equal(new Set(completed.map((c) => c.dispatched.jobId)).size, 50, "50 unique jobIds");
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

    const dispatcher = new WorkflowDispatchService({
      verifyInput: (wf, input) => new ExecutionEngine({ registry }).verifyInput(wf, input),
      queue: {
        add: async (_name, payload) => ({ id: `job-${payload.executionId}`, data: payload }),
      },
    });

    const onFailure = ({ input, errorCode, errorMessage }) => {
      const mediaId = input?.media_id;
      failedCalls.push({ mediaId, errorCode, errorMessage });
      mediaStatuses.set(mediaId, { status: "failed", errorCode, errorMessage });
    };

    const dispatches = await Promise.all(
      Array.from({ length: 10 }, (_, idx) => {
        const mediaId = `media-c-${idx}`;
        mediaStatuses.set(mediaId, { status: "processing" });
        return dispatcher.dispatch({
          workflow,
          input: {
            prompt: idx === 4 ? "trigger-failure" : `valid-prompt-${idx}`,
            media_id: mediaId,
            serverWorkflowId: sharedWorkflowId,
            serverMediaIds: [mediaId],
          },
          userId: "user-scenario-c",
          serverContext: { workflowId: sharedWorkflowId, mediaIds: [mediaId] },
        });
      })
    );

    const outcomes = await Promise.allSettled(
      dispatches.map((l, idx) => {
        const engine = new ExecutionEngine({ registry, onFailure });
        return engine.runWorkflow(
          workflow,
          {
            prompt: idx === 4 ? "trigger-failure" : `valid-prompt-${idx}`,
            media_id: `media-c-${idx}`,
            serverWorkflowId: sharedWorkflowId,
            serverMediaIds: [`media-c-${idx}`],
          },
          { userId: "user-scenario-c", runId: l.runId }
        );
      })
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

    const engine = new ExecutionEngine({ registry });

    // 1. User A executes with inline <character:char-1>
    const resA = await engine.runWorkflow(
      workflow,
      { prompt: "Portrait of <character:char-1> at sunset", media_id: "media-f-user-A" },
      { userId: "user-A", runId: "run-a-owner" }
    );
    assert.equal(resA.status, "completed");
    assert.equal(resolveExecutions, 1);

    // 2. User B attempts execute with the SAME prompt -> resolve_references verifies ownership and fails closed!
    await assert.rejects(
      () =>
        engine.runWorkflow(
          workflow,
          { prompt: "Portrait of <character:char-1> at sunset", media_id: "media-f-user-B" },
          { userId: "user-B", runId: "run-b-defense" }
        ),
      /Forbidden character reference/
    );
    assert.equal(resolveExecutions, 2, "resolve_references ran fresh for User B (zero cross-tenant cache hit)");
  });

  // =========================================================================
  // PURE 3-TOOL ENGINE TESTS (verifyInput, calculateCost, runWorkflow)
  // =========================================================================

  it("verifyInput() performs pure read-only dry-run validation (never throws, zero Redis/DB side effects)", () => {
    // 1. Valid workflow with required inputs
    const validRes = verifyInput("image-generation-v3", { prompt: "A crystal observatory" });
    assert.equal(validRes.valid, true);
    assert.equal(validRes.workflowId, "image-generation-v3");
    assert.deepEqual(validRes.missing, []);
    assert.deepEqual(validRes.errors, []);

    // 2. Missing required input
    const missingRes = verifyInput("image-generation-v3", { model: "nanobana_2" });
    assert.equal(missingRes.valid, false);
    assert.equal(missingRes.workflowId, "image-generation-v3");
    assert.deepEqual(missingRes.missing, ["prompt"]);
    assert.equal(missingRes.errors.length, 1);
    assert.equal(missingRes.errors[0].code, "MISSING_REQUIRED_INPUT");
    assert.equal(missingRes.errors[0].field, "prompt");

    // 3. Unknown workflow ID (never throws)
    const unknownRes = verifyInput("non-existent-workflow-xyz", { prompt: "hello" });
    assert.equal(unknownRes.valid, false);
    assert.equal(unknownRes.workflowId, "non-existent-workflow-xyz");
    assert.deepEqual(unknownRes.missing, []);
    assert.equal(unknownRes.errors.length, 1);
    assert.equal(unknownRes.errors[0].code, "USE_CASE_NOT_FOUND");

    // 4. Invalid DAG (no OUTPUT_NODE / cycle)
    const invalidDagRes = verifyInput(
      {
        id: "broken-dag-wf",
        requiredInputs: ["topic"],
        nodes: [
          {
            id: "step_a",
            type: "base.text_template",
            inputs: { template: "Hello {{topic}}" },
          },
        ],
      },
      { topic: "world" }
    );
    assert.equal(invalidDagRes.valid, false);
    assert.equal(invalidDagRes.workflowId, "broken-dag-wf");
    assert.deepEqual(invalidDagRes.missing, []);
    assert.equal(invalidDagRes.errors.length, 1);
    assert.equal(invalidDagRes.errors[0].code, "COMPILATION_ERROR");
    assert.match(invalidDagRes.errors[0].message, /no OUTPUT_NODE/i);
  });

  it("calculateCost() estimates credits purely without side effects and fails closed on invalid pricing", () => {
    // 1. Billable built-in workflow (`image-generation-v3`)
    const imgCost = calculateCost("image-generation-v3", {
      prompt: "Neon skyline",
      model: "nanobana_2",
    });
    assert.equal(typeof imgCost.totalCredits, "number");
    assert.ok(imgCost.totalCredits > 0, "billable image-generation-v3 must report positive totalCredits");
    assert.equal(imgCost.breakdown.length, 4);
    assert.equal(
      imgCost.breakdown.reduce((sum, item) => sum + item.credits, 0),
      imgCost.totalCredits
    );
    const genEntry = imgCost.breakdown.find((b) => b.nodeId === "generate_image");
    assert.ok(genEntry && genEntry.nodeType === "base.image_generate" && genEntry.credits > 0);

    // 2. Fail-closed on unknown model / bad pricing (never swallows to 0)
    assert.throws(
      () =>
        calculateCost("image-generation-v3", {
          prompt: "Neon skyline",
          model: "nonexistent_unknown_model_xyz",
        }),
      (err) => Boolean(err)
    );

    // 3. Generic 0-cost non-billable workflow + mock billable node
    const registry = new NodeRegistry();
    registry.register({
      type: "custom.echo_out",
      OUTPUT_NODE: true,
      INPUT_TYPES: { required: { text: { type: "STRING" } } },
      RETURN_TYPES: { result: "STRING" },
      async execute(inputs) {
        return { result: inputs.text };
      },
    });
    registry.register({
      type: "custom.metered_step",
      OUTPUT_NODE: false,
      INPUT_TYPES: {
        required: { units: { type: "INT", default: 1 } },
      },
      RETURN_TYPES: { text: "STRING" },
      estimateCost(planned) {
        if (planned.units < 0) throw new Error("Negative units invalid");
        return planned.units * 5;
      },
      async execute(inputs) {
        return { text: `units:${inputs.units}` };
      },
    });

    const customEngine = new ExecutionEngine({ registry });
    const freeWorkflow = {
      id: "free-generic-wf",
      nodes: [
        { id: "out", type: "custom.echo_out", inputs: { text: { fromInput: "msg", default: "hi" } } },
      ],
    };
    const freeCost = customEngine.calculateCost(freeWorkflow, { msg: "hello" });
    assert.equal(freeCost.totalCredits, 0);
    assert.deepEqual(freeCost.breakdown, [{ nodeId: "out", nodeType: "custom.echo_out", credits: 0 }]);

    const meteredWorkflow = {
      id: "metered-generic-wf",
      nodes: [
        { id: "meter", type: "custom.metered_step", inputs: { units: { fromInput: "units", default: 2 } } },
        { id: "out", type: "custom.echo_out", inputs: { text: { fromNode: "meter", output: "text" } } },
      ],
    };
    const meteredCost = customEngine.calculateCost(meteredWorkflow, { units: 3 });
    assert.equal(meteredCost.totalCredits, 15);
    assert.deepEqual(meteredCost.breakdown, [
      { nodeId: "meter", nodeType: "custom.metered_step", credits: 15 },
      { nodeId: "out", nodeType: "custom.echo_out", credits: 0 },
    ]);

    assert.throws(
      () => customEngine.calculateCost(meteredWorkflow, { units: -1 }),
      /Negative units invalid/
    );
  });

  it("runWorkflow() executes DAG immediately in-process on generic non-media workflows with lifecycle hooks", async () => {
    const { TextTemplateNode } = await import(
      "../../../src/systems/workflow-engine/internal/nodes/base/textTemplateNode.js"
    );
    const { ExtractNode } = await import(
      "../../../src/systems/workflow-engine/internal/nodes/base/extractNode.js"
    );

    const registry = new NodeRegistry();
    registry.register(TextTemplateNode);
    registry.register({
      ...ExtractNode,
      type: "custom.terminal_extract",
      OUTPUT_NODE: true,
    });
    registry.register({
      type: "custom.failing_terminal",
      OUTPUT_NODE: true,
      INPUT_TYPES: { required: { text: { type: "STRING" } } },
      RETURN_TYPES: { ok: "BOOLEAN" },
      async execute() {
        const err = new Error("Generic terminal failure");
        err.code = "GENERIC_NODE_FAILURE";
        throw err;
      },
    });

    const genericWorkflow = {
      id: "generic-template-extract-wf",
      requiredInputs: ["greeting", "payload"],
      nodes: [
        {
          id: "render",
          type: "base.text_template",
          inputs: {
            template: "{{greeting}}, {{name}}!",
            variables: { fromInput: "vars", default: {} },
            defaults: { greeting: { fromInput: "greeting" } },
          },
        },
        {
          id: "extract",
          type: "custom.terminal_extract",
          inputs: {
            data: { fromInput: "payload" },
            path: "summary.headline",
            default_value: { fromNode: "render", output: "text" },
          },
        },
      ],
    };

    const hookEvents = [];
    const engine = new ExecutionEngine({
      registry,
      onSuccess: (evt) => hookEvents.push(`success:${evt.workflowId}:${evt.runId}`),
      onFailure: (evt) => hookEvents.push(`failure:${evt.stage}:${evt.workflowId}:${evt.errorCode}`),
    });

    // 1. Always runs DAG in-process, returns terminalOutputs & nodeOutputs, fires onSuccess
    const syncRes = await engine.runWorkflow(
      genericWorkflow,
      {
        greeting: "Hello",
        vars: { greeting: "Hello", name: "Ada" },
        payload: { summary: { headline: "" } },
      },
      { runId: "run-generic-sync-1" }
    );
    assert.equal(syncRes.status, "completed");
    assert.equal(syncRes.workflowId, "generic-template-extract-wf");
    assert.equal(syncRes.runId, "run-generic-sync-1");
    assert.equal(syncRes.nodeOutputs.render.text, "Hello, Ada!");
    assert.deepEqual(syncRes.terminalOutputs.extract, {
      value: "Hello, Ada!",
      text: "Hello, Ada!",
    });
    assert.equal(syncRes.state.status, "completed");
    assert.deepEqual(hookEvents, ["success:generic-template-extract-wf:run-generic-sync-1"]);

    // 2. Fires onFailure when a node throws
    const failingWorkflow = {
      id: "generic-fail-wf",
      nodes: [
        {
          id: "boom",
          type: "custom.failing_terminal",
          inputs: { text: "trigger" },
        },
      ],
    };
    await assert.rejects(
      () => engine.runWorkflow(failingWorkflow, {}, { runId: "run-generic-fail-1" }),
      /Generic terminal failure/
    );
    assert.ok(hookEvents.includes("failure:execute:generic-fail-wf:GENERIC_NODE_FAILURE"));
  });
});
