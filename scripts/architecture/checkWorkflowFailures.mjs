import "../../src/workflows/registerWorkflows.js";
import { WorkflowRunner } from "../../src/workflows/workflowRunner.js";
import { WorkflowExecutionRepository } from "../../src/workflows/workflowExecutionRepository.js";
import { WorkflowEventRecorder } from "../../src/infrastructure/events/workflowEventRecorder.js";
import { WorkflowBillingGateway } from "../../src/infrastructure/billing/workflowBillingGateway.js";
import { WorkflowStorageGateway } from "../../src/infrastructure/storage/workflowStorageGateway.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const runner = new WorkflowRunner({
  executionRepository: new WorkflowExecutionRepository(),
  eventRecorder: new WorkflowEventRecorder({ logger: { info() {} } }),
  billingGateway: new WorkflowBillingGateway(),
  storageGateway: new WorkflowStorageGateway(),
  queueGateway: {
    enqueueWorkflowJob: async () => {
      throw new Error("fixture queue failure");
    },
  },
});

const failed = await runner.run({
  workflowId: "first-slice-image-generation",
  caller: { type: "internal", traceId: "failure-fixture", userId: "user-fixture" },
  input: { prompt: "fixture", userId: "user-fixture" },
  async: true,
}).catch((error) => ({ thrown: error }));

assert(failed.thrown, "Async queue failure should be surfaced for validation.");

const invalid = await runner.run({
  workflowId: "missing-workflow",
  caller: { type: "internal", traceId: "invalid-fixture", userId: "user-fixture" },
  input: {},
}).catch((error) => error);

assert(invalid.code === "INVALID_WORKFLOW", "Invalid workflow should produce INVALID_WORKFLOW.");

console.log("[checkWorkflowFailures] PASS");
process.exit(0);
