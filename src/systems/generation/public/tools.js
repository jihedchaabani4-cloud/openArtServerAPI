/**
 * System 1: Generation & Workflows — Public Tools Gateway (#generation/tools)
 *
 * Exposes inter-system programmatic interfaces for triggering workflow runs,
 * compiling execution plans, and querying prompt intelligence.
 */

import {
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
    formatWorkflowError,
    sanitizeClientError,
    DEFAULT_APOLOGY_MESSAGE,
    toRuntimeError,
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
} from "../internal/runner/index.js";

import {
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
    WorkflowRepository,
    workflowRepository,
    GenerationConfigRepository,
    generationConfigRepository,
    generationDb,
} from "../internal/engine/index.js";

import {
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
} from "../internal/prompt/index.js";

import {
    GenerationError,
    GenerationValidationError,
    GenerationNotFoundError,
    GenerationCompilationError,
    GenerationQueueDispatchError,
} from "../internal/errors.js";

import { setGenerationServices } from "../internal/serviceAccessor.js";

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
    formatWorkflowError,
    sanitizeClientError,
    DEFAULT_APOLOGY_MESSAGE,
    toRuntimeError,
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
    GenerationError,
    GenerationValidationError,
    GenerationNotFoundError,
    GenerationCompilationError,
    GenerationQueueDispatchError,
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
};
