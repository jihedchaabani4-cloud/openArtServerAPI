import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  ExecutionEngine,
  GenerationService,
  GenerationRequestService,
} from "#generation/tools";
import {
  WorkflowExecutor,
  GraphCompiler,
  NodeRegistry,
  LlmNode,
  ImageGenerateNode,
  VideoGenerateNode,
  SaveMediaNode,
  createDefaultV3NodeRegistry,
  imageGenerationV3,
  videoGenerationV3,
} from "../../../src/systems/generation/internal/v3/index.js";
import {
  ERROR_CODES,
  parseProviderError,
  sanitizeClientError,
} from "../../../src/systems/generation/internal/errors.js";
import { db } from "../../../src/container.js";
import { redisConnection, workerRedisConnection, baseLogger, LogEvents } from "#shared";
import { calculateCost, ProviderTransientError } from "#models/tools";
import {
  registerProviderRunner,
  unregisterProviderRunner,
  getRunner,
} from "../../../src/systems/models/internal/runtime/providerRuntimeRegistry.js";
import { getModelBindings } from "../../../src/systems/models/internal/registry/modelRegistry.js";
import { randomUUID } from "node:crypto";
import * as imageController from "#generation/api";
import { failWorkflowPendingMedia } from "#media/tools";

after(async () => {
  try {
    await redisConnection?.quit().catch(() => redisConnection?.disconnect());
    await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
  } catch {}
});

// ─── Source: workflowRunContextAndFailureBoundary.test.js ───
{
describe("F2 — Server-Side Workflow Context & Failure Handling Boundary Tests (V3)", () => {
  let originalMediaFindByWorkflow;
  let originalMediaUpdateMedia;
  let originalMediaUpdateFields;
  let updatedMediaCalls = [];

  beforeEach(() => {
    updatedMediaCalls = [];
    originalMediaFindByWorkflow = db.media?.findByWorkflow;
    originalMediaUpdateMedia = db.media?.updateMedia;
    originalMediaUpdateFields = db.media?.updateFields;
  });

  afterEach(() => {
    if (db.media) {
      db.media.findByWorkflow = originalMediaFindByWorkflow;
      db.media.updateMedia = originalMediaUpdateMedia;
      db.media.updateFields = originalMediaUpdateFields;
    }
  });

  it("TEST 1: WorkflowExecutor writes ONLY to supplied media_id", async () => {
    db.media.updateMedia = async (id, patch) => {
      updatedMediaCalls.push({ id, patch });
      return { id, ...patch };
    };

    const registry = createDefaultV3NodeRegistry();
    const executor = new WorkflowExecutor(registry);

    const workflow = {
      id: "wf-server-owned",
      nodes: [
        {
          id: "save",
          type: "base.save_media",
          inputs: {
            media_id: { fromInput: "media_id" },
            asset_url: "https://storage.example.com/clean.png",
          },
        },
      ],
    };

    await executor.execute({
      workflow,
      input: {
        media_id: "media-server-1",
      },
      context: { db },
    });

    assert.strictEqual(updatedMediaCalls.length, 1, "Exactly one media update must be executed");
    assert.strictEqual(updatedMediaCalls[0].id, "media-server-1");
    assert.strictEqual(updatedMediaCalls[0].patch.status, "success");

    // If media_id is missing, SaveMediaNode refuses to write
    await assert.rejects(
      async () => {
        await SaveMediaNode.execute({ asset_url: "https://storage.example.com/clean.png" }, { db });
      },
      /media_id is required/i
    );
  });

  it("TEST 2: SaveMediaNode requires explicit media_id and asset_url", async () => {
    await assert.rejects(
      async () => {
        await SaveMediaNode.execute(
          {
            asset_url: "https://cdn.example.com/char.png",
          },
          { db }
        );
      },
      /media_id is required/i
    );

    await assert.rejects(
      async () => {
        await SaveMediaNode.execute(
          {
            media_id: "media-1",
          },
          { db }
        );
      },
      /asset_url is required/i
    );
  });

  it("TEST 3: ExecutionEngine throws unless execution result status === 'completed'", async () => {
    const engine = new ExecutionEngine({
      billingTools: {
        settleCredits: async () => ({ settled: true }),
        rollbackCredits: async () => ({ rolledBack: true }),
      },
      mediaTools: {
        markMediaFailed: async () => {},
      },
    });

    engine.executor = {
      execute: async () => ({
        status: "pending",
      }),
    };

    await assert.rejects(
      async () => {
        await engine.execute({
          useCaseId: "image-generation-v1",
          input: { prompt: "Test prompt", media_id: "m-1" },
          userId: "user-test-f2b",
        });
      },
      (err) => {
        assert.strictEqual(err.code, "WORKFLOW_INCOMPLETE");
        return true;
      }
    );
  });

  it("TEST 4: ExecutionEngine onFailure hook forwards server targets cleanly without touching spoofed inputs", async () => {
    const realCharWorkflowId = "char-wf-real-555";
    const spoofedInputWfId = "victim-wf-spoofed-888";

    const failedMediaIds = [];

    const engine = new ExecutionEngine({
      onFailure: async ({ input }) => {
        const ids = Array.isArray(input?.serverMediaIds) ? input.serverMediaIds : [];
        failedMediaIds.push(...ids);
      },
    });

    const failingWorkflow = {
      id: "character-sheet-v3",
      nodes: [
        {
          id: "fail_node",
          type: "base.save_media",
          inputs: {
            media_id: "m-char-1",
            // Missing required asset_url fails compilation
          },
        },
      ],
    };

    await assert.rejects(async () => {
      await engine.execute({
        workflow: failingWorkflow,
        input: {
          workflow_id: spoofedInputWfId,
          serverWorkflowId: realCharWorkflowId,
          serverMediaIds: [`media-${realCharWorkflowId}`],
        },
        userId: "user-char-owner-1",
      });
    });

    assert.deepStrictEqual(
      failedMediaIds,
      [`media-${realCharWorkflowId}`],
      "Failure handler must notify ONLY the real character workflow media, never the spoofed input workflow ID"
    );
  });
});
}

