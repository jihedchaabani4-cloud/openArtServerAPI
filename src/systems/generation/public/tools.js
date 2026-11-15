/**
 * System 1: Generation & Workflows — Public Tools Gateway (#generation/tools)
 *
 * Exposes inter-system programmatic interfaces for triggering workflow runs,
 * ComfyUI-style V3 node engine, and querying prompt intelligence.
 */

import { RunRepository } from "../internal/db/RunRepository.js";
import { NodeSafetyService } from "../internal/services/NodeSafetyService.js";
import { V1StorageBridge } from "#media/tools";
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
    ResolveRefsNode,
    LlmNode,
    LLM_SKILLS_REGISTRY,
    buildUnifiedLlmInstruction,
    ImageGenerateNode,
    VideoGenerateNode,
    SaveMediaNode,
    SaveCharacterSheetNode,
    V3_WORKFLOWS,
    getV3Workflow,
    imageGenerationV3,
    videoGenerationV3,
    characterSheetV3,
} from "../internal/v3/index.js";

import {
    resolveWorkflowReference,
    resolveWorkflowReferences,
    resolvePrimaryMediaUrl,
    resolveAsCharacter,
    resolveAsElement,
    resolveAsMedia,
} from "../internal/resolvers/WorkflowReferenceResolver.js";
import { WorkflowBillingGateway } from "../internal/gateways/workflowBillingGateway.js";
import { WorkflowStorageGateway } from "../internal/gateways/workflowStorageGateway.js";
import { WorkflowEventRecorder } from "../internal/gateways/workflowEventRecorder.js";
import { useCaseWorker, handleUseCaseWorkerFailure } from "../internal/workers/useCaseWorker.js";
import { worker, startReaper } from "../internal/workers/worker.js";
import { setGenerationServices, getV3Dispatcher, getUseCaseService } from "../internal/services/serviceAccessor.js";

export const UseCaseService = V3Dispatcher;

export function configureGeneration(services = {}) {
    setGenerationServices(services);
}

export function configureDefaultGateways() {}

/**
 * Triggers a V3 workflow run asynchronously.
 */
export async function triggerWorkflowRun({ workflowId, input = {}, userId = null } = {}) {
    if (!workflowId) {
        throw new GenerationValidationError("workflowId is required to trigger workflow run");
    }
    if (!getV3Workflow(workflowId)) {
        throw new GenerationNotFoundError(`Workflow "${workflowId}" not found in registry`, {
            resourceId: workflowId,
        });
    }
    const dispatcher = getV3Dispatcher() || getUseCaseService();
    const result = await dispatcher.prepareAndEnqueue({
        workflowId,
        input,
        userId,
    });
    return {
        run_id: result.runId || result.executionId,
        status: result.status,
        workflow_id: workflowId,
    };
}

/**
 * Retrieves the status and node execution states of a workflow run.
 */
export async function getWorkflowRun({ runId, userId = null } = {}) {
    return WorkflowLifecycleService.getWorkflowRun({ runId, userId });
}

export {
    RunRepository,
    NodeSafetyService,
    V1StorageBridge,
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
    resolveWorkflowReference,
    resolveWorkflowReferences,
    resolvePrimaryMediaUrl,
    resolveAsCharacter,
    resolveAsElement,
    resolveAsMedia,
    WorkflowBillingGateway,
    WorkflowStorageGateway,
    WorkflowEventRecorder,
    useCaseWorker,
    handleUseCaseWorkerFailure,
    worker,
    startReaper,
    jobQueueService,
    JobQueueService,
    getUseCaseQueue,
    USECASE_QUEUE_NAME,
    QueueDispatchError,
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
    ResolveRefsNode,
    LlmNode,
    LLM_SKILLS_REGISTRY,
    buildUnifiedLlmInstruction,
    ImageGenerateNode,
    VideoGenerateNode,
    SaveMediaNode,
    SaveCharacterSheetNode,
    V3_WORKFLOWS,
    getV3Workflow,
    imageGenerationV3,
    videoGenerationV3,
    characterSheetV3,
};

export default {
    configureGeneration,
    triggerWorkflowRun,
    getWorkflowRun,
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
    resolveWorkflowReference,
    resolveWorkflowReferences,
    resolvePrimaryMediaUrl,
    resolveAsCharacter,
    resolveAsElement,
    resolveAsMedia,
    WorkflowBillingGateway,
    WorkflowStorageGateway,
    WorkflowEventRecorder,
    useCaseWorker,
    handleUseCaseWorkerFailure,
    worker,
    startReaper,
    ERROR_CODES,
    Errors,
    parseProviderError,
    NodeRegistry,
    GraphCompiler,
    WorkflowExecutor,
    V3Dispatcher,
    createDefaultV3NodeRegistry,
    ResolveRefsNode,
    LlmNode,
    LLM_SKILLS_REGISTRY,
    buildUnifiedLlmInstruction,
    ImageGenerateNode,
    VideoGenerateNode,
    SaveMediaNode,
    SaveCharacterSheetNode,
    V3_WORKFLOWS,
    getV3Workflow,
    imageGenerationV3,
    videoGenerationV3,
    characterSheetV3,
};
