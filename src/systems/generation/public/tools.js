/**
 * System 1: Generation & Workflows — Public Tools Gateway (#generation/tools)
 *
 * Sealed 7-export gateway. Queue dispatch lives exclusively on WorkflowDispatchService;
 * DAG workflow execution lives in System 9 (#workflow-engine/tools).
 */

import { WorkflowDispatchService } from "../internal/services/WorkflowDispatchService.js";
import { GenerationService } from "../internal/services/GenerationService.js";
import { GenerationRequestService } from "../internal/services/GenerationRequestService.js";
import { WorkflowService } from "../internal/services/WorkflowService.js";
import { WorkflowRepository } from "../internal/db/WorkflowRepository.js";
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
  WorkflowDispatchService,
  GenerationService,
  GenerationRequestService,
  WorkflowService,
  WorkflowRepository,
};