// ─── Source: nodeAssetNormalizationBoundary.test.js ───
{
process.env.NODE_ENV = "test";

function makeCtx() {
  return { runId: `run-b5-${randomUUID()}`, nodeId: `gen_node_${randomUUID()}`, userId: "user-b5-test" };
}

let mediaRows;

function setupDb() {
  mediaRows = new Map();
  db.media = {
    createMedia: async (data) => {
      const row = { ...data, status: data.status || "processing" };
      mediaRows.set(data.id, row);
      return row;
    },
    findById: async (id) => mediaRows.get(id) || null,
    findByWorkflow: async (workflowId) =>
      Array.from(mediaRows.values()).filter((m) => m.workflow_id === workflowId),
    updateMedia: async (id, data) => {
      const existing = mediaRows.get(id) || { id };
      const updated = { ...existing, ...data };
      mediaRows.set(id, updated);
      return updated;
    },
  };
}

function seedPlaceholder(workflowId, id, status = "processing") {
  mediaRows.set(id, { id, workflow_id: workflowId, step_id: "image_generation", status });
}

describe("F2.4-b5 — Real ModelRunner & OutputMap Pipeline Boundary Tests (V3 Nodes)", () => {
  beforeEach(() => {
    setupDb();
  });

  afterEach(() => {
    unregisterProviderRunner("wavespeed");
    unregisterProviderRunner("google");
    unregisterProviderRunner("ltx");
  });

  it("TEST 1: wan_3_0 on wavespeed through VideoGenerateNode → single video_url, no duplicates", async () => {
    const videoUrl = "https://wavespeed.example.com/wan30/output.mp4";
    registerProviderRunner("wavespeed", async () => ({ outputs: [videoUrl] }));

    const result = await VideoGenerateNode.execute(
      { model: "wan_3_0", prompt: "A cinematic flying drone shot", parameters: { duration: 5 } },
      makeCtx()
    );

    assert.strictEqual(result.status, "success");
    assert.strictEqual(result.assets.length, 1);
    assert.strictEqual(result.video_url, videoUrl);
    assert.strictEqual(result.metadata.model, "wan_3_0");
    assert.strictEqual(result.metadata.provider, "wavespeed");
  });

  it("TEST 2: seedance_2_5 on wavespeed through VideoGenerateNode → single video_url", async () => {
    const videoUrl = "https://wavespeed.example.com/seedance25/output.mp4";
    registerProviderRunner("wavespeed", async () => ({ outputs: [videoUrl] }));

    const result = await VideoGenerateNode.execute(
      { model: "seedance_2_5", prompt: "A dancer spinning", parameters: { duration: 5 } },
      makeCtx()
    );

    assert.strictEqual(result.status, "success");
    assert.strictEqual(result.assets.length, 1);
    assert.strictEqual(result.video_url, videoUrl);
    assert.strictEqual(result.metadata.model, "seedance_2_5");
    assert.strictEqual(result.metadata.provider, "wavespeed");
  });

  it("TEST 3: ltx_2_3_fast on ltx through VideoGenerateNode → single video_url", async () => {
    const videoUrl = "https://api.ltx.io/generated/video_123.mp4";
    registerProviderRunner("ltx", async () => ({ status: "completed", result: { video_url: videoUrl } }));

    const result = await VideoGenerateNode.execute(
      { model: "ltx_2_3_fast", prompt: "Time lapse of stars", parameters: { duration: 6, resolution: "720p" } },
      makeCtx()
    );

    assert.strictEqual(result.status, "success");
    assert.strictEqual(result.assets.length, 1);
    assert.strictEqual(result.video_url, videoUrl);
    assert.strictEqual(result.metadata.model, "ltx_2_3_fast");
    assert.strictEqual(result.metadata.provider, "ltx");
  });

  it("TEST 4: nanobana_2 on wavespeed through ImageGenerateNode → exactly 1 asset, no duplicates", async () => {
    const imgUrl = "https://wavespeed.example.com/nanobana2/render.png";
    registerProviderRunner("wavespeed", async () => ({ outputs: [imgUrl] }));

    const result = await ImageGenerateNode.execute(
      { model: "nanobana_2", prompt: "Sunset over Tokyo" },
      makeCtx()
    );

    assert.strictEqual(result.assets.length, 1);
    assert.strictEqual(result.image_url, imgUrl);
    assert.strictEqual(result.metadata.model, "nanobana_2");
    assert.strictEqual(result.metadata.provider, "wavespeed");
  });

  it("TEST 5: gpt_image_2 on wavespeed through ImageGenerateNode → exactly 1 asset, no duplicates", async () => {
    const imgUrl = "https://wavespeed.example.com/gptimage2/render.png";
    registerProviderRunner("wavespeed", async () => ({ outputs: [imgUrl] }));

    const result = await ImageGenerateNode.execute(
      { model: "gpt_image_2", prompt: "Futuristic city street" },
      makeCtx()
    );

    assert.strictEqual(result.assets.length, 1);
    assert.strictEqual(result.image_url, imgUrl);
    assert.strictEqual(result.metadata.model, "gpt_image_2");
    assert.strictEqual(result.metadata.provider, "wavespeed");
  });

  it("TEST 6: nanobana_pro on google through ImageGenerateNode → exactly 1 asset, no duplicates", async () => {
    const imgUrl = "https://storage.googleapis.com/nanobana_pro/generated.png";
    registerProviderRunner("google", async () => ({
      predictions: [{ uri: imgUrl }],
      images: [imgUrl],
      outputs: [imgUrl],
      raw: { generatedImages: [{ imageUri: imgUrl }] },
    }));

    const bindings = getModelBindings("nanobana_pro");
    const googleBinding = bindings.find((b) => b.providerId === "google");
    const wavespeedBinding = bindings.find((b) => b.providerId === "wavespeed");
    const origGoogleStatus = googleBinding.status;
    const origWavespeedStatus = wavespeedBinding.status;

    try {
      googleBinding.status = "active";
      wavespeedBinding.status = "standby";

      const result = await ImageGenerateNode.execute(
        { model: "nanobana_pro", prompt: "Studio portrait of a cat" },
        makeCtx()
      );

      assert.strictEqual(result.assets.length, 1);
      assert.strictEqual(result.image_url, imgUrl);
      assert.strictEqual(result.metadata.model, "nanobana_pro");
      assert.strictEqual(result.metadata.provider, "google");
    } finally {
      googleBinding.status = origGoogleStatus;
      wavespeedBinding.status = origWavespeedStatus;
    }
  });

  it("TEST 7: Surplus assets in ImageGenerateNode → uses first asset for image_url and SaveMediaNode completes placeholder", async () => {
    const workflowId = "wf-b5-surplus";
    const ph1 = "ph-b5-surplus-1";
    seedPlaceholder(workflowId, ph1);

    const imgRes = await ImageGenerateNode.execute(
      { model: "nanobana_2", prompt: "Surplus test" },
      {
        ...makeCtx(),
        executeProvider: async () => ({
          assets: [
            { url: "https://storage.example.com/asset-1-USED.png" },
            { url: "https://storage.example.com/asset-2-DROPPED.png" },
          ],
          metadata: { model: "nanobana_2", provider: "wavespeed" },
        }),
      }
    );

    assert.strictEqual(imgRes.image_url, "https://storage.example.com/asset-1-USED.png");

    await SaveMediaNode.execute(
      {
        media_id: ph1,
        asset_url: imgRes.image_url,
        metadata: imgRes.metadata,
      },
      { db }
    );

    const finalPlaceholder = mediaRows.get(ph1);
    assert.strictEqual(finalPlaceholder.status, "success");
    assert.strictEqual(finalPlaceholder.url, "https://storage.example.com/asset-1-USED.png");
  });

  it("TEST 8: Shortage (0 assets returned) in ImageGenerateNode fails closed", async () => {
    await assert.rejects(
      () =>
        ImageGenerateNode.execute(
          { model: "nanobana_2", prompt: "Shortage test" },
          {
            ...makeCtx(),
            executeProvider: async () => ({ assets: [] }),
          }
        ),
      /Provider returned no image URL/i
    );
  });

  it("TEST 9: in a non-test NODE_ENV (e.g. production), registerProviderRunner throws and real runner is used", async () => {
    const origEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      assert.throws(
        () => registerProviderRunner("wavespeed", async () => ({ outputs: [] })),
        /only allowed when NODE_ENV === "test"/
      );
      assert.throws(
        () => unregisterProviderRunner("wavespeed"),
        /only allowed when NODE_ENV === "test"/
      );
    } finally {
      process.env.NODE_ENV = origEnv;
    }

    unregisterProviderRunner("wavespeed");
    const runner = await getRunner("wavespeed");
    assert.strictEqual(typeof runner, "function");
    assert.notStrictEqual(runner.name, "mockRunner");
  });
});
}

