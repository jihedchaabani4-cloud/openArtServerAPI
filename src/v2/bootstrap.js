import {
  workflowBillingGateway,
  workflowStorageGateway,
  workflowEventRecorder
} from "../container.js";
import { initializeGateways } from "./runner/workflowRunner.js";
import { registerAllUseCases } from "../use-cases/registerUseCases.js";

/**
 * Bootstrap the V2 Composable Workflow Engine & Use Case Registry.
 * Wires shared gateways and configures runner dependencies.
 */
export function bootstrapV2() {
  console.log("[Bootstrap V2] Wiring shared gateways...");
  initializeGateways({
    billing: workflowBillingGateway,
    storage: workflowStorageGateway,
    events: workflowEventRecorder
  });

  // Register all Use Cases (image-generation-v1, video-generation-v1, etc.)
  registerAllUseCases();

  console.log("[Bootstrap V2] V2 Workflow Engine & Use Cases successfully bootstrapped.");
}
