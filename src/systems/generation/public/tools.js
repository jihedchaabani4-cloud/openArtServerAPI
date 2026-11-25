/**
 * System 1: Generation & Workflows — Public Tools Gateway (#generation/tools)
 *
 * Only what other systems / src/container.js actually wire. The V3 engine
 * (registry, compiler, executor, nodes, workflows) stays internal.
 */

import { jobQueueService } from "../internal/services/jobQueueService.js";
import { GenerationService } from "../internal/services/GenerationService.js";
import { GenerationRequestService } from "../internal/services/GenerationRequestService.js";
import { WorkflowService } from "../internal/services/WorkflowService.js";
import { WorkflowRepository } from "../internal/db/WorkflowRepository.js";
import { ExecutionEngine } from "../internal/v3/core/ExecutionEngine.js";
import { JobExecutionContext, createJobExecutionContext } from "../internal/v3/core/JobExecutionContext.js";
import { setGenerationServices } from "../internal/services/serviceAccessor.js";

export function configureGeneration(services = {}) {
    setGenerationServices(services);
}

/**
 * Lazily starts the dedicated BullMQ generation worker and reservation reaper.
 * Kept dynamic so importing `#generation/tools` from `src/container.js` in the
 * HTTP API process (`index.js`) does not start background workers.
 */
export async function startGenerationWorker() {
    const mod = await import("../internal/workers/worker.js");
    return mod.useCaseWorker || mod.default;
}

export {
    jobQueueService,
    GenerationService,
    GenerationRequestService,
    WorkflowService,
    WorkflowRepository,
    ExecutionEngine,
    JobExecutionContext,
    createJobExecutionContext,
};
