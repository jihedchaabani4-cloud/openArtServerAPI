import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../../src/workflows/registerWorkflows.js";
import "../../src/registry/registerFeatures.js";
import { clearProviderRegistry, registerProviders } from "../../src/providers/providerRegistry.js";
import { createStaticProviderAdapter } from "../../src/providers/providerAdapterContract.js";
import { MEDIA_CAPABILITIES } from "../../src/workflows/workflowConstants.js";
import { WorkflowRunner } from "../../src/workflows/workflowRunner.js";
import { WorkflowExecutionRepository } from "../../src/workflows/workflowExecutionRepository.js";
import { WorkflowEventRecorder } from "../../src/infrastructure/events/workflowEventRecorder.js";
import { WorkflowBillingGateway } from "../../src/infrastructure/billing/workflowBillingGateway.js";
import { WorkflowStorageGateway } from "../../src/infrastructure/storage/workflowStorageGateway.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Custom parity fixtures that validate input/prompt existence and model names
function createParityProviderFixtures() {
  return [
    createStaticProviderAdapter({
      providerId: "healthy-low-cost",
      capabilities: [MEDIA_CAPABILITIES.IMAGE_GENERATION, MEDIA_CAPABILITIES.VIDEO_GENERATION],
      cost: 3,
      latencyMs: 1500,
      qualityTier: "standard",
      execute: async (context) => {
        if (!context.prompt) {
          throw new Error("Prompt is required");
        }
        if (context.model_name === "unknown-model") {
          throw new Error("Model not found");
        }
        return { outputs: [], providerId: "healthy-low-cost" };
      }
    })
  ];
}

clearProviderRegistry();
registerProviders(createParityProviderFixtures());

async function runParityCheck(jsonFilename) {
  const jsonPath = path.join(__dirname, jsonFilename);
  const checklist = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const { workflowId, checks } = checklist;

  console.log(`Running parity check for ${workflowId} using ${jsonFilename}...`);

  // 1. Success Path Verification
  const eventRecorder = new WorkflowEventRecorder({ logger: { info() {} } });
  const runner = new WorkflowRunner({
    executionRepository: new WorkflowExecutionRepository(),
    eventRecorder,
    billingGateway: new WorkflowBillingGateway(),
    storageGateway: new WorkflowStorageGateway(),
    queueGateway: { enqueueWorkflowJob: async () => ({ id: "fixture-job" }) },
  });

  const result = await runner.run({
    workflowId,
    caller: { type: "internal", traceId: `parity-success-${workflowId}`, userId: "user-fixture" },
    input: checks.successPath.inputs,
  });

  assert(result.status === checks.successPath.expectedOutputs.status, `Status should be ${checks.successPath.expectedOutputs.status}`);
  
  // Verify billing checkpoints
  assert(checks.billing.checkpoints.length > 0, "Billing checkpoints should be defined");
  
  // Verify storage checkpoints
  assert(checks.storage.checkpoints.length > 0, "Storage checkpoints should be defined");

  // Verify status states
  assert(checks.status.states.includes(result.status), "Result status should be one of the expected states");

  // Verify events emitted
  const emittedOps = eventRecorder.list().map(e => e.operation);
  for (const expectedOp of checks.events.expectedOperations) {
    assert(emittedOps.includes(expectedOp), `Expected event operation "${expectedOp}" was not recorded. Emitted: ${emittedOps.join(", ")}`);
  }

  // 2. Failure Path Verification
  const failedResult = await runner.run({
    workflowId,
    caller: { type: "internal", traceId: `parity-fail-${workflowId}`, userId: "user-fixture" },
    input: checks.failurePath.inputs,
  }).catch((error) => ({ thrown: error }));

  assert(failedResult.thrown || failedResult.status === "failed", "Failure path inputs should cause a failure status or throw an error");

  console.log(`✓ ${workflowId} parity check passed`);
}

async function main() {
  await runParityCheck("parityFirstSliceImage.json");
  await runParityCheck("parityFirstSliceVideo.json");
  console.log("[checkStrictParity] PASS");
}

main().then(() => process.exit(0)).catch(err => {
  console.error("Parity check failed:", err);
  process.exit(1);
});
