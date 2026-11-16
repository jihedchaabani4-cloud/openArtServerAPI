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
import { GenerationConfigRepository } from "../internal/db/GenerationConfigRepository.js";
import { V3Dispatcher } from "../internal/v3/core/V3Dispatcher.js";
import { setGenerationServices } from "../internal/services/serviceAccessor.js";

export function configureGeneration(services = {}) {
    setGenerationServices(services);
}

export {
    jobQueueService,
    GenerationService,
    GenerationRequestService,
    WorkflowService,
    WorkflowRepository,
    GenerationConfigRepository,
    V3Dispatcher,
};
