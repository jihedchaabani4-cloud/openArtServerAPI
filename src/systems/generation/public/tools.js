/**
 * System 1: Generation & Workflows — Public Tools Gateway (#generation/tools)
 *
 * Exposes inter-system programmatic interfaces for triggering workflow runs,
 * compiling execution plans, ComfyUI-style V3 node engine, and querying prompt intelligence.
 */

import {
    compileWorkflow,
    compileWorkflowById,
    loadRegistries,
    startWorkflowRun,
    executeOrchestration,
    initializeGateways,
    getGateways,
    executeNodeJob,
    resolveInputsForNode,
    executeNodePersistence,
    getValueAtPath,
    bootstrapV2,
    configureDefaultGateways,
    executeNode,
    registerNodeExecutor,
    registry,
    executePromptBuilder,
    executeImageGeneration,
    executeVideoGeneration,
    executeLLM,
    executeLLMNode,
    registerAllUseCases,
    registerUseCase,
    getUseCase,
    listUseCases,
    clearUseCaseRegistry,
    imageGenerationUseCase,
    videoGenerationUseCase,
    characterSheetUseCase,
    calculateWorkflowBillingPlan,
    runUseCase,
    getUseCaseRegistries,
    enhancePrompt as enhancePromptProcessor,
    generateNegativePrompt as generateNegativePromptProcessor,
    moderationSafety as moderationSafetyProcessor,
    optimizeVisualPrompt as optimizeVisualPromptProcessor,
    applyCameraStyle as applyCameraStyleProcessor,
    applyCharacterTemplate as applyCharacterTemplateProcessor,
    applyComposition as applyCompositionProcessor,
    applyPoseTemplate as applyPoseTemplateProcessor,
    applySheetLayout as applySheetLayoutProcessor,
    applyTypographyArea as applyTypographyAreaProcessor,
    buildStoryboardLayout as buildStoryboardLayoutProcessor,
    resolveCharacters as resolveCharactersProcessor,
    resolveReferences as resolveReferencesProcessor,
} from "../internal/compat/legacyWorkflowCompat.js";

import {
    reserveNodeBilling,
    settleNodeBilling,
    rollbackNodeBilling,
    estimateNodeBillingAmount,
    isProviderBackedNodeType,
    getRunBillingAccumulator,
    beginRunBillingAccumulator,
    endRunBillingAccumulator,
    PersistedBillingAccumulator,
    activeAccumulators,
    getNodeBillingReference,
    PROVIDER_BACKED_NODE_TYPES,
} from "../internal/billing/nodeBilling.js";

import { RunRepository } from "../internal/db/RunRepository.js";
import { NodeSafetyService } from "../internal/services/NodeSafetyService.js";
import { V1StorageBridge } from "#media/tools";
import { UseCaseBillingRuntime, buildCompactCostBreakdown } from "../internal/billing/useCaseBillingRuntime.js";
import {
    formatWorkflowError,
    sanitizeClientError,
    DEFAULT_APOLOGY_MESSAGE,
    toRuntimeError,
    RUNTIME_ERROR_CODES,
    ERROR_CATEGORIES,
    ERROR_POLICY,
} from "../internal/errors/errorPolicy.js";

import {
    resolveWorkflowReferences,
    resolveWorkflowReference,
    resolveAsCharacter,
    resolveAsElement,
    resolveAsMedia,
    resolvePrimaryMediaUrl,
} from "../internal/resolvers/WorkflowReferenceResolver.js";

import {
    jobQueueService,
    getUseCaseQueue,
    USECASE_QUEUE_NAME,
    QueueDispatchError,
    JobQueueService,
} from "../internal/services/jobQueueService.js";

import { GenerationService } from "../internal/services/GenerationService.js";
import { GenerationRequestService } from "../internal/services/GenerationRequestService.js";
import { WorkflowLifecycleService, WorkflowService } from "../internal/services/WorkflowService.js";
import { WorkflowAuthorizationService } from "../internal/services/WorkflowAuthorizationService.js";
import { WorkflowMediaService, sanitizeStoragePath } from "../internal/services/WorkflowMediaService.js";
import { assertMediaUsable } from "../internal/services/mediaGuards.js";
import { BaseRepository } from "../internal/db/BaseRepository.js";
import { WorkflowRepository, workflowRepository } from "../internal/db/WorkflowRepository.js";
import { GenerationConfigRepository, generationConfigRepository } from "../internal/db/GenerationConfigRepository.js";
import { db as generationDb } from "../internal/db/dbMap.js";

import { PromptService, promptService, LLMService, llmService } from "#models/tools";
import { PromptBuilderProService } from "#elements/tools";

