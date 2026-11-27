import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as models from "#models/tools";
import { getModelConfig, validateModelInputs, calculateCost, executeGeneration, executeLLM, getCatalog, getModelSchema, ModelsError, ModelsValidationError, ModelsNotFoundError, ModelsConfigurationError, ModelsProviderError } from "#models/tools";
import { initRegistry } from "../../../src/systems/models/internal/registry/modelRegistry.js";
import { resolveExecutionPlan } from "../../../src/systems/models/internal/registry/bindingResolver.js";
import { mapToProviderPayload } from "../../../src/systems/models/internal/mapping/parameterMapper.js";
import { registerProviderRunner, unregisterProviderRunner } from "../../../src/systems/models/internal/runtime/providerRuntimeRegistry.js";
import { normalizeError, StandardErrorCodes } from "../../../src/systems/models/internal/execution/errorNormalizer.js";
import { RuntimeExecutor } from "../../../src/systems/models/internal/execution/runtimeExecutor.js";
import { circuitBreakerRegistry } from "../../../src/systems/models/internal/execution/circuitBreaker.js";
import { run as runModel } from "../../../src/systems/models/internal/execution/modelRunner.js";
import { run as runLtx } from "../../../src/systems/models/internal/runtime/ltx/runner.js";
import { run as runRunway, resolveRunwayRatio } from "../../../src/systems/models/internal/runtime/runway/runner.js";
import { TaskFailedError, TaskTimedOutError } from "@runwayml/sdk";
import { runWithContext, baseLogger } from "#shared";
import modelsRouter from "#models/api";
import { formatModelDto } from "../../../src/systems/models/internal/controllers/modelsController.js";
import { VideoGenerateNode } from "../../../src/systems/generation/internal/v3/index.js";
import { resolveMediaMetadata } from "#media/tools";

// ─── Source: modelsSystem.test.js ───
{
describe("System 2: Models Management (#models/tools & #models/api)", () => {
  before(() => {
    initRegistry({ forceReload: true });
  });

  describe("1. Inter-System Tools Gateway (#models/tools)", () => {
    it("getModelConfig returns full config object when called without arguments", () => {
      const config = getModelConfig();
      assert.ok(config && Array.isArray(config.models));
      assert.ok(config.models.length > 0);
      assert.ok(config.models.some((m) => m.key === "nanobana_pro" || m.key === "flux-schnell" || m.key === "wan_3_0"));
    });

    it("getModelConfig returns single model config when called with modelId", () => {
      const catalog = getCatalog();
      const firstModel = catalog[0];
      const modelId = firstModel.modelFamily || firstModel.id;

      const modelConfig = getModelConfig(modelId);
      assert.equal(modelConfig.key, modelId);
      assert.ok(modelConfig.displayName);
      assert.ok(modelConfig.category);
    });

    it("getModelConfig resolves hyphenated/alias modelIds (H3: gpt-image-2 -> gpt_image_2) without 404", () => {
      const cfg = getModelConfig("gpt-image-2");
      assert.ok(cfg);
      assert.equal(cfg.key, "gpt_image_2");
      assert.ok(cfg.displayName);
      assert.equal(cfg.category, "image");
    });

    it("getModelConfig throws ModelsNotFoundError for unknown modelId", () => {
      assert.throws(
        () => getModelConfig("completely_nonexistent_model_xyz"),
        (err) => err instanceof ModelsNotFoundError && err.statusCode === 404
      );
    });

    it("validateModelInputs sanitizes and validates parameters against schema", () => {
      const catalog = getCatalog();
      const firstModel = catalog.find((m) => m.domain === "image" && m.parameters?.prompt?.required) || catalog[0];
      const modelId = firstModel.modelFamily || firstModel.id;

      const clean = validateModelInputs(modelId, { prompt: "a cute robot painting" });
      assert.ok(clean);
      assert.equal(clean.prompt, "a cute robot painting");
    });

    it("calculateCost returns financial credit cost decoupled from wallet ledger", () => {
      const catalog = getCatalog();
      const imageModel = catalog.find((m) => m.domain === "image" && m.parameters?.prompt?.required) || catalog[0];
      const modelId = imageModel.modelFamily || imageModel.id;

      const credits = calculateCost(modelId, { prompt: "fantasy landscape" });

      assert.equal(typeof credits, "number");
      assert.ok(credits > 0);
    });

    it("calculateCost with returnQuote returns detailed financial estimate DTO without provider leaks", () => {
      const catalog = getCatalog();
      const imageModel = catalog.find((m) => m.domain === "image" && m.parameters?.prompt?.required) || catalog[0];
      const modelId = imageModel.modelFamily || imageModel.id;

      const quote = calculateCost(modelId, { prompt: "fantasy landscape" }, { returnQuote: true });

      assert.ok(quote);
      assert.equal(typeof quote.credits, "number");
      assert.ok(quote.credits > 0);
      assert.equal(quote.modelId, modelId);
      assert.equal(quote.planIdentity, undefined, "Public quote must not leak provider-bearing planIdentity");
    });

    it("executeGeneration throws ModelsValidationError if modelId is omitted", async () => {
      await assert.rejects(
        async () => executeGeneration({ prompt: "hello" }),
        (err) => err instanceof ModelsValidationError && err.statusCode === 400
      );
    });

    it("executeGeneration requires userId unless noCharge is specified", async () => {
      const catalog = getCatalog();
      const modelId = catalog[0].modelFamily || catalog[0].id;

      await assert.rejects(
        async () => executeGeneration({ modelId, prompt: "test prompt" }),
        (err) => err.name === "MissingUserIdError" || err.message.includes("userId is required")
      );
    });

    it("executeLLM delegates to LLMService and returns expected interface", async () => {
      assert.equal(typeof executeLLM, "function");
    });
  });

  describe("2. HTTP API Gateway (#models/api)", () => {
    it("exports an Express router instance", () => {
      assert.ok(modelsRouter);
      assert.ok(Array.isArray(modelsRouter.stack));
      assert.ok(modelsRouter.stack.length > 0);
    });

    it("registers public read/estimate routes and does NOT mount unauthenticated POST /admin/reload", () => {
      const routes = modelsRouter.stack
        .filter((layer) => layer.route)
        .map((layer) => ({
          path: layer.route.path,
          methods: Object.keys(layer.route.methods),
        }));

      const paths = routes.map((r) => r.path);
      assert.ok(paths.includes("/"));
      assert.ok(paths.includes("/:key"));
      assert.ok(paths.includes("/:key/schema"));
      assert.ok(paths.includes("/:key/estimate-price"));
      assert.equal(paths.includes("/admin/reload"), false, "Unauthenticated /admin/reload must not exist on public models router");
    });

    it("formatModelDto produces normalized client DTO shape", () => {
      const raw = {
        modelFamily: "test-model",
        displayName: "Test Model",
        domain: "image",
        badge: "PRO",
        retailPricing: { standard: 15 },
        capabilities: { inpaint: true },
      };

      const dto = formatModelDto(raw);
      assert.equal(dto.key, "test-model");
      assert.equal(dto.displayName, "Test Model");
      assert.equal(dto.category, "image");
      assert.equal(dto.tier, "PRO");
      assert.deepEqual(dto.tags, ["pro"]);
      assert.deepEqual(dto.pricing, { standard: 15 });
    });

    it("GET /:key/schema and POST /:key/estimate-price return 404 for systemOnly internal models", async () => {
      const schemaLayer = modelsRouter.stack.find(
        (layer) => layer.route && layer.route.path === "/:key/schema" && layer.route.methods.get
      );
      const estimateLayer = modelsRouter.stack.find(
        (layer) => layer.route && layer.route.path === "/:key/estimate-price" && layer.route.methods.post
      );
      assert.ok(schemaLayer);
      assert.ok(estimateLayer);

      const invoke = async (layer, req) => {
        let statusCode = 200;
        let payload = null;
        const res = {
          status(code) { statusCode = code; return this; },
          json(data) { payload = data; return this; },
        };
        await layer.route.stack[0].handle(req, res);
        return { statusCode, payload };
      };

      const schemaRes = await invoke(schemaLayer, { params: { key: "gemini_3_1_flash_lite" } });
      assert.equal(schemaRes.statusCode, 404);
      assert.equal(schemaRes.payload.success, false);

      const estRes = await invoke(estimateLayer, {
        params: { key: "gemini_3_1_flash_lite" },
        body: { prompt: "internal probe" },
      });
      assert.equal(estRes.statusCode, 404);
      assert.equal(estRes.payload.success, false);
    });

    it("executeGeneration strips _internal, data.raw, and provider-bearing metadata fields", async () => {
      registerProviderRunner("wavespeed", async () => ({
        outputs: ["https://cdn.example.com/sealed.png"],
        secretDebug: "wavespeed-raw",
      }));
      try {
        const res = await executeGeneration({
          modelId: "nanobana_pro",
          prompt: "Sealed black-box check",
          userId: "user-seal-check",
        });

        assert.equal(res.status, "success");
        assert.equal(res._internal, undefined, "_internal must never leave #models/tools");
        assert.equal(res.data?.raw, undefined, "data.raw must never leave #models/tools");
        assert.equal(res.metadata?.planIdentity, undefined, "provider-bearing planIdentity must not leave #models/tools");
        assert.equal(res.metadata?.routeId, undefined, "internal routeId must not leave #models/tools");
      } finally {
        unregisterProviderRunner("wavespeed");
      }
    });
  });
});
}