// ─── Source: multiAssetOutputsBoundary.test.js ───
{
describe("Multi-Asset Outputs & Count Boundary (F2.4-b / V3)", () => {
  let mediaRows;

  beforeEach(() => {
    mediaRows = new Map();
    db.media = {
      createMedia: async (data) => {
        const row = { ...data, status: data.status || "processing" };
        mediaRows.set(data.id, row);
        return row;
      },
      findById: async (id) => mediaRows.get(id) || null,
      findByWorkflow: async (workflowId) => {
        return Array.from(mediaRows.values()).filter((m) => m.workflow_id === workflowId);
      },
      updateMedia: async (id, data) => {
        const existing = mediaRows.get(id) || { id };
        const updated = { ...existing, ...data };
        mediaRows.set(id, updated);
        return updated;
      },
    };
  });

  it("TEST 1: calculateCost rejects unsupported count parameter with UNSUPPORTED_CAPABILITY", () => {
    assert.throws(
      () => calculateCost("nanobana_2", { prompt: "test prompt", resolution: "1k", count: 4 }),
      (err) => {
        assert.strictEqual(err.code, "UNSUPPORTED_CAPABILITY");
        assert.match(err.message, /does not support parameter "count"/i);
        return true;
      }
    );
  });

  it("TEST 2: calculateRetailCredits does NOT multiply by count", async () => {
    const { calculateRetailCredits } = await import("../../../src/systems/models/internal/pricing/pricingEngine.js");
    const model = { retailPricing: { table: { "1k": 8, default: 8 } } };
    const cost1 = calculateRetailCredits(model, { resolution: "1k", count: 1 });
    const cost4 = calculateRetailCredits(model, { resolution: "1k", count: 4 });
    assert.strictEqual(cost1, 8);
    assert.strictEqual(cost4, 8, "Retail credits must not multiply by count");
  });

  it("TEST 3: GraphCompiler compiles V3 image workflow into active nodes and parallel waves", () => {
    const compiler = new GraphCompiler(createDefaultV3NodeRegistry());
    const plan = compiler.compile(imageGenerationV3);

    assert.ok(Array.isArray(plan.activeNodeIds) && plan.activeNodeIds.length === 4);
    assert.ok(Array.isArray(plan.waves) && plan.waves.length >= 4);
  });

  it("TEST 4: imageController clamps output count to 1 and pre-allocates exactly 1 placeholder even if count=4 is requested", async () => {
    const { executionEngine } = await import("../../../src/container.js");
    const origLaunch = executionEngine.launch;
    let preparedArgs = null;
    executionEngine.launch = async (args) => {
      preparedArgs = args;
      return { executionId: "exec-multi-test", cost: { totalCredits: 8 } };
    };

    try {
      db.workflows = {
        createWorkflow: async (data) => data,
      };
      db.projects = {
        findById: async (id) => ({ id, user_id: "user-multi-test" }),
      };

      let responseJson = null;
      const req = {
        user: { id: "user-multi-test" },
        body: {
          prompt: "A beautiful mountain",
          model: "nanobana_2",
          project_id: "proj-multi-test",
          count: 4,
          parameters: { count: 4 },
        },
      };
      const res = {
        status: () => res,
        json: (data) => {
          responseJson = data;
          return data;
        },
      };

      await imageController.generateImage(req, res);

      assert.ok(responseJson, "Response JSON must be returned");
      assert.strictEqual(responseJson.ok, true);
      assert.strictEqual(responseJson.mediaIds.length, 1, "Exactly 1 placeholder returned in mediaIds");
      assert.strictEqual(preparedArgs.input.serverMediaIds.length, 1, "serverMediaIds must contain exactly 1 id");
      assert.strictEqual(preparedArgs.serverContext.mediaIds.length, 1, "serverContext.mediaIds must contain exactly 1 id");
      assert.strictEqual(mediaRows.size, 1, "Exactly 1 media placeholder created in db.media");
    } finally {
      executionEngine.launch = origLaunch;
    }
  });
});
}

