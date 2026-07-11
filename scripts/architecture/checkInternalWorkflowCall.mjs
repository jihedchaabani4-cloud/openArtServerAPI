import "../../src/workflows/registerWorkflows.js";
import { createProviderResolverFixtures } from "./providerResolverFixtures.mjs";
import { clearProviderRegistry, registerProviders } from "../../src/providers/providerRegistry.js";
import { WorkflowRunner } from "../../src/workflows/workflowRunner.js";
import { WorkflowExecutionRepository } from "../../src/workflows/workflowExecutionRepository.js";
import { WorkflowEventRecorder } from "../../src/infrastructure/events/workflowEventRecorder.js";
import { WorkflowBillingGateway } from "../../src/infrastructure/billing/workflowBillingGateway.js";
import { WorkflowStorageGateway } from "../../src/infrastructure/storage/workflowStorageGateway.js";
import { InternalWorkflowClient } from "../../src/workflows/internalWorkflowClient.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

clearProviderRegistry();
registerProviders(createProviderResolverFixtures());

const runner = new WorkflowRunner({
  executionRepository: new WorkflowExecutionRepository(),
  eventRecorder: new WorkflowEventRecorder({ logger: { info() {} } }),
  billingGateway: new WorkflowBillingGateway(),
  storageGateway: new WorkflowStorageGateway(),
  queueGateway: { enqueueWorkflowJob: async () => ({ id: "fixture-job" }) },
});

const client = new InternalWorkflowClient({ runner });
const result = await client.run({
  workflowId: "first-slice-image-generation",
  caller: { traceId: "internal-fixture", userId: "user-fixture" },
  input: { prompt: "fixture", userId: "user-fixture" },
});

assert(result.status === "completed", "Internal workflow call should complete.");
assert(result.currentContext.providerDecisions.length === 1, "Internal workflow call should preserve provider decisions.");

console.log("[checkInternalWorkflowCall] PASS");
process.exit(0);
