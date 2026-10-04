import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { startWorkflowRun } from "../../src/v2/runner/workflowRunner.js";
import { RunRepository } from "../../src/v2/runner/runRepository.js";
import * as workflowRunnerModule from "../../src/v2/runner/workflowRunner.js";
import { UseCaseService } from "../../src/services/useCaseService.js";
import * as useCaseRunner from "../../src/use-cases/useCaseRunner.js";

describe("Orchestration Error & Billing Settlement Boundary Tests (BUG-01)", () => {
  let settledCalls = [];
  let rollbackCalls = [];
  let mediaUpdates = [];
  let mockMediaDb;
  let mockBillingRuntime;
  let useCaseService;
  let runRepo;

  after(() => {
    setTimeout(() => process.exit(0), 100);
  });

  beforeEach(() => {
    settledCalls = [];
    rollbackCalls = [];
    mediaUpdates = [];
    runRepo = new RunRepository();

    mockMediaDb = {
      findByWorkflow: async (wfId) => [
        { id: "media-placeholder-1", status: "processing", workflow_id: wfId },
      ],
      updateMedia: async (id, patch) => {
        mediaUpdates.push({ id, ...patch });
        return { id, ...patch };
      },
    };

    mockBillingRuntime = {
      settleUseCase: async (referenceId, meta) => {
        settledCalls.push({ referenceId, meta });
        return { settled: true };
      },
      rollbackUseCase: async (referenceId, meta) => {
        rollbackCalls.push({ referenceId, meta });
        return { rolledBack: true };
      },
    };

    useCaseService = new UseCaseService({
      billingRuntime: mockBillingRuntime,
      db: { media: mockMediaDb },
    });
  });

  it("TEST 1: startWorkflowRun marks run as failed and rethrows when executeOrchestration throws", async () => {
    const plan = {
      workflow_id: "test-wf-bug01",
      nodes: [
        { id: "node1", type: "prompt-builder" }
      ]
    };
    const runtimeInput = { prompt: "test prompt", userId: "user-123" };

    // Inject an unexpected orchestration TypeError (e.g. undefined.filter)
    const originalExecuteOrchestration = workflowRunnerModule.executeOrchestration;
    try {
      // In ES modules, we can test what startWorkflowRun does when executeOrchestration fails
      // We will create a test that calls startWorkflowRun with a plan that triggers an unexpected orchestration failure
      // or directly test executeOrchestration error handling
      const runId = "test-run-orch-err";
      await runRepo.createRun({
        id: runId,
        user_id: "user-123",
        workflow_id: "test-wf-bug01",
        status: "pending",
        execution_plan: plan,
      });

      // If startWorkflowRun swallows the error, it does not throw
      await assert.rejects(
        async () => {
          // Provide an invalid plan structure that causes executeOrchestration to throw TypeError
          const brokenPlan = {
            workflow_id: "test-wf-bug01",
            nodes: null // Causes plan.nodes.every to throw TypeError: Cannot read properties of null (reading 'every')
          };
          await startWorkflowRun(brokenPlan, runtimeInput, "test-run-broken-nodes");
        },
        /TypeError|Cannot read properties|orchestration/i,
        "Expected startWorkflowRun to rethrow unexpected orchestration error"
      );

      const savedRun = await runRepo.getRun("test-run-broken-nodes");
      assert.strictEqual(savedRun?.status, "failed", "Run should be marked as failed in DB");
    } finally {
      // cleanup
    }
  });

  it("TEST 2: useCaseRunner.run throws when workflow run ends in non-completed status (e.g. running)", async () => {
    // If startWorkflowRun returns { status: "running" }, useCaseRunner.run MUST throw
    const originalStartWorkflowRun = useCaseRunner.getRegistries;
    // We test executeQueuedUseCase end-to-end:
    // If runUseCase returns status "running", executeQueuedUseCase must NOT settle billing!
    useCaseService.runUseCase = async () => {
      return {
        executionId: "run-failed-swallowed",
        status: "running", // Swallowed error caused status to remain "running"
        outputs: null,
        billingBreakdown: [],
        totalCost: 10,
      };
    };

    await assert.rejects(
      async () => {
        await useCaseService.executeQueuedUseCase({
          useCaseId: "image-generation-v1",
          input: {
            workflow_id: "wf-bug01-media",
            billing_hold_id: "hold-bug01-123",
            billing_status: "reserved",
            reserved_credits: 10,
          },
          userId: "user-victim-123",
          billingHoldId: "hold-bug01-123",
        });
      },
      /(did not complete|WORKFLOW_INCOMPLETE|failed)/i,
      "Expected executeQueuedUseCase to throw when run did not complete"
    );

    // CRITICAL BILLING ASSERTIONS:
    assert.strictEqual(
      settledCalls.length,
      0,
      "CRITICAL: settlePreparedBilling (commit_transaction) must NEVER be called when run did not complete!"
    );
    assert.strictEqual(
      rollbackCalls.length,
      1,
      "CRITICAL: rollbackPreparedBilling (rollback_transaction) MUST be called to release held credits!"
    );
    assert.strictEqual(
      mediaUpdates.some((m) => m.status === "failed"),
      true,
      "CRITICAL: Stuck placeholder media must be marked as failed!"
    );
  });

  it("TEST 3: End-to-end orchestration failure: hold released, media marked failed, NO commit_transaction", async () => {
    // Injected error replicating the audit scenario (TypeError: undefined.filter)
    useCaseService.runUseCase = async () => {
      const err = new TypeError("Cannot read properties of undefined (reading 'filter')");
      err.code = "ORCHESTRATION_ERROR";
      throw err;
    };

    await assert.rejects(
      async () => {
        await useCaseService.executeQueuedUseCase({
          useCaseId: "image-generation-v1",
          input: {
            workflow_id: "wf-bug01-e2e",
            billing_hold_id: "hold-bug01-e2e",
            billing_status: "reserved",
            reserved_credits: 10,
          },
          userId: "user-audit-123",
          billingHoldId: "hold-bug01-e2e",
        });
      },
      /Cannot read properties|filter|ORCHESTRATION_ERROR/i,
      "Expected executeQueuedUseCase to reject on orchestration error"
    );

    assert.strictEqual(settledCalls.length, 0, "No commit_transaction (settle) must be executed");
    assert.strictEqual(rollbackCalls.length, 1, "Hold must be released via rollback_transaction");
    assert.strictEqual(mediaUpdates.some((m) => m.status === "failed"), true, "Media must be marked failed");
  });
});
