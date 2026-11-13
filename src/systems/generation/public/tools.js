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
    loadRegistries,
    RunRepository,
    NodeSafetyService,
    bootstrapV2,
} from "../internal/runner/index.js";

import {
    UseCaseService,
    jobQueueService,
    getUseCaseQueue,
    USECASE_QUEUE_NAME,
    QueueDispatchError,
    registerAllUseCases,
    registerUseCase,
    getUseCase,
    listUseCases,
    GenerationService,
    GenerationRequestService,
    WorkflowLifecycleService,
    WorkflowService,
    WorkflowAuthorizationService,
    WorkflowMediaService,
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
} from "../internal/prompt/index.js";

import {
    GenerationError,
    GenerationValidationError,
    GenerationNotFoundError,
    GenerationCompilationError,
    GenerationQueueDispatchError,
} from "../internal/errors.js";

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
    loadRegistries,
    RunRepository,
    NodeSafetyService,
    bootstrapV2,
    UseCaseService,
    jobQueueService,
    getUseCaseQueue,
    USECASE_QUEUE_NAME,
    QueueDispatchError,
    registerAllUseCases,
    registerUseCase,
    getUseCase,
    listUseCases,
    GenerationService,
    GenerationRequestService,
    WorkflowLifecycleService,
    WorkflowService,
    WorkflowAuthorizationService,
    WorkflowMediaService,
    PromptService,
    promptService,
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
};

export default {
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
    PromptService,
    LLMService,
    llmService,
};
