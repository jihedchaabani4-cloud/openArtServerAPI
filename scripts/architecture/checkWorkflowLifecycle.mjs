import "../../src/workflows/registerWorkflows.js";
import { createProviderResolverFixtures } from "./providerResolverFixtures.mjs";
import { clearProviderRegistry, registerProviders } from "../../src/providers/providerRegistry.js";
import { WorkflowRunner } from "../../src/workflows/workflowRunner.js";
import { WorkflowExecutionRepository } from "../../src/workflows/workflowExecutionRepository.js";
import { WorkflowEventRecorder } from "../../src/infrastructure/events/workflowEventRecorder.js";
import { WorkflowBillingGateway } from "../../src/infrastructure/billing/workflowBillingGateway.js";
import { WorkflowStorageGateway } from "../../src/infrastructure/storage/workflowStorageGateway.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

clearProviderRegistry();
registerProviders(createProviderResolverFixtures());

const executionRepository = new WorkflowExecutionRepository();
const eventRecorder = new WorkflowEventRecorder({ logger: { info() {} } });
const runner = new WorkflowRunner({
  executionRepository,
  eventRecorder,
  billingGateway: new WorkflowBillingGateway(),
  storageGateway: new WorkflowStorageGateway(),
  queueGateway: { enqueueWorkflowJob: async () => ({ id: "fixture-job" }) },
});

const result = await runner.run({
  workflowId: "first-slice-image-generation",
  caller: { type: "internal", traceId: "lifecycle-fixture", userId: "user-fixture" },
  input: { prompt: "fixture", userId: "user-fixture" },
});

assert(result.status === "completed", "Workflow should complete in lifecycle fixture.");
assert(result.currentContext.processingSteps.includes("GenerateImageTreatment"), "Processing step should be recorded.");
assert(result.currentContext.providerDecisions.length === 1, "Provider decision should be recorded.");
assert(eventRecorder.list().some((event) => event.operation === "workflow.complete"), "Completion event should be emitted.");

console.log("[checkWorkflowLifecycle] PASS");
process.exit(0);
