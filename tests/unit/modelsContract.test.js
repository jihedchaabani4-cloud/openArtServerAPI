import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "#shared";
import {
    ModelsError,
    ModelsValidationError,
    ModelsNotFoundError,
    ModelsConfigurationError,
    ModelsProviderError,
    ModelsSystemError,
    ValidationError,
    ProviderTransientError,
    getCatalog,
    getModelSchema,
    getSchema,
    validateInput,
    calculateCost,
    estimatePrice,
    run,
    initRegistry,
    reloadRegistry,
    getRegistryStats,
    getModelConfig,
    PricingService,
    LLMService,
    llmService,
    PromptService,
} from "#models/tools";

describe("Models System Public Contract (#platform/models)", () => {
    describe("1. Exported Error Hierarchy", () => {
        it("ModelsError inherits from AppError with default 500 status", () => {
            const err = new ModelsError("MODELS_ERR", "Base models system failure");
            assert.ok(err instanceof AppError);
            assert.ok(err instanceof ModelsError);
            assert.equal(err.statusCode, 500);
            assert.equal(err.code, "MODELS_ERR");
        });

        it("ModelsValidationError sets 400 status and VALIDATION_ERROR code", () => {
            const err = new ModelsValidationError("Invalid prompt parameter", { field: "prompt" });
            assert.ok(err instanceof ModelsError);
            assert.ok(err instanceof AppError);
            assert.equal(err.statusCode, 400);
            assert.equal(err.code, "MODELS_VALIDATION_ERROR");
            assert.equal(err.errorCode, "VALIDATION_ERROR");
            assert.equal(err.field, "prompt");
        });

        it("ModelsNotFoundError sets 404 status and NOT_FOUND code", () => {
            const err = new ModelsNotFoundError("Model not found", { modelFamily: "unknown_model" });
            assert.ok(err instanceof ModelsError);
            assert.ok(err instanceof AppError);
            assert.equal(err.statusCode, 404);
            assert.equal(err.code, "MODELS_NOT_FOUND");
            assert.equal(err.errorCode, "NOT_FOUND");
            assert.equal(err.modelFamily, "unknown_model");
        });

        it("ModelsConfigurationError sets 500 status and CONFIG_ERROR code", () => {
            const err = new ModelsConfigurationError("Missing binding configuration");
            assert.ok(err instanceof ModelsError);
            assert.ok(err instanceof AppError);
            assert.equal(err.statusCode, 500);
            assert.equal(err.code, "MODELS_CONFIGURATION_ERROR");
            assert.equal(err.errorCode, "CONFIG_ERROR");
        });

        it("ModelsProviderError sets 502 status and UPSTREAM_FAULT category", () => {
            const err = new ModelsProviderError("Upstream provider gateway timeout", { provider: "wavespeed", retryable: true });
            assert.ok(err instanceof ModelsError);
            assert.ok(err instanceof AppError);
            assert.equal(err.statusCode, 502);
            assert.equal(err.category, "UPSTREAM_FAULT");
            assert.equal(err.code, "MODELS_PROVIDER_ERROR");
            assert.equal(err.errorCode, "PROVIDER_ERROR");
            assert.equal(err.provider, "wavespeed");
            assert.equal(err.retryable, true);
        });

        it("re-exports legacy error classes for backward compatibility", () => {
            assert.equal(typeof ModelsSystemError, "function");
            assert.equal(typeof ValidationError, "function");
            assert.equal(typeof ProviderTransientError, "function");
            const legacyErr = new ValidationError("Bad input", { field: "aspect_ratio" });
            assert.equal(legacyErr.field, "aspect_ratio");
            assert.equal(legacyErr.statusCode, 400);
        });
    });

    describe("2. Core Models Capabilities", () => {
        it("exports public registry query and schema functions", () => {
            assert.equal(typeof getCatalog, "function");
            assert.equal(typeof getModelSchema, "function");
            assert.equal(typeof getSchema, "function");
            assert.equal(typeof validateInput, "function");
            assert.equal(typeof calculateCost, "function");
            assert.equal(typeof estimatePrice, "function");
            assert.equal(typeof run, "function");
            assert.equal(typeof getModelConfig, "function");
        });

        it("exports registry lifecycle and stats functions", () => {
            assert.equal(typeof initRegistry, "function");
            assert.equal(typeof reloadRegistry, "function");
            assert.equal(typeof getRegistryStats, "function");

            const stats = getRegistryStats();
            assert.ok(stats && typeof stats.models === "number");
            assert.ok(stats.models > 0);
        });

        it("getCatalog returns active model entries", () => {
            const catalog = getCatalog();
            assert.ok(Array.isArray(catalog));
            assert.ok(catalog.length > 0);
            const entry = catalog[0];
            assert.ok(entry.id);
            assert.ok(entry.displayName);
        });
    });

    describe("3. Services within Models Boundary", () => {
        it("exports PricingService class", () => {
            assert.equal(typeof PricingService, "function");
            const fakeSupabase = {};
            const fakeRedis = {};
            const service = new PricingService(fakeSupabase, fakeRedis);
            assert.equal(service.CACHE_TTL_SECONDS, 300);
            assert.equal(typeof service.getPrice, "function");
        });

        it("exports LLMService and singleton llmService", () => {
            assert.equal(typeof LLMService, "function");
            assert.ok(llmService instanceof LLMService);
            assert.equal(typeof llmService.generateText, "function");
            assert.equal(typeof llmService.generateJSON, "function");
        });

        it("exports PromptService class", () => {
            assert.equal(typeof PromptService, "function");
            const promptService = new PromptService();
            assert.equal(typeof promptService.complete, "function");
            assert.equal(typeof promptService.checkPrompt, "function");
        });
    });
});
