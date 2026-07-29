import {
  workflowBillingGateway,
  workflowStorageGateway,
  workflowEventRecorder
} from "../container.js";
import { initializeGateways } from "./runner/workflowRunner.js";
import { registerProviders } from "../providers/providerRegistry.js";
import { createV2ImageAdapter } from "./providers/adapters/imageAdapter.js";
import { createV2VideoAdapter } from "./providers/adapters/videoAdapter.js";
import { createV2UpscaleAdapter } from "./providers/adapters/upscaleAdapter.js";
import { registerFirstSliceWorkflows } from "../workflows/registerWorkflows.js";

/**
 * Bootstrap the V2 Composable Workflow Engine.
 * Wires shared gateways and configures runner dependencies.
 */
export function bootstrapV2() {
  console.log("[Bootstrap V2] Wiring shared gateways...");
  initializeGateways({
    billing: workflowBillingGateway,
    storage: workflowStorageGateway,
    events: workflowEventRecorder
  });

  registerProviders([
    createV2ImageAdapter({ providerId: "fal", cost: 10, latencyMs: 1200, qualityTier: "standard" }),
    createV2VideoAdapter({ providerId: "runway", cost: 30, latencyMs: 8000, qualityTier: "standard" }),
    createV2UpscaleAdapter({ providerId: "topaz", cost: 5, latencyMs: 2000, qualityTier: "standard" }),
  ], { replace: true });

  registerFirstSliceWorkflows({ replace: true });

  console.log("[Bootstrap V2] V2 Workflow Engine successfully bootstrapped.");

  // Import worker to activate BullMQ queue processing
  import("./queue/v2WorkflowWorker.js").then(() => {
    console.log("[Bootstrap V2] V2 Workflow Worker queue listener active.");
  }).catch((err) => {
    console.warn("[Bootstrap V2] V2 Workflow Worker queue listener warning:", err.message);
  });
}
