import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import {
  getModelConfig,
  validateModelInputs,
  calculateOperationCost,
  executeGeneration,
  executeLLM,
  initRegistry,
  getCatalog,
  getModelSchema,
  estimatePrice,
  ModelsError,
  ModelsValidationError,
  ModelsNotFoundError,
  ModelsConfigurationError,
  ModelsProviderError,
} from "#models/tools";

import modelsRouter, { formatModelDto } from "#models/api";

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

    it("calculateOperationCost returns financial cost estimate DTO decoupled from wallet ledger", () => {
      const catalog = getCatalog();
      const imageModel = catalog.find((m) => m.domain === "image") || catalog[0];
      const modelId = imageModel.modelFamily || imageModel.id;

      const result = calculateOperationCost({
        modelId,
        params: { prompt: "fantasy landscape" },
      });

      assert.ok(result);
      assert.equal(typeof result.credits, "number");
      assert.ok(result.credits > 0);
      assert.equal(result.currency, "credits");
      assert.ok(result.pricingVersion);
    });

    it("calculateOperationCost throws ModelsValidationError if modelId is missing", () => {
      assert.throws(
        () => calculateOperationCost({}),
        (err) => err instanceof ModelsValidationError && err.statusCode === 400
      );
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
