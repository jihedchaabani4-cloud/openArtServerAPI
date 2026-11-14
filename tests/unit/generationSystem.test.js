/**
 * Generation & Workflows System (System 1) — Unit & Gateway Contract Tests
 *
 * Verifies System 1 Generation (#generation/api, #generation/tools) boundaries,
 * typed errors, DTO contracts, and workflow triggers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    triggerWorkflowRun,
    getWorkflowRun,
    compileWorkflow,
    startWorkflowRun,
    executeOrchestration,
    loadRegistries,
    RunRepository,
    NodeSafetyService,
    bootstrapV2,
    UseCaseService,
    jobQueueService,
    GenerationService,
    GenerationRequestService,
    WorkflowLifecycleService,
    WorkflowService,
    PromptService,
    LLMService,
    llmService,
    PromptBuilderProService,
    enhancePromptProcessor,
    generateNegativePromptProcessor,
    moderationSafetyProcessor,
    optimizeVisualPromptProcessor,
    GenerationError,
    GenerationValidationError,
    GenerationNotFoundError,
    GenerationCompilationError,
    GenerationQueueDispatchError,
} from "#generation/tools";

import {
    imagesRouter,
    videoRouter,
    promptRouter,
    v2WorkflowsRouter,
    workflowsRouter,
    generationRouter,
} from "#generation/api";

describe("System 1: Generation & Workflows — Gateways & Public Tools Contract", () => {
    it("should export all expected public tools and facade members", () => {
        assert.equal(typeof triggerWorkflowRun, "function");
        assert.equal(typeof getWorkflowRun, "function");
        assert.equal(typeof compileWorkflow, "function");
        assert.equal(typeof startWorkflowRun, "function");
        assert.equal(typeof executeOrchestration, "function");
        assert.equal(typeof loadRegistries, "function");
        assert.equal(typeof RunRepository, "function");
        assert.equal(typeof NodeSafetyService, "object");
        assert.equal(typeof bootstrapV2, "function");
        assert.equal(typeof UseCaseService, "function");
        assert.equal(typeof jobQueueService, "object");
        assert.equal(typeof GenerationService, "function");
        assert.equal(typeof GenerationRequestService, "function");
        assert.equal(typeof WorkflowLifecycleService, "function");
        assert.equal(typeof WorkflowService, "function");
        assert.equal(typeof PromptService, "function");
        assert.equal(typeof LLMService, "function");
        assert.equal(typeof llmService, "object");
        assert.equal(typeof PromptBuilderProService, "function");
        assert.equal(typeof enhancePromptProcessor, "object");
        assert.equal(typeof generateNegativePromptProcessor, "object");
        assert.equal(typeof moderationSafetyProcessor, "object");
        assert.equal(typeof optimizeVisualPromptProcessor, "object");
    });

    it("should export valid Express routers from #generation/api", () => {
        assert.equal(typeof imagesRouter, "function");
        assert.equal(typeof videoRouter, "function");
        assert.equal(typeof promptRouter, "function");
        assert.equal(typeof v2WorkflowsRouter, "function");
        assert.equal(typeof workflowsRouter, "function");
        assert.equal(typeof generationRouter, "function");

        assert.ok(Array.isArray(imagesRouter.stack));
        assert.ok(Array.isArray(videoRouter.stack));
        assert.ok(Array.isArray(promptRouter.stack));
        assert.ok(Array.isArray(v2WorkflowsRouter.stack));
        assert.ok(Array.isArray(workflowsRouter.stack));
        assert.ok(Array.isArray(generationRouter.stack));
    });

    it("should enforce Generation typed error hierarchy", () => {
        const baseErr = new GenerationError("generic", 500);
        assert.equal(baseErr.statusCode, 500);
        assert.equal(baseErr.errorCode, "GENERATION_ERROR");

        const valErr = new GenerationValidationError("invalid parameter", { field: "prompt" });
        assert.equal(valErr.statusCode, 400);
        assert.equal(valErr.errorCode, "GENERATION_VALIDATION_ERROR");
        assert.equal(valErr.field, "prompt");

        const notFoundErr = new GenerationNotFoundError("workflow missing", { resourceId: "wf-1" });
        assert.equal(notFoundErr.statusCode, 404);
        assert.equal(notFoundErr.errorCode, "GENERATION_NOT_FOUND");
        assert.equal(notFoundErr.resourceId, "wf-1");

        const compErr = new GenerationCompilationError("compilation failed", { errors: ["node missing"] });
        assert.equal(compErr.statusCode, 422);
        assert.equal(compErr.errorCode, "COMPILATION_FAILED");
        assert.deepEqual(compErr.errors, ["node missing"]);

        const queueErr = new GenerationQueueDispatchError("dispatch failed", { attempts: 3 });
        assert.equal(queueErr.statusCode, 503);
        assert.equal(queueErr.errorCode, "QUEUE_DISPATCH_FAILED");
        assert.equal(queueErr.attempts, 3);
    });
});

describe("System 1: Generation & Workflows — triggerWorkflowRun & getWorkflowRun validations", () => {
    it("should throw GenerationValidationError when workflowId is missing in triggerWorkflowRun", async () => {
        await assert.rejects(
            () => triggerWorkflowRun({}),
            (err) => {
                assert.ok(err instanceof GenerationValidationError);
                assert.equal(err.statusCode, 400);
                assert.match(err.message, /workflowId is required/);
                return true;
            }
        );
    });

    it("should throw GenerationNotFoundError when workflowId is not in registries", async () => {
        await assert.rejects(
            () => triggerWorkflowRun({ workflowId: "non-existent-workflow-xyz" }),
            (err) => {
                assert.ok(err instanceof GenerationNotFoundError);
                assert.equal(err.statusCode, 404);
                assert.match(err.message, /not found in registry/);
                return true;
            }
        );
    });

    it("should throw GenerationValidationError when runId is missing in getWorkflowRun", async () => {
        await assert.rejects(
            () => getWorkflowRun({}),
            (err) => {
                assert.ok(err instanceof GenerationValidationError);
                assert.equal(err.statusCode, 400);
                assert.match(err.message, /runId is required/);
                return true;
            }
        );
    });

    it("should throw GenerationNotFoundError when run is missing in getWorkflowRun", async () => {
        await assert.rejects(
            () => getWorkflowRun({ runId: "00000000-0000-0000-0000-000000000000" }),
            (err) => {
                assert.ok(err instanceof GenerationNotFoundError);
                assert.equal(err.statusCode, 404);
                return true;
            }
        );
    });
});
