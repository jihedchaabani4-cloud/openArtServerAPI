import {
  workflowBillingGateway,
  workflowStorageGateway,
  workflowEventRecorder
} from "../container.js";
import { initializeGateways } from "./runner/workflowRunner.js";
import { registerAllUseCases } from "../use-cases/registerUseCases.js";
import { createLogger } from "../infrastructure/logging/index.js";

const systemLogger = createLogger("system");

/**
 * Bootstrap the V2 Composable Workflow Engine & Use Case Registry.
 * Wires shared gateways and configures runner dependencies.
 */
export function bootstrapV2() {
  systemLogger.debug("Wiring shared gateways...");
  initializeGateways({
    billing: workflowBillingGateway,
    storage: workflowStorageGateway,
    events: workflowEventRecorder
  });

  // Register all Use Cases (image-generation-v1, video-generation-v1, etc.)
  registerAllUseCases();

  systemLogger.debug("V2 Workflow Engine & Use Cases successfully bootstrapped");
}