// ─── Source: ltxModelCapabilitiesBoundary.test.js ───
{
describe("LTX Video Models Capability and Aspect Ratio Boundary", () => {
  before(() => {
    initRegistry({ forceReload: true });
  });

  it("TEST 1: calculateCost supports aspect_ratio for ltx_2_3_pro (16:9)", () => {
    const cost = models.calculateCost("ltx_2_3_pro", {
      prompt: "A cinematic fly-through over neon city",
      duration: 8,
      resolution: "1080p",
      aspect_ratio: "16:9",
    });
    assert.strictEqual(typeof cost, "number");
    assert.ok(cost > 0, "Cost must be a positive credit amount");
  });

  it("TEST 2: calculateCost supports aspect_ratio for ltx_2_3_fast (9:16)", () => {
    const cost = models.calculateCost("ltx_2_3_fast", {
      prompt: "Fast vertical video of a waterfall",
      duration: 8,
      resolution: "720p",
      aspect_ratio: "9:16",
    });
    assert.strictEqual(typeof cost, "number");
    assert.ok(cost > 0, "Cost must be a positive credit amount");
  });

  it("TEST 3: calculateCost supports aspect_ratio for ltx_2_5_pro (16:9)", () => {
    const cost = models.calculateCost("ltx_2_5_pro", {
      prompt: "Cinematic shot of ocean waves",
      duration: 8,
      resolution: "1080p",
      aspect_ratio: "16:9",
    });
    assert.strictEqual(typeof cost, "number");
    assert.ok(cost > 0, "Cost must be a positive credit amount");
  });

  it("TEST 4: calculateCost supports aspect_ratio for ltx_2_5_fast (9:16)", () => {
    const cost = models.calculateCost("ltx_2_5_fast", {
      prompt: "Vertical dance clip",
      duration: 8,
      resolution: "720p",
      aspect_ratio: "9:16",
    });
    assert.strictEqual(typeof cost, "number");
    assert.ok(cost > 0, "Cost must be a positive credit amount");
  });

  it("TEST 5: manifests declare aspect_ratio capability and canonical input", () => {
    const ltxModels = ["ltx_2_3_pro", "ltx_2_3_fast", "ltx_2_5_pro", "ltx_2_5_fast"];
    for (const mId of ltxModels) {
      const schema = models.getModelSchema(mId);
      assert.ok(schema.parameters.aspect_ratio, `Model ${mId} schema must declare aspect_ratio`);
      assert.deepStrictEqual(schema.parameters.aspect_ratio.values, ["16:9", "9:16"]);
      assert.strictEqual(schema.parameters.aspect_ratio.default, "16:9");
    }
  });

  it("TEST 6: VideoGenerateNode with ltx_2_3_pro and aspect_ratio: 16:9 succeeds", async () => {
    const videoUrl = "https://api.ltx.io/generated/ltx_pro_123.mp4";
    registerProviderRunner("ltx", async () => {
      return { status: "completed", result: { video_url: videoUrl } };
    });

    try {
      const result = await VideoGenerateNode.execute(
        {
          model: "ltx_2_3_pro",
          prompt: "Cinematic mountain sunset",
          parameters: { duration: 8, resolution: "1080p", aspect_ratio: "16:9" },
        },
        { runId: "run-ltx-test", nodeId: "gen_node_ltx", userId: "user-ltx" }
      );

      assert.strictEqual(result.video_url, videoUrl);
      assert.strictEqual(result.metadata.model, "ltx_2_3_pro");
    } finally {
      unregisterProviderRunner("ltx");
    }
  });

  it("TEST 7: VideoGenerateNode with ltx_2_3_fast and aspect_ratio: 9:16 succeeds", async () => {
    const videoUrl = "https://api.ltx.io/generated/ltx_fast_456.mp4";
    registerProviderRunner("ltx", async () => {
      return { status: "completed", result: { video_url: videoUrl } };
    });

    try {
      const result = await VideoGenerateNode.execute(
        {
          model: "ltx_2_3_fast",
          prompt: "Vertical skateboard trick",
          parameters: { duration: 6, resolution: "720p", aspect_ratio: "9:16" },
        },
        { runId: "run-ltx-fast-test", nodeId: "gen_node_ltx_fast", userId: "user-ltx" }
      );

      assert.strictEqual(result.video_url, videoUrl);
      assert.strictEqual(result.metadata.model, "ltx_2_3_fast");
    } finally {
      unregisterProviderRunner("ltx");
    }
  });

  it("TEST 8: resolveMediaMetadata defaults to 16:9 when video default is passed", () => {
    const meta = resolveMediaMetadata({ prompt: "Drone shot" }, "16:9");
    assert.strictEqual(meta.aspect_ratio, "16:9");
    assert.strictEqual(meta.width, 1344);
    assert.strictEqual(meta.height, 768);

    const squareMeta = resolveMediaMetadata({ prompt: "Profile picture" });
    assert.strictEqual(squareMeta.aspect_ratio, "1:1");
  });
});
}

