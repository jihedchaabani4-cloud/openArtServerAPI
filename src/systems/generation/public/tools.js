/**
 * System 1: Generation & Workflows — Public Tools Gateway (#generation/tools)
 *
 * Exposes inter-system programmatic interfaces for triggering workflow runs,
 * compiling execution plans, and querying prompt intelligence.
 */

import { compileWorkflow, compileWorkflowById } from "../internal/v2/compiler/compileWorkflow.js";
import { loadRegistries } from "../internal/v2/registry/registryLoader.js";
import {
    startWorkflowRun,
    executeOrchestration,
    initializeGateways,
    getGateways,
} from "../internal/v2/runner/workflowRunner.js";
import {
    executeNodeJob,
    resolveInputsForNode,
    executeNodePersistence,
    getValueAtPath,
} from "../internal/v2/runner/nodeExecutor.js";
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
} from "../internal/v2/runner/nodeBilling.js";
import { RunRepository } from "../internal/db/RunRepository.js";
import { NodeSafetyService } from "../internal/v2/nodes/safety/NodeSafetyService.js";
import { bootstrapV2, configureDefaultGateways } from "../internal/v2/bootstrap.js";
import { V1StorageBridge } from "#media/tools";
import { UseCaseBillingRuntime, buildCompactCostBreakdown } from "../internal/v2/runtime/useCaseBillingRuntime.js";
import {
    formatWorkflowError,
    sanitizeClientError,
    DEFAULT_APOLOGY_MESSAGE,
    toRuntimeError,
    RUNTIME_ERROR_CODES,
    ERROR_CATEGORIES,
    ERROR_POLICY,
} from "../internal/v2/runtime/errorPolicy.js";
import {
    resolveWorkflowReferences,
    resolveWorkflowReference,
    resolveAsCharacter,
    resolveAsElement,
    resolveAsMedia,
    resolvePrimaryMediaUrl,
} from "../internal/v2/resolvers/WorkflowReferenceResolver.js";
import {
    executeNode,
    registerNodeExecutor,
    registry,
} from "../internal/v2/nodes/index.js";
import { executePromptBuilder } from "../internal/v2/nodes/promptBuilderNode.js";
import { executeImageGeneration } from "../internal/v2/nodes/imageGenerationNode.js";
import { executeVideoGeneration } from "../internal/v2/nodes/videoGenerationNode.js";
import { executeLLM, executeLLMNode } from "../internal/v2/nodes/llmNode.js";

import { UseCaseService } from "../internal/services/useCaseService.js";
import {
    jobQueueService,
    getUseCaseQueue,
    USECASE_QUEUE_NAME,
    QueueDispatchError,
    JobQueueService,
} from "../internal/services/jobQueueService.js";
import { registerAllUseCases } from "../internal/use-cases/registerUseCases.js";
import {
    registerUseCase,
    getUseCase,
    listUseCases,
    clearUseCaseRegistry,
} from "../internal/use-cases/useCaseRegistry.js";
import { imageGenerationUseCase } from "../internal/use-cases/definitions/imageGeneration.js";
import { videoGenerationUseCase } from "../internal/use-cases/definitions/videoGeneration.js";
import { characterSheetUseCase } from "../internal/use-cases/definitions/characterSheet.js";
import { calculateWorkflowBillingPlan } from "../internal/use-cases/workflowBillingPlan.js";
import { run as runUseCase, getRegistries as getUseCaseRegistries } from "../internal/use-cases/useCaseRunner.js";
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
import * as enhancePromptProcessor from "../internal/v2/processors/enhancePrompt.js";
import * as generateNegativePromptProcessor from "../internal/v2/processors/generateNegativePrompt.js";
import * as moderationSafetyProcessor from "../internal/v2/processors/moderationSafety.js";
import * as optimizeVisualPromptProcessor from "../internal/v2/processors/optimizeVisualPrompt.js";
import * as applyCameraStyleProcessor from "../internal/v2/processors/applyCameraStyle.js";
import * as applyCharacterTemplateProcessor from "../internal/v2/processors/applyCharacterTemplate.js";
import * as applyCompositionProcessor from "../internal/v2/processors/applyComposition.js";
import * as applyPoseTemplateProcessor from "../internal/v2/processors/applyPoseTemplate.js";
import * as applySheetLayoutProcessor from "../internal/v2/processors/applySheetLayout.js";
import * as applyTypographyAreaProcessor from "../internal/v2/processors/applyTypographyArea.js";
import * as buildStoryboardLayoutProcessor from "../internal/v2/processors/buildStoryboardLayout.js";
import * as resolveCharactersProcessor from "../internal/v2/processors/resolveCharacters.js";
import * as resolveReferencesProcessor from "../internal/v2/processors/resolveReferences.js";

import {
    ERROR_CODES,
    GenerationError,
    Errors,
    parseProviderError,
    GenerationValidationError,
    GenerationNotFoundError,
    GenerationCompilationError,
    GenerationQueueDispatchError,
    CompilationError,
    throwCompilationErrors,
} from "../internal/errors.js";

import { WorkflowBillingGateway } from "../internal/gateways/workflowBillingGateway.js";
import { WorkflowStorageGateway } from "../internal/gateways/workflowStorageGateway.js";
import { WorkflowEventRecorder } from "../internal/gateways/workflowEventRecorder.js";
import { useCaseWorker, handleUseCaseWorkerFailure } from "../internal/workers/useCaseWorker.js";
import { worker, startReaper } from "../internal/workers/worker.js";
import { setGenerationServices } from "../internal/services/serviceAccessor.js";

export const v2WorkflowWorker = worker;

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
    UseCaseService,
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
    CompilationError,
    throwCompilationErrors,
    WorkflowBillingGateway,
    WorkflowStorageGateway,
    WorkflowEventRecorder,
    useCaseWorker,
    handleUseCaseWorkerFailure,
    worker,
    startReaper,
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
};