import {
    ERROR_CODES,
    GenerationError,
    Errors,
    parseProviderError,
    GenerationValidationError,
    GenerationNotFoundError,
    GenerationCompilationError,
    GenerationQueueDispatchError,
    GenerationUpstreamError,
    CompilationError,
    throwCompilationErrors,
} from "../internal/errors.js";

import {
    NodeRegistry,
    GraphCompiler,
    WorkflowExecutor,
    computeNodeSignature,
    V3Dispatcher,
    ALL_V3_NODES,
    V3_BASE_NODES,
    V3_CUSTOM_NODES,
    createDefaultV3NodeRegistry,
    LoadMediaNode,
    ResolveRefsNode,
    SafetyCheckNode,
    LlmTextNode,
    LlmVisionNode,
    PromptAssembleNode,
    ImageGenerateNode,
    ImageUpscaleNode,
    ImageRemoveBgNode,
    VideoGenerateNode,
    VideoUpscaleNode,
    SaveMediaNode,
    CropCharacterGridNode,
    ExtractVideoFrameNode,
    SaveCharacterSheetNode,
    V3_WORKFLOWS,
    getV3Workflow,
    imageGenerationV3,
    videoGenerationV3,
    characterSheetV3,
    productVideo4kV3,
} from "../internal/v3/index.js";

import { WorkflowBillingGateway } from "../internal/gateways/workflowBillingGateway.js";
import { WorkflowStorageGateway } from "../internal/gateways/workflowStorageGateway.js";
import { WorkflowEventRecorder } from "../internal/gateways/workflowEventRecorder.js";
import { useCaseWorker, handleUseCaseWorkerFailure } from "../internal/workers/useCaseWorker.js";
import { worker, startReaper } from "../internal/workers/worker.js";
import { setGenerationServices } from "../internal/services/serviceAccessor.js";

export const v2WorkflowWorker = worker;
export const UseCaseService = V3Dispatcher;

export function configureGeneration(services = {}) {
    setGenerationServices(services);
}

/**
 * Triggers a compiled workflow run asynchronously.
 *
 * @param {Object} params
 * @param {string} params.workflowId
 * @param {Object} params.input
 * @param {string} [params.userId=null]
 * @returns {Promise<{ run_id: string, status: string, workflow_id: string }>}
 */
export async function triggerWorkflowRun({ workflowId, input = {}, userId = null } = {}) {
    if (!workflowId) {
        throw new GenerationValidationError("workflowId is required to trigger workflow run");
    }

    const registries = loadRegistries();
    const workflow = registries.workflows?.[workflowId];
    if (!workflow) {
        throw new GenerationNotFoundError(`Workflow "${workflowId}" not found in registry`);
    }

    const plan = compileWorkflow(workflow, registries);
    const runtimeInput = {
        ...input,
        userId,
    };

    const runResult = await startWorkflowRun(plan, runtimeInput);
    return {
        run_id: runResult.run_id,
        status: runResult.status,
        workflow_id: workflowId,
    };
}

/**
 * Retrieves the status and node execution states of a workflow run.
 *
 * @param {string} runId
 * @param {string} [userId=null]
 * @returns {Promise<Object>}
 */
export async function getWorkflowRun({ runId, userId = null } = {}) {
    if (!runId) {
        throw new GenerationValidationError("runId is required");
    }

    const runRepo = new RunRepository();
    const run = await runRepo.getRun(runId);
    if (!run) {
        throw new GenerationNotFoundError(`Run "${runId}" not found`);
    }

    if (run.user_id && userId && run.user_id !== userId) {
        throw new GenerationNotFoundError(`Run "${runId}" not found or unauthorized`);
    }

    const nodeRuns = await runRepo.listNodeRuns(runId);
    return {
        run,
        nodeRuns,
    };
}