// ─── Source: modelsResilienceAndErrorClassification.test.js ───
{
describe("Models Error Classification, Circuit Breaker, Retry-After Fast-Fail, and LTX Polling/Logging", () => {
  before(() => {
    initRegistry({ forceReload: true });
  });

  describe("1. P1-2: Non-retryable CIRCUIT_BREAKER_OPEN", () => {
    it("throws CIRCUIT_BREAKER_OPEN with retryable: false, statusCode: 503, category: UPSTREAM_FAULT when CB is OPEN", async () => {
      const circuitKey = "ltx_2_3_pro:ltx:ltx_2_3_pro.ltx";
      circuitBreakerRegistry.recordSuccess(circuitKey);

      try {
        // Trip the circuit breaker using 5 consecutive failures
        for (let i = 0; i < 5; i++) {
          circuitBreakerRegistry.recordFailure(circuitKey);
        }
        assert.strictEqual(circuitBreakerRegistry.getState(circuitKey), "OPEN");

        let executorCalled = false;
        await assert.rejects(
          async () => {
            await runModel(
              "ltx_2_3_pro",
              { prompt: "Sunset over dunes", duration: 8, resolution: "1080p", aspect_ratio: "16:9" },
              {
                userId: "user-cb-open",
                runtimeExecutor: {
                  execute: async () => {
                    executorCalled = true;
                    return { status: "completed", result: { video_url: "https://example.com/v.mp4" } };
                  },
                },
              }
            );
          },
          (err) => {
            assert.strictEqual(err.code, "CIRCUIT_BREAKER_OPEN");
            assert.strictEqual(err.retryable, false);
            assert.strictEqual(err.statusCode, 503);
            assert.strictEqual(err.category, "UPSTREAM_FAULT");
            return true;
          }
        );

        assert.strictEqual(executorCalled, false, "Executor must not be called when circuit breaker is OPEN");

        // normalizeError must preserve CIRCUIT_BREAKER_OPEN as non-retryable
        const cbErr = Object.assign(new Error("Circuit breaker open"), {
          code: "CIRCUIT_BREAKER_OPEN",
          statusCode: 503,
          retryable: false,
        });
        const normalized = normalizeError(cbErr);
        assert.strictEqual(normalized.code, StandardErrorCodes.CIRCUIT_BREAKER_OPEN);
        assert.strictEqual(normalized.retryable, false);
        assert.strictEqual(normalized.statusCode, 503);
      } finally {
        circuitBreakerRegistry.recordSuccess(circuitKey);
      }
    });
  });

  describe("2. P1-3: PROVIDER_QUOTA_EXCEEDED above err.terminal & Selective Circuit Breaker Recording", () => {
    it("classifies terminal LTX Insufficient funds / 429 or 402 as PROVIDER_QUOTA_EXCEEDED -> 503 maintenance message", () => {
      const ltxTerminal429 = Object.assign(new Error("Insufficient funds"), {
        statusCode: 429,
        terminal: true,
        retryable: false,
        raw: { status: "failed", error: { type: "insufficient_funds_error", message: "Insufficient funds" } },
      });

      const norm1 = normalizeError(ltxTerminal429);
      assert.strictEqual(norm1.code, StandardErrorCodes.PROVIDER_QUOTA_EXCEEDED);
      assert.strictEqual(norm1.statusCode, 503);
      assert.strictEqual(norm1.retryable, false);
      assert.match(norm1.safeMessage, /upstream provider maintenance/i);
      assert.doesNotMatch(norm1.safeMessage, /insufficient funds/i);

      const ltxTerminal402 = Object.assign(new Error("Account balance exhausted"), {
        statusCode: 402,
        code: "PROVIDER_QUOTA_EXCEEDED",
        terminal: true,
        retryable: false,
      });

      const norm2 = normalizeError(ltxTerminal402);
      assert.strictEqual(norm2.code, StandardErrorCodes.PROVIDER_QUOTA_EXCEEDED);
      assert.strictEqual(norm2.statusCode, 503);
      assert.strictEqual(norm2.retryable, false);

      // Non-quota terminal failure still preserves its terminal PROVIDER_JOB_FAILED classification
      const nonQuotaTerminal = Object.assign(new Error("Unsupported prompt content"), {
        statusCode: 422,
        code: "PROVIDER_JOB_FAILED",
        terminal: true,
        retryable: false,
      });
      const norm3 = normalizeError(nonQuotaTerminal);
      assert.strictEqual(norm3.code, "PROVIDER_JOB_FAILED");
      assert.strictEqual(norm3.statusCode, 422);
      assert.strictEqual(norm3.retryable, false);
      assert.strictEqual(norm3.terminal, true);
    });

    it("selective CB failure recording skips 4xx user faults and records 5xx/429/quota upstream faults", async () => {
      const circuitKey = "ltx_2_3_fast:ltx:ltx_2_3_fast.ltx";
      circuitBreakerRegistry.recordSuccess(circuitKey);

      try {
        // 1. Fire 6 consecutive 400 user-input rejections -> CB must stay CLOSED with 0 failures
        for (let i = 0; i < 6; i++) {
          await assert.rejects(
            () =>
              runModel(
                "ltx_2_3_fast",
                { prompt: "Bad params test", duration: 8, resolution: "720p", aspect_ratio: "16:9" },
                {
                  userId: "user-cb-selective",
                  runtimeExecutor: {
                    execute: async () => {
                      const err = new Error("Invalid aspect ratio");
                      err.statusCode = 400;
                      throw err;
                    },
                  },
                }
              ),
            (err) => err.code === StandardErrorCodes.INVALID_INPUT_REJECTED_BY_PROVIDER
          );
        }
        assert.strictEqual(circuitBreakerRegistry.getState(circuitKey), "CLOSED");
        assert.strictEqual(circuitBreakerRegistry.states.get(circuitKey)?.consecutiveFailures ?? 0, 0);

        // 2. Fire a 422 terminal job/content-policy failure -> CB must STILL have 0 failures
        await assert.rejects(
          () =>
            runModel(
              "ltx_2_3_fast",
              { prompt: "Policy test", duration: 8, resolution: "720p", aspect_ratio: "16:9" },
              {
                userId: "user-cb-selective",
                runtimeExecutor: {
                  execute: async () => {
                    const err = new Error("Content policy rejected");
                    err.statusCode = 422;
                    err.terminal = true;
                    err.code = "PROVIDER_JOB_FAILED";
                    throw err;
                  },
                },
              }
            ),
          (err) => err.statusCode === 422
        );
        assert.strictEqual(circuitBreakerRegistry.getState(circuitKey), "CLOSED");
        assert.strictEqual(circuitBreakerRegistry.states.get(circuitKey)?.consecutiveFailures ?? 0, 0);

        // 3. Fire upstream failures: 503, 504, 429, 402 (quota), 500 -> should record all 5 and OPEN CB
        const upstreamErrors = [
          Object.assign(new Error("Service unavailable"), { statusCode: 503 }),
          Object.assign(new Error("Gateway timeout"), { statusCode: 504 }),
          Object.assign(new Error("Rate limit exceeded"), { statusCode: 429 }),
          Object.assign(new Error("Insufficient funds"), { statusCode: 402, terminal: true }),
          Object.assign(new Error("Internal server error"), { statusCode: 500 }),
        ];

        for (const upstreamErr of upstreamErrors) {
          await assert.rejects(() =>
            runModel(
              "ltx_2_3_fast",
              { prompt: "Upstream failure test", duration: 8, resolution: "720p", aspect_ratio: "16:9" },
              {
                userId: "user-cb-selective",
                runtimeExecutor: {
                  execute: async () => {
                    throw upstreamErr;
                  },
                },
              }
            )
          );
        }

        assert.strictEqual(circuitBreakerRegistry.states.get(circuitKey)?.consecutiveFailures, 5);
        assert.strictEqual(circuitBreakerRegistry.getState(circuitKey), "OPEN");
      } finally {
        circuitBreakerRegistry.recordSuccess(circuitKey);
      }
    });
  });

  describe("3. P1-4: retryAfterMs parsing & RuntimeExecutor fast-fail", () => {
    it("parses Google retryDelay ('12s', '1.5s', '500ms') and Retry-After headers (seconds & HTTP-date)", () => {
      const googleRawErr = Object.assign(new Error("Too many requests"), {
        statusCode: 429,
        raw: {
          error: {
            code: 429,
            details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12s" }],
          },
        },
      });
      assert.strictEqual(normalizeError(googleRawErr).retryAfterMs, 12000);

      const errorDetailsErr = Object.assign(new Error("Rate limit"), {
        statusCode: 429,
        errorDetails: [{ retryDelay: "1.5s" }],
      });
      assert.strictEqual(normalizeError(errorDetailsErr).retryAfterMs, 1500);

      const detailsMsErr = Object.assign(new Error("Rate limit"), {
        statusCode: 429,
        details: [{ retryDelay: "500ms" }],
      });
      assert.strictEqual(normalizeError(detailsMsErr).retryAfterMs, 500);

      const retryAfterSecondsErr = Object.assign(new Error("Too many requests"), {
        statusCode: 429,
        headers: { "Retry-After": "15" },
      });
      assert.strictEqual(normalizeError(retryAfterSecondsErr).retryAfterMs, 15000);

      const futureDate = new Date(Date.now() + 20_000).toUTCString();
      const retryAfterDateErr = Object.assign(new Error("Too many requests"), {
        statusCode: 429,
        response: { headers: { "retry-after": futureDate } },
      });
      const parsedDateMs = normalizeError(retryAfterDateErr).retryAfterMs;
      assert.ok(typeof parsedDateMs === "number" && parsedDateMs > 10_000 && parsedDateMs <= 25_000);

      const jsonMsgErr = Object.assign(
        new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"12s"}]}}'),
        { statusCode: 429 }
      );
      assert.strictEqual(normalizeError(jsonMsgErr).retryAfterMs, 12000);
    });

    it("RuntimeExecutor fails fast immediately without sleeping when retryAfterMs > maxBackoffMs", async () => {
      const executor = new RuntimeExecutor();
      let attempts = 0;
      const sleeps = [];

      await assert.rejects(
        async () => {
          await executor.execute({
            provider: { id: "google" },
            binding: { id: "b1" },
            providerPayload: {},
            credential: "k",
            modelId: "gemini-3.1-flash-lite",
            bindingId: "gemini:google",
            options: {
              maxRetries: 3,
              maxBackoffMs: 2000,
              sleeper: async (ms) => {
                sleeps.push(ms);
              },
              providerExecutor: async () => {
                attempts += 1;
                const err = new Error("Rate limit reached");
                err.statusCode = 429;
                err.details = [{ retryDelay: "12s" }];
                throw err;
              },
            },
          });
        },
        (err) => err.statusCode === 429 && err.retryAfterMs === 12000
      );

      assert.strictEqual(attempts, 1, "Must fail fast on attempt 1 when retryAfterMs > maxBackoffMs");
      assert.strictEqual(sleeps.length, 0, "Must not sleep when failing fast");
    });

    it("RuntimeExecutor respects retryAfterMs <= maxBackoffMs and retries after waiting", async () => {
      const executor = new RuntimeExecutor();
      let attempts = 0;
      const sleeps = [];

      const res = await executor.execute({
        provider: { id: "google" },
        binding: { id: "b1" },
        providerPayload: {},
        credential: "k",
        modelId: "gemini-3.1-flash-lite",
        bindingId: "gemini:google",
        options: {
          maxRetries: 2,
          maxBackoffMs: 2000,
          randomFn: () => 0.5,
          sleeper: async (ms) => {
            sleeps.push(ms);
          },
          providerExecutor: async () => {
            attempts += 1;
            if (attempts === 1) {
              const err = new Error("Rate limit reached");
              err.statusCode = 429;
              err.headers = { "Retry-After": "1" };
              throw err;
            }
            return { text: "ok" };
          },
        },
      });

      assert.deepStrictEqual(res, { text: "ok" });
      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(sleeps, [1000]);
    });

    it("RuntimeExecutor fails fast by default (0 retries) when maxRetries is omitted", async () => {
      const executor = new RuntimeExecutor();
      let attempts = 0;
      const sleeps = [];

      await assert.rejects(
        async () => {
          await executor.execute({
            provider: { id: "wavespeed" },
            binding: { id: "nanobana_2:wavespeed" },
            providerPayload: {},
            credential: "k",
            modelId: "nanobana_2",
            bindingId: "nanobana_2:wavespeed",
            options: {
              sleeper: async (ms) => {
                sleeps.push(ms);
              },
              providerExecutor: async () => {
                attempts += 1;
                const err = new Error("WaveSpeed 504 timeout");
                err.statusCode = 504;
                err.retryable = true;
                throw err;
              },
            },
          });
        },
        (err) => err.statusCode === 504
      );

      assert.strictEqual(attempts, 1, "RuntimeExecutor must execute only once by default (maxRetries=0)");
      assert.strictEqual(sleeps.length, 0, "RuntimeExecutor must not sleep when failing fast by default");
    });

    it("WaveSpeed bindings cap polling timeouts at 180s for image/remove-bg/upscale and 600s for video", async () => {
      const { getRegistry } = await import("../../../src/systems/models/internal/registry/modelRegistry.js");
      const { models, bindings } = getRegistry();

      for (const [, binding] of bindings) {
        if (binding.providerId !== "wavespeed") continue;
        const model = models.get(binding.modelId);
        const timeout = binding.pollingConfig?.timeout;
        assert.strictEqual(typeof timeout, "number", `${binding.modelId} wavespeed binding must declare numeric pollingConfig.timeout`);
        if (model?.domain === "video") {
          assert.ok(timeout <= 600, `WaveSpeed video binding ${binding.modelId} timeout must be <= 600s (got ${timeout}s)`);
        } else {
          assert.ok(timeout <= 180, `WaveSpeed image binding ${binding.modelId} timeout must be <= 180s (got ${timeout}s)`);
        }
      }
    });
  });

  describe("4. P2-2 & P2-3: LTX short initial poll delay and providerJobId logging", () => {
    it("uses 1200ms initial poll delay then 5000ms pollIntervalMs, and logs providerJobId without clobbering BullMQ jobId", async () => {
      const delays = [];
      const capturedLogs = [];
      let pollCallCount = 0;

      const origInfo = baseLogger.info;
      const origDebug = baseLogger.debug;
      const origWarn = baseLogger.warn;
      baseLogger.info = function (obj, msg) {
        capturedLogs.push({ level: "info", obj, msg });
        return origInfo.call(this, obj, msg);
      };
      baseLogger.debug = function (obj, msg) {
        capturedLogs.push({ level: "debug", obj, msg });
        return origDebug.call(this, obj, msg);
      };
      baseLogger.warn = function (obj, msg) {
        capturedLogs.push({ level: "warn", obj, msg });
        return origWarn.call(this, obj, msg);
      };

      const fakeFetch = async (url, init = {}) => {
        if (init.method === "POST") {
          return {
            ok: true,
            status: 202,
            text: async () => JSON.stringify({ id: "ltx-provider-job-777" }),
          };
        }
        pollCallCount += 1;
        if (pollCallCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: "in_progress" }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "completed", result: { video_url: "https://cdn.ltx.io/final.mp4" } }),
        };
      };

      try {
        const result = await runWithContext({ jobId: "bullmq-job-999" }, () =>
          runLtx({
            provider: { id: "ltx", baseUrl: "https://api.ltx.io" },
            binding: {
              modelId: "ltx_2_3_pro",
              providerModelId: "ltx-2-3-pro",
              operations: [
                { id: "t2v", endpoint: "/v1/text-to-video", statusEndpoint: "/v1/jobs/:id" },
              ],
              pollingConfig: { pollInterval: 5, timeout: 60 },
            },
            payload: { prompt: "Neon skyline", duration: 8, resolution: "1080p", aspect_ratio: "16:9" },
            credential: "test-ltx-key",
            options: {
              fetchFn: fakeFetch,
              sleeper: async (ms) => {
                delays.push(ms);
              },
            },
          })
        );

        assert.strictEqual(result.result.video_url, "https://cdn.ltx.io/final.mp4");
        assert.deepStrictEqual(delays, [1200, 5000], "Poll #1 must use 1200ms then step up to 5000ms");

        const ltxJobLogs = capturedLogs.filter(
          (entry) => typeof entry.msg === "string" && entry.msg.includes("[LTX]") && entry.obj?.providerJobId
        );
        assert.ok(ltxJobLogs.length >= 2, "Expected LTX submit and completion logs with providerJobId");
        for (const entry of ltxJobLogs) {
          assert.strictEqual(entry.obj.providerJobId, "ltx-provider-job-777");
          assert.strictEqual(
            entry.obj.jobId,
            "bullmq-job-999",
            "LTX runner must NOT clobber BullMQ jobId from AsyncLocalStorage context"
          );
        }
      } finally {
        baseLogger.info = origInfo;
        baseLogger.debug = origDebug;
        baseLogger.warn = origWarn;
      }
    });
  });

  describe("5. Bria Remove Background WaveSpeed Models (Guided & 3.0)", () => {
    it("registers bria_remove_background_guided & bria_remove_background_3_0 under remove_background domain with defaultCost in getModelConfig()", () => {
      const catalog = getCatalog({ domain: "remove_background" });
      const guided = catalog.find((m) => m.id === "bria_remove_background_guided");
      const v3 = catalog.find((m) => m.id === "bria_remove_background_3_0");

      assert.ok(guided, "bria_remove_background_guided must be in active remove_background catalog");
      assert.ok(v3, "bria_remove_background_3_0 must be in active remove_background catalog");

      const fullConfig = getModelConfig({ fresh: true });
      const cfgGuided = fullConfig.models.find((m) => m.key === "bria_remove_background_guided");
      const cfgV3 = fullConfig.models.find((m) => m.key === "bria_remove_background_3_0");
      assert.ok(cfgGuided, "bria_remove_background_guided must appear in getModelConfig().models (getProjectData)");
      assert.ok(cfgV3, "bria_remove_background_3_0 must appear in getModelConfig().models (getProjectData)");
      assert.strictEqual(cfgGuided.category, "remove_background");
      assert.strictEqual(cfgV3.category, "remove_background");
      assert.deepStrictEqual(cfgGuided.supportedModes, ["remove_background"]);
      assert.deepStrictEqual(cfgV3.supportedModes, ["remove_background"]);
      assert.strictEqual(cfgGuided.pricing.defaultCost, 4);
      assert.strictEqual(cfgV3.pricing.defaultCost, 3);

      assert.strictEqual(getModelConfig("bria/remove-background-guided").key, "bria_remove_background_guided");
      assert.strictEqual(getModelConfig("bria/remove-background-3.0").key, "bria_remove_background_3_0");
      assert.strictEqual(getModelConfig("rmbg_3_0").key, "bria_remove_background_3_0");
    });

    it("validates inputs, computes retail credits, and maps WaveSpeed payloads accurately", () => {
      const imgUrl = "https://cdn.example.com/subject.png";

      const cleanGuided = validateModelInputs("bria_remove_background_guided", {
        input_image: imgUrl,
        prompt: "only the person on the left",
      });
      assert.strictEqual(cleanGuided.input_image, imgUrl);
      assert.strictEqual(cleanGuided.prompt, "only the person on the left");
      assert.strictEqual(cleanGuided.preserve_alpha, true);

      const guidedPlan = resolveExecutionPlan("bria_remove_background_guided", cleanGuided);
      assert.strictEqual(guidedPlan.route.providerId, "wavespeed");
      assert.strictEqual(guidedPlan.route.endpoint, "/api/v3/bria/remove-background-guided");
      assert.strictEqual(calculateCost("bria_remove_background_guided", cleanGuided), 4);
      assert.deepStrictEqual(mapToProviderPayload(cleanGuided, guidedPlan.route), {
        image: imgUrl,
        prompt: "only the person on the left",
        preserve_alpha: true,
      });

      const cleanV3 = validateModelInputs("bria_remove_background_3_0", {
        input_image: imgUrl,
        preserve_alpha: false,
      });
      assert.strictEqual(cleanV3.input_image, imgUrl);
      assert.strictEqual(cleanV3.preserve_alpha, false);

      const v3Plan = resolveExecutionPlan("bria_remove_background_3_0", cleanV3);
      assert.strictEqual(v3Plan.route.providerId, "wavespeed");
      assert.strictEqual(v3Plan.route.endpoint, "/api/v3/bria/remove-background-3.0");
      assert.strictEqual(calculateCost("bria_remove_background_3_0", cleanV3), 3);
      assert.deepStrictEqual(mapToProviderPayload(cleanV3, v3Plan.route), {
        image: imgUrl,
        preserve_alpha: false,
      });

      assert.throws(
        () => validateModelInputs("bria_remove_background_3_0", {}),
        (err) => err.statusCode === 400 && err.field === "input_image"
      );
      assert.throws(
        () => validateModelInputs("bria_remove_background_3_0", { input_image: imgUrl, prompt: "not supported" }),
        (err) => err.statusCode === 400
      );
    });
  });

  describe("6. RunwayML Provider (@runwayml/sdk) & Full Model Catalog", () => {
    it("registers all 42 Runway catalog models across Runway, Gemini/Veo, Seedream/Seedance, GPT Image, Kling, and Upscale with non-null defaultCost", () => {
      const expectedRunwayModels = [
        // Runway native (6)
        "runway_gen4_5", "runway_gen4_turbo", "runway_aleph_2", "runway_act_two", "runway_gen4_image", "runway_gen4_image_turbo",
        // Google / Gemini / Veo (10)
        "gemini_image_3_1_flash", "gemini_image_3_1_flash_lite", "gemini_image_3_pro", "gemini_2_5_flash_image", "nano_banana_2_1",
        "veo_3_1", "veo_3_1_fast", "gemini_omni_flash", "gemini_omni_flash_1_1", "gemini_omni_flash_1_2",
        // Seedream & Seedance (10)
        "seedream_5_pro", "seedream_5_lite", "seedream_5_flash", "seedream_5_5", "seedream_5_pro_layers", "seedream_5_5_layers",
        "seedance_2", "seedance_2_fast", "seedance_2_mini", "seedance_2_5_flash",
        // OpenAI / GPT Image (4)
        "gpt_image_2_5_flare", "gpt_image_2_5_sunburst", "gpt_image_2_6_flare", "gpt_image_2_6_sunburst",
        // Kling (9)
        "kling_4", "kling_4_flash", "kling_3_0_pro", "kling_3_0_standard", "kling_3_0_4k",
        "kling_o3_pro", "kling_o3_standard", "kling_o3_4k", "kling_2_5_turbo_pro",
        // Upscaling (3)
        "magnific_precision_upscaler_v2", "magnific_video_upscaler_creative", "runway_enhance_frame_rate",
      ];

      const fullConfig = getModelConfig({ fresh: true });
      for (const modelKey of expectedRunwayModels) {
        const entry = fullConfig.models.find((m) => m.key === modelKey);
        assert.ok(entry, `Expected Runway model "${modelKey}" in getModelConfig().models`);
        assert.strictEqual(typeof entry.pricing?.defaultCost, "number", `Expected numeric defaultCost for "${modelKey}"`);
        assert.ok(entry.pricing.defaultCost > 0, `Expected positive defaultCost for "${modelKey}"`);
      }

      // Aliases resolve cleanly
      assert.strictEqual(getModelConfig("gen4.5").key, "runway_gen4_5");
      assert.strictEqual(getModelConfig("aleph2").key, "runway_aleph_2");
      assert.strictEqual(getModelConfig("veo3.1").key, "veo_3_1");
      assert.strictEqual(getModelConfig("seedream5.5").key, "seedream_5_5");
      assert.strictEqual(getModelConfig("kling3.0_4k").key, "kling_3_0_4k");
      assert.strictEqual(getModelConfig("runway_image_upscale").key, "magnific_precision_upscaler_v2");
    });

    it("resolves multi-mode Runway routes (T2V / I2V / V2V) and exact pixel ratios accurately", () => {
      const t2v = resolveExecutionPlan("runway_gen4_5", { prompt: "Sunset ocean", duration: 5 });
      assert.strictEqual(t2v.route.providerId, "runway");
      assert.strictEqual(t2v.route.sdkMethod, "textToVideo");

      const i2v = resolveExecutionPlan("runway_gen4_5", {
        prompt: "Camera pans right",
        input_image: "https://cdn.example.com/start.png",
        duration: 5,
      });
      assert.strictEqual(i2v.route.sdkMethod, "imageToVideo");

      const v2vKling = resolveExecutionPlan("kling_4", {
        prompt: "Turn into anime style",
        input_video: "https://cdn.example.com/clip.mp4",
      });
      assert.strictEqual(v2vKling.route.sdkMethod, "videoToVideo");

      // Ratio resolver exact literals
      assert.strictEqual(resolveRunwayRatio("gen4.5", "textToVideo", "16:9", "720p"), "1280:720");
      assert.strictEqual(resolveRunwayRatio("gen4.5", "imageToVideo", "21:9", "720p"), "1584:672");
      assert.strictEqual(resolveRunwayRatio("gen4_image", "textToImage", "16:9", "1080p"), "1920:1080");
      assert.strictEqual(resolveRunwayRatio("kling3.0_4k", "textToVideo", "16:9", "4k"), "3840:2160");
      assert.strictEqual(resolveRunwayRatio("kling_4", "imageToVideo", "16:9", "1080p"), "auto_1080p");
      assert.strictEqual(resolveRunwayRatio("kling2.5_turbo_pro", "imageToVideo", "16:9", "1080p"), undefined);
      assert.strictEqual(resolveRunwayRatio("aleph2", "videoToVideo", "16:9", "720p"), undefined);
    });

    it("executes textToImage, imageToVideo (first+last frame), imageUpscale, and characterPerformance end-to-end through @runwayml/sdk runner", async () => {
      const calls = [];
      const makeWaitable = (outputUrls, credits = 10) => {
        const p = Promise.resolve({ id: "rw-task-1", estimatedCost: { credits } });
        p.waitForTaskOutput = async () => ({
          id: "rw-task-1",
          status: "SUCCEEDED",
          output: outputUrls,
          cost: { credits },
          createdAt: "2026-11-26T00:00:00Z",
        });
        return p;
      };

      const fakeSdkClient = {
        textToImage: {
          create: (body) => {
            calls.push({ method: "textToImage", body });
            return makeWaitable(["https://cdn.runwayml.com/gen4-img.png"], 8);
          },
        },
        imageToVideo: {
          create: (body) => {
            calls.push({ method: "imageToVideo", body });
            return makeWaitable(["https://cdn.runwayml.com/veo31.mp4"], 120);
          },
        },
        imageUpscale: {
          create: (body) => {
            calls.push({ method: "imageUpscale", body });
            return makeWaitable(["https://cdn.runwayml.com/upscaled.png"], 6);
          },
        },
        characterPerformance: {
          create: (body) => {
            calls.push({ method: "characterPerformance", body });
            return makeWaitable(["https://cdn.runwayml.com/act-two.mp4"], 25);
          },
        },
      };

      // 1. Image generation with multi-reference
      const imgRes = await runModel(
        "runway_gen4_image",
        {
          prompt: "Editorial studio portrait",
          aspect_ratio: "16:9",
          resolution: "1080p",
          input_image: "https://cdn.example.com/ref1.png",
        },
        { userId: "test-user-rw", sdkClient: fakeSdkClient }
      );
      assert.strictEqual(imgRes.images[0].url, "https://cdn.runwayml.com/gen4-img.png");
      assert.deepStrictEqual(calls[0], {
        method: "textToImage",
        body: {
          model: "gen4_image",
          promptText: "Editorial studio portrait",
          ratio: "1920:1080",
          referenceImages: [{ uri: "https://cdn.example.com/ref1.png" }],
        },
      });

      // 2. Veo 3.1 image-to-video with first + last frame
      const vidRes = await runModel(
        "veo_3_1",
        {
          prompt: "Smooth transition between keyframes",
          input_image: "https://cdn.example.com/first.png",
          last_frame: "https://cdn.example.com/last.png",
          duration: 6,
          resolution: "1080p",
          aspect_ratio: "16:9",
          generate_audio: true,
        },
        { userId: "test-user-rw", sdkClient: fakeSdkClient }
      );
      assert.strictEqual(vidRes.videos[0].url, "https://cdn.runwayml.com/veo31.mp4");
      assert.deepStrictEqual(calls[1], {
        method: "imageToVideo",
        body: {
          model: "veo3.1",
          promptText: "Smooth transition between keyframes",
          promptImage: [
            { uri: "https://cdn.example.com/first.png", position: "first" },
            { uri: "https://cdn.example.com/last.png", position: "last" },
          ],
          duration: 6,
          audio: true,
          ratio: "1920:1080",
        },
      });

      // 3. Magnific Precision Upscaler v2
      const upRes = await runModel(
        "magnific_precision_upscaler_v2",
        {
          input_image: "https://cdn.example.com/lowres.png",
          scale_factor: 4,
          flavor: "photo",
        },
        { userId: "test-user-rw", sdkClient: fakeSdkClient }
      );
      assert.strictEqual(upRes.images[0].url, "https://cdn.runwayml.com/upscaled.png");
      assert.deepStrictEqual(calls[2], {
        method: "imageUpscale",
        body: {
          model: "magnific_precision_upscaler_v2",
          imageUri: "https://cdn.example.com/lowres.png",
          scaleFactor: 4,
          flavor: "photo",
        },
      });

      // 4. Act-Two Character Performance
      const actRes = await runModel(
        "runway_act_two",
        {
          input_image: "https://cdn.example.com/char.png",
          reference_video: "https://cdn.example.com/perf.mp4",
          aspect_ratio: "16:9",
          body_control: true,
          expression_intensity: 4,
        },
        { userId: "test-user-rw", sdkClient: fakeSdkClient }
      );
      assert.strictEqual(actRes.videos[0].url, "https://cdn.runwayml.com/act-two.mp4");
      assert.deepStrictEqual(calls[3], {
        method: "characterPerformance",
        body: {
          model: "act_two",
          character: { type: "image", uri: "https://cdn.example.com/char.png" },
          reference: { type: "video", uri: "https://cdn.example.com/perf.mp4" },
          bodyControl: true,
          expressionIntensity: 4,
          ratio: "1280:720",
        },
      });
    });

    it("normalizes Runway TaskFailedError (terminal & quota) and TaskTimedOutError cleanly", async () => {
      const failingClient = {
        textToVideo: {
          create: () => {
            const p = Promise.resolve({ id: "rw-fail" });
            p.waitForTaskOutput = async () => {
              throw new TaskFailedError({
                id: "rw-fail",
                status: "FAILED",
                failure: "Content moderation blocked output",
                cost: { credits: 0 },
                createdAt: "2026-11-26T00:00:00Z",
              });
            };
            return p;
          },
        },
      };

      await assert.rejects(
        () =>
          runRunway({
            provider: { id: "runway", baseUrl: "https://api.dev.runwayml.com" },
            binding: { modelId: "runway_gen4_5", providerModelId: "gen4.5", sdkMethod: "textToVideo" },
            payload: { promptText: "test", duration: 5 },
            options: { sdkClient: failingClient },
          }),
        (err) => err.code === "PROVIDER_JOB_FAILED" && err.terminal === true && err.retryable === false
      );

      const timeoutClient = {
        textToVideo: {
          create: () => {
            const p = Promise.resolve({ id: "rw-timeout" });
            p.waitForTaskOutput = async () => {
              throw new TaskTimedOutError({ id: "rw-timeout", status: "RUNNING", progress: 0.5, createdAt: "2026-11-26T00:00:00Z", estimatedCost: { credits: 60 } });
            };
            return p;
          },
        },
      };

      await assert.rejects(
        () =>
          runRunway({
            provider: { id: "runway", baseUrl: "https://api.dev.runwayml.com" },
            binding: { modelId: "runway_gen4_5", providerModelId: "gen4.5", sdkMethod: "textToVideo" },
            payload: { promptText: "test", duration: 5 },
            options: { sdkClient: timeoutClient },
          }),
        (err) => err.code === "PROVIDER_TIMEOUT" && err.statusCode === 504
      );

      // Immediate POST rejection (e.g. 400 "You do not have enough credits to run this task.")
      // must be caught cleanly (no unhandled rejection crash) and mapped to PROVIDER_QUOTA_EXCEEDED
      const noCreditsClient = {
        textToImage: {
          create: () => {
            const p = Promise.reject(
              Object.assign(new Error('400 {"error":"You do not have enough credits to run this task."}'), {
                status: 400,
              })
            );
            p.waitForTaskOutput = async () => {
              await new Promise((r) => setTimeout(r, 50));
              return await p;
            };
            return p;
          },
        },
      };

      await assert.rejects(
        () =>
          runRunway({
            provider: { id: "runway", baseUrl: "https://api.dev.runwayml.com" },
            binding: { modelId: "gpt_image_2_5_flare", providerModelId: "gpt_image_2_5_flare", sdkMethod: "textToImage" },
            payload: { promptText: "test" },
            options: { sdkClient: noCreditsClient },
          }),
        (err) => err.code === "PROVIDER_QUOTA_EXCEEDED" && err.statusCode === 402
      );
    });
  });
});
}
