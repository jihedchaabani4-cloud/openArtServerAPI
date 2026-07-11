import "../../src/workflows/registerWorkflows.js";
import { createProviderResolverFixtures } from "./providerResolverFixtures.mjs";
import { clearProviderRegistry, registerProviders } from "../../src/providers/providerRegistry.js";
import { WorkflowRunner } from "../../src/workflows/workflowRunner.js";
import { WorkflowExecutionRepository } from "../../src/workflows/workflowExecutionRepository.js";
import { WorkflowEventRecorder } from "../../src/infrastructure/events/workflowEventRecorder.js";
import { WorkflowBillingGateway } from "../../src/infrastructure/billing/workflowBillingGateway.js";
import { WorkflowStorageGateway } from "../../src/infrastructure/storage/workflowStorageGateway.js";
import { InternalWorkflowClient } from "../../src/workflows/internalWorkflowClient.js";
import { normalizeWorkflowRunInput, normalizeWorkflowRunResult } from "../../src/workflows/workflowRunContract.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeRunner() {
  clearProviderRegistry();
  registerProviders(createProviderResolverFixtures());
  return new WorkflowRunner({
    executionRepository: new WorkflowExecutionRepository(),
    eventRecorder: new WorkflowEventRecorder({ logger: { info() {} } }),
    billingGateway: new WorkflowBillingGateway(),
    storageGateway: new WorkflowStorageGateway(),
    queueGateway: { enqueueWorkflowJob: async () => ({ id: "fixture-job" }) },
  });
}

const internalResult = await new InternalWorkflowClient({ runner: makeRunner() }).run({
  workflowId: "first-slice-image-generation",
  caller: { traceId: "internal-parity", userId: "user-fixture" },
  input: { prompt: "fixture", userId: "user-fixture" },
});

const httpRunner = makeRunner();
const httpResult = normalizeWorkflowRunResult(await httpRunner.run(normalizeWorkflowRunInput({
  workflowId: "first-slice-image-generation",
  caller: { type: "http", traceId: "http-parity", userId: "user-fixture" },
  input: { prompt: "fixture", userId: "user-fixture" },
})));

assert(internalResult.status === httpResult.status, "HTTP and internal status should match.");
assert(Boolean(internalResult.currentContext.providerDecisions?.[0]), "Internal result should include provider decision.");
assert(Boolean(httpResult.currentContext.providerDecisions?.[0]), "HTTP result should include provider decision.");
assert(
  internalResult.currentContext.capabilities.join(",") === httpResult.currentContext.capabilities.join(","),
  "HTTP and internal capabilities should match."
);

console.log("[checkWorkflowCallParity] PASS");
process.exit(0);