// ── Facade Re-exports for 100% Backward Compatibility ──────────────
export {
    compileWorkflow,
    compileWorkflowById,
    startWorkflowRun,
    executeOrchestration,
    initializeGateways,
    getGateways,
    executeNodeJob,
    resolveInputsForNode,
    executeNodePersistence,
    getValueAtPath,
    reserveNodeBilling,
    settleNodeBilling,
    rollbackNodeBilling,
    estimateNodeBillingAmount,
    isProviderBackedNodeType,
    getRunBillingAccumulator,
    beginRunBillingAccumulator,
    endRunBillingAccumulator,
    PersistedBillingAccumulator,
    activeAccumulators,
    getNodeBillingReference,
    PROVIDER_BACKED_NODE_TYPES,
    loadRegistries,
    RunRepository,
    NodeSafetyService,
    bootstrapV2,
    configureDefaultGateways,
    V1StorageBridge,
    UseCaseBillingRuntime,
    buildCompactCostBreakdown,
    formatWorkflowError,
    sanitizeClientError,
    DEFAULT_APOLOGY_MESSAGE,
    toRuntimeError,
    RUNTIME_ERROR_CODES,
    ERROR_CATEGORIES,
    ERROR_POLICY,
    runUseCase as run,
    resolveWorkflowReferences,
    resolveWorkflowReference,
    resolveAsCharacter,
    resolveAsElement,
    resolveAsMedia,
    resolvePrimaryMediaUrl,
    executeNode,
    registerNodeExecutor,
    registry,
    executePromptBuilder,
    executeImageGeneration,
    executeVideoGeneration,
    executeLLM,
    executeLLMNode,
    jobQueueService,
    JobQueueService,
    getUseCaseQueue,
    USECASE_QUEUE_NAME,
    QueueDispatchError,
    registerAllUseCases,
    registerUseCase,
    getUseCase,
    listUseCases,
    clearUseCaseRegistry,
    imageGenerationUseCase,
    videoGenerationUseCase,
    characterSheetUseCase,
    calculateWorkflowBillingPlan,
    runUseCase,
    getUseCaseRegistries,
    GenerationService,
    GenerationRequestService,
    WorkflowLifecycleService,
    WorkflowService,
    WorkflowAuthorizationService,
    WorkflowMediaService,
    sanitizeStoragePath,
    assertMediaUsable,
    BaseRepository,
    WorkflowRepository,
    workflowRepository,
    GenerationConfigRepository,
    generationConfigRepository,
    generationDb,
    PromptService,
    promptService,
    LLMService,
    llmService,
    PromptBuilderProService,
    enhancePromptProcessor,
    generateNegativePromptProcessor,
    moderationSafetyProcessor,
    optimizeVisualPromptProcessor,
    applyCameraStyleProcessor,
    applyCharacterTemplateProcessor,
    applyCompositionProcessor,
    applyPoseTemplateProcessor,
    applySheetLayoutProcessor,
    applyTypographyAreaProcessor,
    buildStoryboardLayoutProcessor,
    resolveCharactersProcessor,
    resolveReferencesProcessor,
    ERROR_CODES,
    GenerationError,
    Errors,
    parseProviderError,
    GenerationValidationError,
    GenerationNotFoundError,
    GenerationCompilationError,
    GenerationQueueDispatchError,
    GenerationUpstreamError,
    CompilationError,
    throwCompilationErrors,
    WorkflowBillingGateway,
    WorkflowStorageGateway,
    WorkflowEventRecorder,
    useCaseWorker,
    handleUseCaseWorkerFailure,
    worker,
    startReaper,
    // V3 ComfyUI-Style Node Engine
    NodeRegistry,
    GraphCompiler,
    WorkflowExecutor,
    computeNodeSignature,
    V3Dispatcher,
    ALL_V3_NODES,
    V3_BASE_NODES,
    V3_CUSTOM_NODES,
    createDefaultV3NodeRegistry,
    LoadMediaNode,
    ResolveRefsNode,
    SafetyCheckNode,
    LlmTextNode,
    LlmVisionNode,
    PromptAssembleNode,
    ImageGenerateNode,
    ImageUpscaleNode,
    ImageRemoveBgNode,
    VideoGenerateNode,
    VideoUpscaleNode,
    SaveMediaNode,
    CropCharacterGridNode,
    ExtractVideoFrameNode,
    SaveCharacterSheetNode,
    V3_WORKFLOWS,
    getV3Workflow,
    imageGenerationV3,
    videoGenerationV3,
    characterSheetV3,
    productVideo4kV3,
};

export default {
    configureGeneration,
    triggerWorkflowRun,
    getWorkflowRun,
    compileWorkflow,
    startWorkflowRun,
    UseCaseService,
    jobQueueService,
    GenerationService,
    GenerationRequestService,
    WorkflowLifecycleService,
    WorkflowService,
    WorkflowRepository,
    GenerationConfigRepository,
    RunRepository,
    V1StorageBridge,
    PromptService,
    LLMService,
    llmService,
    WorkflowBillingGateway,
    WorkflowStorageGateway,
    WorkflowEventRecorder,
    useCaseWorker,
    handleUseCaseWorkerFailure,
    worker,
    v2WorkflowWorker,
    startReaper,
    ERROR_CODES,
    Errors,
    parseProviderError,
    NodeRegistry,
    GraphCompiler,
    WorkflowExecutor,
    V3Dispatcher,
    createDefaultV3NodeRegistry,
    V3_WORKFLOWS,
    getV3Workflow,
    imageGenerationV3,
    videoGenerationV3,
    characterSheetV3,
    productVideo4kV3,
};