// ─── Source: providerErrorSemanticsPreservationBoundary.test.js ───
{
describe("D2.5 — Provider Error Semantics & Upstream Fault Mapping Boundary Tests", () => {
  it("TEST 1: GenerationUpstreamError maps 503 provider error to UPSTREAM_FAULT and retryable: true", () => {
    const providerErr = new ProviderTransientError("Provider is currently unavailable.");
    providerErr.code = "PROVIDER_UNAVAILABLE";
    providerErr.statusCode = 503;
    providerErr.retryable = true;

    const parsed = parseProviderError(providerErr, "wavespeed");
    assert.equal(parsed.code, ERROR_CODES.API_SUBMIT_FAILED);
    assert.equal(parsed.statusCode, 500);
  });

  it("TEST 2: ERROR_CODES defines canonical generation error codes", () => {
    assert.ok(ERROR_CODES.GENERATION_FAILED);
    assert.ok(ERROR_CODES.PROMPT_VIOLATION);
  });

  it("TEST 3: normalizeError preserves terminal: true and retryable: false for polling terminal failures", async () => {
    const { normalizeError } = await import("../../../src/systems/models/internal/execution/errorNormalizer.js");
    const terminalErr = new Error("LTX job failed: Service unavailable on worker");
    terminalErr.terminal = true;
    terminalErr.retryable = false;
    terminalErr.code = "PROVIDER_JOB_FAILED";

    const normalized = normalizeError(terminalErr);

    assert.equal(normalized.terminal, true, "Expected normalized.terminal to be true");
    assert.equal(normalized.retryable, false, "Expected normalized.retryable to be false (must NOT retry dead job)");
    assert.equal(normalized.code, "PROVIDER_JOB_FAILED");
  });

  it("TEST 4: RuntimeExecutor does NOT retry when an error is marked terminal", async () => {
    const { RuntimeExecutor } = await import("../../../src/systems/models/internal/execution/runtimeExecutor.js");
    const executor = new RuntimeExecutor();

    let attempts = 0;
    const terminalErr = new Error("LTX job failed terminally");
    terminalErr.terminal = true;
    terminalErr.retryable = false;
    terminalErr.code = "PROVIDER_JOB_FAILED";

    const binding = { id: "test-binding", streaming: false };
    const provider = { id: "test-provider" };

    await assert.rejects(
      async () => {
        await executor.execute({
          provider,
          binding,
          providerPayload: {},
          credential: "mock-key",
          modelId: "test-model",
          bindingId: "test-binding",
          options: {
            maxRetries: 3,
            providerExecutor: async () => {
              attempts++;
              throw terminalErr;
            },
          },
        });
      },
      (err) => {
        assert.equal(err.message, "LTX job failed terminally");
        return true;
      }
    );

    assert.equal(
      attempts,
      1,
      `Expected exactly 1 attempt without duplicate re-submissions, got ${attempts}`
    );
  });
  it("TEST 5 (P1-2): WorkflowExecutor fails fast on CIRCUIT_BREAKER_OPEN on attempt 1 with 0 retries and 0 sleep", async () => {
    const registry = new NodeRegistry();
    let attempts = 0;
    const sleeps = [];

    registry.register({
      type: "custom.cb_node",
      OUTPUT_NODE: true,
      CACHEABLE: false,
      INPUT_TYPES: { required: { prompt: { type: "STRING" } } },
      RETURN_TYPES: { url: "STRING" },
      estimateCost: () => 0,
      async execute() {
        attempts++;
        const err = new Error("Circuit breaker OPEN for ltx:ltx_2_3_fast");
        err.code = "CIRCUIT_BREAKER_OPEN";
        err.category = "UPSTREAM_FAULT";
        err.statusCode = 503;
        // Even if retryable were left true/undefined, NON_RETRYABLE_CODES must fail fast
        err.retryable = true;
        throw err;
      },
    });

    const executor = new WorkflowExecutor(registry, {
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    await assert.rejects(
      () =>
        executor.execute({
          workflow: {
            id: "wf-cb-fastfail",
            nodes: [{ id: "step1", type: "custom.cb_node", inputs: { prompt: "test" } }],
          },
          input: {},
        }),
      (err) => {
        assert.strictEqual(err.code, "CIRCUIT_BREAKER_OPEN");
        return true;
      }
    );

    assert.strictEqual(attempts, 1, "CIRCUIT_BREAKER_OPEN must fail fast on attempt 1 with 0 retries");
    assert.deepStrictEqual(sleeps, [], "CIRCUIT_BREAKER_OPEN must incur 0 sleep calls");
  });

  it("TEST 6 (P1-3): PROVIDER_QUOTA_EXCEEDED maps to 503 maintenance message (NOT 429 / currently busy) in mediaNodeHelpers and sanitizeClientError", async () => {
    let caughtNodeErr;
    try {
      await VideoGenerateNode.execute(
        { model: "ltx_2_3_fast", prompt: "Ocean waves at sunrise" },
        {
          userId: "user-p1-3",
          executeGeneration: async () => {
            const err = new Error("Insufficient funds. Required: 18 cents");
            err.code = "PROVIDER_QUOTA_EXCEEDED";
            err.statusCode = 503;
            err.retryable = false;
            throw err;
          },
        }
      );
    } catch (e) {
      caughtNodeErr = e;
    }

    assert.ok(caughtNodeErr, "VideoGenerateNode must throw on PROVIDER_QUOTA_EXCEEDED");
    assert.strictEqual(caughtNodeErr.code, "PROVIDER_QUOTA_EXCEEDED");
    assert.strictEqual(caughtNodeErr.category, "UPSTREAM_FAULT");
    assert.strictEqual(caughtNodeErr.statusCode, 503);
    assert.strictEqual(caughtNodeErr.retryable, false);

    const sanitizedFromNode = sanitizeClientError(caughtNodeErr);
    assert.strictEqual(sanitizedFromNode.code, "PROVIDER_QUOTA_EXCEEDED");
    assert.strictEqual(sanitizedFromNode.category, "UPSTREAM_FAULT");
    assert.strictEqual(sanitizedFromNode.statusCode, 503);
    assert.strictEqual(sanitizedFromNode.retryable, false);
    assert.match(sanitizedFromNode.userMessage, /maintenance/i);
    assert.ok(!/currently busy/i.test(sanitizedFromNode.userMessage));

    // Also verify sanitizeClientError directly when raw error carries status 429 or RATE_LIMIT
    const rawQuotaErr = new Error("Insufficient funds");
    rawQuotaErr.code = "PROVIDER_QUOTA_EXCEEDED";
    rawQuotaErr.statusCode = 429;
    const sanitizedRaw = sanitizeClientError(rawQuotaErr);
    assert.strictEqual(sanitizedRaw.statusCode, 503);
    assert.strictEqual(sanitizedRaw.category, "UPSTREAM_FAULT");
    assert.strictEqual(sanitizedRaw.retryable, false);
    assert.match(sanitizedRaw.userMessage, /maintenance/i);
    assert.ok(!/currently busy/i.test(sanitizedRaw.userMessage));
  });

  it("TEST 7 (P2-3): invokeModelGeneration resolves single model via getModelSchema without cold 5-model catalog cost fan-out", async () => {
    const costEvents = [];
    const origDebug = baseLogger.debug;
    const origInfo = baseLogger.info;
    baseLogger.debug = (payload, msg) => {
      if (payload?.event === LogEvents.MODELS_COST_CALCULATED) {
        costEvents.push(payload);
      }
      return origDebug.call(baseLogger, payload, msg);
    };
    baseLogger.info = (payload, msg) => {
      if (payload?.event === LogEvents.MODELS_COST_CALCULATED) {
        costEvents.push(payload);
      }
      return origInfo.call(baseLogger, payload, msg);
    };

    try {
      registerProviderRunner("ltx", async () => ({
        status: "completed",
        result: { video_url: "https://api.ltx.io/generated/single_lookup.mp4" },
      }));

      const result = await VideoGenerateNode.execute(
        { model: "ltx_2_3_fast", prompt: "Single model lookup test", parameters: { duration: 6, resolution: "720p" } },
        { runId: `run-p23-${randomUUID()}`, nodeId: "generate_video", userId: "user-p23" }
      );

      assert.strictEqual(result.status, "success");
      assert.strictEqual(result.video_url, "https://api.ltx.io/generated/single_lookup.mp4");
      assert.strictEqual(
        costEvents.length,
        0,
        `Expected 0 catalog cost fan-out calculations during invokeModelGeneration, got ${costEvents.length}`
      );
    } finally {
      unregisterProviderRunner("ltx");
      baseLogger.debug = origDebug;
      baseLogger.info = origInfo;
    }
  });

  it("TEST 8 (P2-3): videoGenerationV3 llm_process configures timeout_ms: 15000 and LlmNode forwards timeoutMs to executeLLM", async () => {
    const llmStep = videoGenerationV3.nodes.find((n) => n.id === "llm_process");
    assert.ok(llmStep, "videoGenerationV3 must define llm_process node");
    assert.strictEqual(llmStep.type, "base.llm");
    assert.strictEqual(llmStep.inputs.timeout_ms, 15000, "llm_process must enforce timeout_ms: 15000");

    let capturedWithTimeout = null;
    await LlmNode.execute(
      {
        prompt: "A drone sweeping across red canyons",
        skills: ["system-safety", "translate"],
        timeout_ms: 15000,
      },
      {
        userId: "user-timeout-test",
        executeLLM: async (args) => {
          capturedWithTimeout = args;
          return {
            json: { is_safe: true, prompt: "A drone sweeping across red canyons" },
            model: "gemini-3.1-flash-lite",
            durationMs: 12,
          };
        },
      }
    );
    assert.strictEqual(capturedWithTimeout.timeoutMs, 15000, "LlmNode must forward timeout_ms as timeoutMs");

    let capturedWithoutTimeout = null;
    await LlmNode.execute(
      {
        prompt: "No explicit timeout",
        skills: ["system-safety"],
      },
      {
        userId: "user-timeout-test",
        executeLLM: async (args) => {
          capturedWithoutTimeout = args;
          return {
            json: { is_safe: true, prompt: "No explicit timeout" },
            model: "gemini-3.1-flash-lite",
            durationMs: 10,
          };
        },
      }
    );
    assert.strictEqual("timeoutMs" in capturedWithoutTimeout, false, "LlmNode should omit timeoutMs when timeout_ms is unset");

    // End-to-end through WorkflowExecutor on videoGenerationV3 to verify timeout_ms resolves & forwards
    let capturedExecutorLlmArgs = null;
    const executor = new WorkflowExecutor(createDefaultV3NodeRegistry());
    await executor.execute({
      workflow: videoGenerationV3,
      input: {
        prompt: "End-to-end timeout check",
        model: "ltx_2_3_fast",
        media_id: "media-timeout-e2e",
      },
      context: {
        userId: "user-timeout-e2e",
        executeLLM: async (args) => {
          capturedExecutorLlmArgs = args;
          return {
            json: { is_safe: true, prompt: "End-to-end timeout check" },
            model: "gemini-3.1-flash-lite",
            durationMs: 8,
          };
        },
        executeProvider: async () => ({
          url: "https://mock.example.com/timeout-e2e.mp4",
          metadata: { model: "ltx_2_3_fast", provider: "ltx" },
        }),
        db: {
          media: {
            findById: async () => ({ id: "media-timeout-e2e", status: "processing" }),
            updateMedia: async (id, patch) => ({ id, ...patch }),
          },
        },
      },
    });
    assert.strictEqual(
      capturedExecutorLlmArgs?.timeoutMs,
      15000,
      "WorkflowExecutor must resolve videoGenerationV3 llm_process.inputs.timeout_ms and forward timeoutMs: 15000"
    );
  });
});
}

// ─── Source: mediaGenerationConfigLifecycleBoundary.test.js ───
{
describe("Per-Media Generation Config Lifecycle & Boundary Tests (Hardened)", () => {
  it("TEST 1: Validated configuration is persisted before execution begins", async () => {
    let mediaCreatedWithConfig = null;

    const mockDb = {
      workflows: {
        createWorkflow: async (wf) => wf,
      },
      media: {
        createMedia: async (mediaRow) => {
          mediaCreatedWithConfig = { ...mediaRow };
          return mediaRow;
        },
        updateMedia: async () => {},
      },
      workflowMedia: {
        linkMedia: async () => {},
      },
    };

    const mockExecutionEngine = {
      launch: async (args) => ({
        jobId: "job-123",
        executionId: args.executionId,
        cost: { totalCredits: 10 },
      }),
    };

    const mockFolderService = {
      validateAndAssertUsable: async (folderId) => folderId,
    };

    const service = new GenerationRequestService({
      db: mockDb,
      executionEngine: mockExecutionEngine,
      folderService: mockFolderService,
    });

    const result = await service.requestGeneration({
      userId: "user-test-1",
      mediaType: "image",
      stepId: "image_generation",
      useCaseId: "image-generation-v1",
      prompt: "A majestic red panda in the bamboo forest",
      model: "nanobana_pro",
      projectId: "proj-100",
      folderId: null,
      references: [],
      parameters: {
        aspect_ratio: "16:9",
        resolution: "2k",
      },
      mediaMeta: { width: 1920, height: 1080, aspect_ratio: "16:9" },
      outputCount: 1,
    });

    assert.equal(result.ok, true);
    assert.ok(mediaCreatedWithConfig, "Media must be created");
    assert.equal(mediaCreatedWithConfig.status, "processing", "Media must be created in processing status");
    assert.ok(mediaCreatedWithConfig.generation_config, "generation_config must be persisted on placeholder creation before queue dispatch");

    const cfg = mediaCreatedWithConfig.generation_config;
    assert.equal(cfg.prompt, "A majestic red panda in the bamboo forest");
    assert.equal(cfg.model, "nanobana_pro");
    assert.equal(cfg.aspect_ratio, "16:9");
    assert.equal(cfg.parameters.resolution, "2k", "Caller-supplied resolution must be preserved");
    assert.equal(cfg.parameters.output_format, "png", "Model defaults must be applied");
  });

  it("TEST 2: The configuration remains retrievable after prompt translation/enrichment fails", async () => {
    const placeholderMedia = {
      id: "media-fail-trans",
      workflow_id: "wf-fail-trans",
      workflowId: "wf-fail-trans",
      role: "output",
      is_primary: true,
      isPrimary: true,
      step_id: "image_generation",
      url: null,
      status: "processing",
      width: 1024,
      height: 1024,
      generation_config: {
        prompt: "قطوس يلعب بالكرة",
        model: "nanobana_pro",
        aspect_ratio: "1:1",
        parameters: { seed: 99 },
        created_at: new Date().toISOString(),
      },
    };

    const mediaStore = new Map([[placeholderMedia.id, placeholderMedia]]);

    const mockDb = {
      projects: { findByUser: async () => [{ id: "proj-1" }] },
      media: {
        findByWorkflow: async (wfId) => Array.from(mediaStore.values()).filter((m) => m.workflow_id === wfId),
        updateMedia: async (id, patch) => {
          const item = mediaStore.get(id);
          const updated = { ...item, ...patch };
          mediaStore.set(id, updated);
          return updated;
        },
      },
      workflows: {
        findByProjectsPaginated: async () => ({
          workflows: [
            {
              id: "wf-fail-trans",
              project_id: "proj-1",
              display_name: "قطوس يلعب بالكرة",
              primary_media_id: "media-fail-trans",
              workflow_type: "GENERATION",
              create_time: "2026-10-21T12:00:00Z",
            },
          ],
          total: 1,
        }),
      },
      workflowMedia: {
        findByWorkflowIds: async () => Array.from(mediaStore.values()),
      },
    };

    await failWorkflowPendingMedia(mockDb, "wf-fail-trans", "LLM translation rate limited");

    const mediaRow = mediaStore.get("media-fail-trans");
    assert.equal(mediaRow.status, "failed");
    assert.equal(mediaRow.error_message, "LLM translation rate limited");
    assert.ok(mediaRow.generation_config, "generation_config must not be erased on failure");
    assert.equal(mediaRow.generation_config.prompt, "قطوس يلعب بالكرة");

    const generationService = new GenerationService({ db: mockDb });
    const library = await generationService.getUserLibrary("user-1", { projectId: "proj-1" });
    const item = library.data[0];

    assert.equal(item.primary_media.status, "failed");
    assert.ok(item.generation_info, "Failed workflow must still expose generation_info for retry");
    assert.equal(item.generation_info.prompt, "قطوس يلعب بالكرة");
    assert.equal(item.generation_info.model, "nanobana_pro");
    assert.equal(item.generation_info.seed, 99);
  });

  it("TEST 3: The configuration remains retrievable after provider failure or timeout", async () => {
    const placeholderMedia = {
      id: "media-fail-provider",
      workflow_id: "wf-fail-provider",
      workflowId: "wf-fail-provider",
      role: "output",
      is_primary: true,
      isPrimary: true,
      step_id: "video_generation",
      url: null,
      status: "processing",
      width: 1920,
      height: 1080,
      generation_config: {
        prompt: "A drone flying through mist",
        model: "seedance_2_5",
        aspect_ratio: "16:9",
        parameters: { duration: 5, resolution: "720p" },
        created_at: new Date().toISOString(),
      },
    };

    const mediaStore = new Map([[placeholderMedia.id, placeholderMedia]]);

    const mockDb = {
      projects: { findByUser: async () => [{ id: "proj-1" }] },
      media: {
        findByWorkflow: async (wfId) => Array.from(mediaStore.values()).filter((m) => m.workflow_id === wfId),
        updateMedia: async (id, patch) => {
          const item = mediaStore.get(id);
          const updated = { ...item, ...patch };
          mediaStore.set(id, updated);
          return updated;
        },
      },
      workflows: {
        findByProjectsPaginated: async () => ({
          workflows: [
            {
              id: "wf-fail-provider",
              project_id: "proj-1",
              display_name: "A drone flying through mist",
              primary_media_id: "media-fail-provider",
              workflow_type: "GENERATION",
              create_time: "2026-10-21T12:00:00Z",
            },
          ],
          total: 1,
        }),
      },
      workflowMedia: {
        findByWorkflowIds: async () => Array.from(mediaStore.values()),
      },
    };

    await failWorkflowPendingMedia(mockDb, "wf-fail-provider", "Provider Gateway Timeout (504)");

    const mediaRow = mediaStore.get("media-fail-provider");
    assert.equal(mediaRow.status, "failed");
    assert.equal(mediaRow.error_message, "Provider Gateway Timeout (504)");
    assert.ok(mediaRow.generation_config);

    const generationService = new GenerationService({ db: mockDb });
    const library = await generationService.getUserLibrary("user-1", { projectId: "proj-1" });
    const item = library.data[0];

    assert.ok(item.generation_info, "generation_info must be retrievable after provider failure");
    assert.equal(item.generation_info.prompt, "A drone flying through mist");
    assert.equal(item.generation_info.model, "seedance_2_5");
    assert.equal(item.generation_info.parameters.duration, 5);
  });

  it("TEST 4: Successful generation associates the correct configuration with its media via SaveMediaNode", async () => {
    let updatedMedia = null;

    const initialConfig = {
      prompt: "orig prompt",
      model: "nanobana_pro",
      aspect_ratio: "16:9",
      parameters: { seed: 101, resolution: "1k" },
      created_at: "2026-10-21T12:00:00.000Z",
    };

    const mockDb = {
      media: {
        findById: async () => ({
          id: "ph-success-1",
          workflow_id: "wf-success-1",
          status: "processing",
          width: 1024,
          height: 1024,
          generation_config: initialConfig,
        }),
        updateMedia: async (id, fields) => {
          updatedMedia = { id, ...fields };
          return updatedMedia;
        },
      },
    };

    await SaveMediaNode.execute(
      {
        media_id: "ph-success-1",
        asset_url: "https://storage.cdn/success-asset.png",
        final_prompt: "orig prompt, highly detailed, photorealistic 8k render",
        metadata: {
          model: "nanobana_pro",
          provider: "wavespeed",
          width: 1920,
          height: 1080,
        },
      },
      { db: mockDb }
    );

    assert.equal(updatedMedia.status, "success");
    assert.equal(updatedMedia.url, "https://storage.cdn/success-asset.png");
    assert.ok(updatedMedia.generation_config);

    const cfg = updatedMedia.generation_config;
    assert.equal(cfg.prompt, "orig prompt", "Original user prompt must be preserved");
    assert.equal(cfg.prompt_optimized, "orig prompt, highly detailed, photorealistic 8k render", "Effective prompt stored when different");
    assert.equal(cfg.model, "nanobana_pro");
    assert.equal(cfg.provider, "wavespeed", "Provider must be merged from runtime output");
    assert.equal(cfg.created_at, "2026-10-21T12:00:00.000Z", "Initial creation timestamp preserved");
  });

  it("TEST 5: Existing media configuration is not overwritten by subsequent generations or edits", async () => {
    const existingMedia1 = {
      id: "media-gen-1",
      workflow_id: "wf-multi",
      status: "completed",
      url: "https://cdn.example.com/item1.png",
      generation_config: {
        prompt: "First generation prompt",
        model: "nanobana_pro",
        parameters: { resolution: "1k", output_format: "png" },
      },
    };

    let media2Created = null;

    const mockDb = {
      workflows: { createWorkflow: async (wf) => wf },
      media: {
        createMedia: async (m) => {
          media2Created = { ...m };
          return m;
        },
        updateMedia: async () => {},
      },
      workflowMedia: { linkMedia: async () => {} },
    };

    const mockExecutionEngine = {
      launch: async (args) => ({
        jobId: "job-edit-2",
        executionId: args.executionId,
      }),
    };

    const service = new GenerationRequestService({
      db: mockDb,
      executionEngine: mockExecutionEngine,
      folderService: { validateAndAssertUsable: async () => null },
    });

    await service.requestGeneration({
      userId: "user-1",
      mediaType: "image",
      stepId: "image_generation",
      useCaseId: "image-generation-v1",
      prompt: "Second generation prompt (edited)",
      model: "nanobana_pro",
      projectId: "proj-1",
      parameters: { resolution: "4k", input_image: "wf-multi" },
    });

    assert.equal(existingMedia1.generation_config.prompt, "First generation prompt");
    assert.equal(existingMedia1.generation_config.parameters.resolution, "1k");

    assert.notEqual(media2Created.id, existingMedia1.id);
    assert.equal(media2Created.generation_config.prompt, "Second generation prompt (edited)");
    assert.equal(media2Created.generation_config.parameters.resolution, "4k");
  });

  it("TEST 6: Invalid parameters do not create valid-looking persisted configurations", async () => {
    let workflowCreated = false;
    let mediaCreated = false;

    const mockDb = {
      workflows: {
        createWorkflow: async () => {
          workflowCreated = true;
        },
      },
      media: {
        createMedia: async () => {
          mediaCreated = true;
        },
      },
      workflowMedia: { linkMedia: async () => {} },
    };

    const mockExecutionEngine = {
      launch: async () => ({ jobId: "job-should-not-run" }),
    };

    const service = new GenerationRequestService({
      db: mockDb,
      executionEngine: mockExecutionEngine,
      folderService: { validateAndAssertUsable: async () => null },
    });

    await assert.rejects(
      async () => {
        await service.requestGeneration({
          userId: "user-1",
          mediaType: "image",
          stepId: "image_generation",
          useCaseId: "image-generation-v1",
          prompt: "A cat",
          model: "nanobana_pro",
          projectId: "proj-1",
          parameters: { aspect_ratio: "invalid_ratio" },
        });
      },
      (err) => {
        assert.equal(err.statusCode, 400);
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await service.requestGeneration({
          userId: "user-1",
          mediaType: "image",
          stepId: "image_generation",
          useCaseId: "image-generation-v1",
          prompt: "A cat",
          model: "nanobana_pro",
          projectId: "proj-1",
          parameters: { unmapped_bogus_key: 123 },
        });
      },
      (err) => {
        assert.equal(err.statusCode, 400);
        return true;
      }
    );

    assert.equal(workflowCreated, false, "Workflow must not be created on validation failure");
    assert.equal(mediaCreated, false, "Media must not be created on validation failure");
  });

  it("TEST 7: Retry and duplicate-execution behavior is deterministic and idempotent via SaveMediaNode", async () => {
    let updateCount = 0;
    let savedConfig = null;

    const initialConfig = {
      prompt: "idempotency test prompt",
      model: "nanobana_pro",
      aspect_ratio: "1:1",
      parameters: { seed: 555 },
      created_at: "2026-10-21T10:00:00.000Z",
    };

    const mockDb = {
      media: {
        findById: async () => ({
          id: "ph-idempotent-1",
          workflow_id: "wf-idempotent-1",
          status: "processing",
          width: 1024,
          height: 1024,
          generation_config: initialConfig,
        }),
        updateMedia: async (id, fields) => {
          updateCount++;
          savedConfig = fields.generation_config;
          return { id, ...fields };
        },
      },
    };

    const inputs = {
      media_id: "ph-idempotent-1",
      asset_url: "https://storage.cdn/idempotent.png",
      final_prompt: "idempotency test prompt",
      metadata: { model: "nanobana_pro", provider: "wavespeed", width: 1024, height: 1024 },
    };

    await SaveMediaNode.execute(inputs, { db: mockDb });
    assert.equal(updateCount, 1);
    assert.equal(savedConfig.prompt, "idempotency test prompt");
    assert.ok(!("prompt_optimized" in savedConfig), "Unchanged prompt must omit prompt_optimized key entirely");
    assert.equal(savedConfig.provider, "wavespeed");
    assert.equal(savedConfig.created_at, "2026-10-21T10:00:00.000Z");

    await SaveMediaNode.execute(inputs, { db: mockDb });
    assert.equal(updateCount, 2);
    assert.equal(savedConfig.prompt, "idempotency test prompt");
    assert.equal(savedConfig.provider, "wavespeed");
    assert.equal(savedConfig.created_at, "2026-10-21T10:00:00.000Z");
  });

  it("TEST 8: Upload-only media does not acquire generation configuration", async () => {
    const uploadedMedia = {
      id: "media-uploaded-1",
      project_id: "proj-1",
      step_id: "upload",
      url: "https://cdn.example.com/user-upload.png",
      width: 1024,
      height: 1024,
      status: "completed",
      generation_config: null,
    };

    const mockDb = {
      projects: { findByUser: async () => [{ id: "proj-1" }] },
      workflows: {
        findByProjectsPaginated: async () => ({
          workflows: [
            {
              id: "wf-upload",
              project_id: "proj-1",
              display_name: "User Uploaded Image",
              primary_media_id: "media-uploaded-1",
              workflow_type: "UPLOAD",
              create_time: "2026-10-21T12:00:00Z",
            },
          ],
          total: 1,
        }),
      },
      workflowMedia: {
        findByWorkflowIds: async () => [
          {
            ...uploadedMedia,
            workflow_id: "wf-upload",
            workflowId: "wf-upload",
            role: "output",
            is_primary: true,
            isPrimary: true,
          },
        ],
      },
    };

    const generationService = new GenerationService({ db: mockDb });
    const library = await generationService.getUserLibrary("user-1", { projectId: "proj-1" });
    const item = library.data[0];

    assert.equal(item.primary_media.generation_config, null, "Uploaded media generation_config must remain null");
    assert.equal(item.generation_info, null, "Uploaded media must not have generation_info synthesized");
  });

  it("TEST 9: Secrets and signed URLs are excluded from persisted configuration", async () => {
    let persistedConfig = null;

    const mockDb = {
      workflows: { createWorkflow: async (wf) => wf },
      media: {
        createMedia: async (m) => {
          persistedConfig = m.generation_config;
          return m;
        },
        updateMedia: async () => {},
      },
      workflowMedia: { linkMedia: async () => {} },
    };

    const service = new GenerationRequestService({
      db: mockDb,
      executionEngine: { launch: async () => ({ jobId: "job-secret" }) },
      folderService: { validateAndAssertUsable: async () => null },
    });

    await service.requestGeneration({
      userId: "user-1",
      mediaType: "video",
      stepId: "video_generation",
      useCaseId: "video-generation-v1",
      prompt: "A secret garden",
      model: "wan_3_0",
      projectId: "proj-1",
      references: ["wf-ref-safe-id"],
      parameters: {
        seed: 777,
        api_key: "sk-should-be-stripped", // gate:allow-secret
        access_token: "token-should-be-stripped", // gate:allow-secret
        auth_bearer: "bearer-should-be-stripped",
        user_password: "pw-should-be-stripped", // gate:allow-secret
      },
    });

    assert.ok(persistedConfig);
    assert.equal(persistedConfig.parameters.seed, 777, "seed must be preserved");
    assert.equal(persistedConfig.parameters.api_key, undefined, "api_key must be stripped");
    assert.equal(persistedConfig.parameters.access_token, undefined, "access_token must be stripped");
    assert.equal(persistedConfig.parameters.auth_bearer, undefined, "auth_bearer must be stripped");
    assert.equal(persistedConfig.parameters.user_password, undefined, "user_password must be stripped");
  });

  it("TEST 10: Existing configuration retrieval continues to work without introducing per-tile or per-entity network requests", async () => {
    let findByWorkflowIdsCalled = 0;
    let findByIdsWithReferencesCalled = 0;

    const mockDb = {
      projects: { findByUser: async () => [{ id: "proj-1" }] },
      workflows: {
        findByProjectsPaginated: async () => ({
          workflows: [
            {
              id: "wf-tile-1",
              project_id: "proj-1",
              display_name: "Workflow 1",
              primary_media_id: "m-1",
              workflow_type: "GENERATION",
              create_time: "2026-10-21T01:00:00Z",
            },
            {
              id: "wf-tile-2",
              project_id: "proj-1",
              display_name: "Workflow 2",
              primary_media_id: "m-2",
              workflow_type: "GENERATION",
              create_time: "2026-10-21T02:00:00Z",
            },
          ],
          total: 2,
        }),
      },
      workflowMedia: {
        findByWorkflowIds: async () => {
          findByWorkflowIdsCalled++;
          return [
            {
              id: "m-1",
              workflow_id: "wf-tile-1",
              workflowId: "wf-tile-1",
              role: "output",
              is_primary: true,
              isPrimary: true,
              status: "completed",
              url: "https://cdn.example.com/1.png",
              generation_config: { prompt: "Prompt 1", model: "nanobana_pro" },
            },
            {
              id: "m-2",
              workflow_id: "wf-tile-2",
              workflowId: "wf-tile-2",
              role: "output",
              is_primary: true,
              isPrimary: true,
              status: "completed",
              url: "https://cdn.example.com/2.png",
              generation_config: { prompt: "Prompt 2", model: "seedance_2_5" },
            },
          ];
        },
      },
      configs: {
        findByIdsWithReferences: async () => {
          findByIdsWithReferencesCalled++;
          return [];
        },
      },
    };

    const generationService = new GenerationService({ db: mockDb });
    const library = await generationService.getUserLibrary("user-1", { projectId: "proj-1" });

    assert.equal(findByWorkflowIdsCalled, 1, "Exactly 1 batched query for all workflow media");
    assert.equal(findByIdsWithReferencesCalled, 0, "Zero legacy config table calls when inline config exists");
    assert.equal(library.data.length, 2);
    assert.equal(library.data[0].generation_info.prompt, "Prompt 1");
    assert.equal(library.data[1].generation_info.prompt, "Prompt 2");
  });
});
}

after(() => {
  setTimeout(() => process.exit(0), 100);
});
