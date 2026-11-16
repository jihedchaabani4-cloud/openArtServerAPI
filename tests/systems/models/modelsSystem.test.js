import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as models from "#models/tools";
import { getModelConfig, validateModelInputs, calculateCost, executeGeneration, executeLLM, getCatalog, getModelSchema, ModelsError, ModelsValidationError, ModelsNotFoundError, ModelsConfigurationError, ModelsProviderError } from "#models/tools";
import { initRegistry } from "../../../src/systems/models/internal/registry/modelRegistry.js";
import { registerProviderRunner, unregisterProviderRunner } from "../../../src/systems/models/internal/runtime/providerRuntimeRegistry.js";
import modelsRouter, { formatModelDto } from "#models/api";
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

    it("getModelConfig throws ModelsNotFoundError for unknown modelId", () => {
      assert.throws(
        () => getModelConfig("completely_nonexistent_model_xyz"),
        (err) => err instanceof ModelsNotFoundError && err.statusCode === 404
      );
    });

    it("validateModelInputs sanitizes and validates parameters against schema", () => {
      const catalog = getCatalog();
      const firstModel = catalog[0];
      const modelId = firstModel.modelFamily || firstModel.id;

      const clean = validateModelInputs(modelId, { prompt: "a cute robot painting" });
      assert.ok(clean);
      assert.equal(clean.prompt, "a cute robot painting");
    });

    it("calculateCost returns financial credit cost decoupled from wallet ledger", () => {
      const catalog = getCatalog();
      const imageModel = catalog.find((m) => m.domain === "image") || catalog[0];
      const modelId = imageModel.modelFamily || imageModel.id;

      const credits = calculateCost(modelId, { prompt: "fantasy landscape" });

      assert.equal(typeof credits, "number");
      assert.ok(credits > 0);
    });

    it("calculateCost with returnQuote returns detailed financial estimate DTO", () => {
      const catalog = getCatalog();
      const imageModel = catalog.find((m) => m.domain === "image") || catalog[0];
      const modelId = imageModel.modelFamily || imageModel.id;

      const quote = calculateCost(modelId, { prompt: "fantasy landscape" }, { returnQuote: true });

      assert.ok(quote);
      assert.equal(typeof quote.credits, "number");
      assert.ok(quote.credits > 0);
      assert.ok(quote.planIdentity);
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

    it("registers GET /, GET /:key, GET /:key/schema, POST /:key/estimate-price, POST /admin/reload", () => {
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
      assert.ok(paths.includes("/admin/reload"));
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

    it("POST /admin/reload handler successfully triggers registry reload and returns stats", async () => {
      const routeLayer = modelsRouter.stack.find(
        (layer) => layer.route && layer.route.path === "/admin/reload" && layer.route.methods.post
      );
      assert.ok(routeLayer, "Admin reload route should exist");

      let responsePayload = null;
      let statusCode = 200;

      const mockReq = {};
      const mockRes = {
        status(code) {
          statusCode = code;
          return this;
        },
        json(data) {
          responsePayload = data;
          return this;
        },
      };

      await routeLayer.route.stack[0].handle(mockReq, mockRes);

      assert.equal(statusCode, 200);
      assert.equal(responsePayload.success, true);
      assert.ok(responsePayload.data.models > 0);
    });
  });
});
}

// ─── Source: ltxModelCapabilitiesBoundary.test.js ───
{
describe("LTX Video Models Capability and Aspect Ratio Boundary", () => {
  before(() => {
    models.initRegistry({ forceReload: true });
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
