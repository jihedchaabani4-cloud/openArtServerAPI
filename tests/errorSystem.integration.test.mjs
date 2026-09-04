import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ErrorSystem } from "../src/runtime/ErrorSystem.js";
import { ProviderError } from "../src/errors/AppError.js";

describe("Error System End-to-End Integration Test (§8 & §10)", () => {
  it("simulates a Fal 401 failure end-to-end and asserts WalletService.release is called exactly once", async () => {
    // 1. Mock WalletService with call-tracking spies
    let releaseCallCount = 0;
    let commitCallCount = 0;
    let releasedReferenceId = null;

    const mockWalletService = {
      async hold({ referenceId, amount }) {
        return { referenceId, amount, status: "HELD" };
      },
      async commit(referenceId) {
        commitCallCount++;
        return { referenceId, status: "COMPLETED" };
      },
      async release(referenceId) {
        releaseCallCount++;
        releasedReferenceId = referenceId;
        return { referenceId, status: "RELEASED" };
      },
    };

    // 2. Setup simulated UseCase upfront hold
    const holdId = "usecase:image-generation-v1:user_789:exec_sim_401";
    const holdAmount = 24;
    await mockWalletService.hold({ referenceId: holdId, amount: holdAmount });

    // 3. Simulated Provider Failure (Fal 401 Unauthorized / quota exhausted)
    const simulatedProviderCall = async () => {
      throw new ProviderError("PROVIDER_AUTH_FAILED", "Fal API 401 Unauthorized: Provider credit quota is exhausted", {
        type: "OPERATIONAL",
        category: "SERVER_FAULT",
        context: { provider: "fal", model: "flux-pro" },
      });
    };

    // 4. Simulated Node Execution (nodeExecutor)
    let nodeRunResult;
    try {
      await simulatedProviderCall();
    } catch (nodeErr) {
      // Node catches, does not touch wallet, records error envelope
      nodeRunResult = {
        nodeId: "flux_node",
        status: "failed",
        error: nodeErr,
      };
    }

    assert.equal(nodeRunResult.status, "failed");
    assert.equal(releaseCallCount, 0, "nodeExecutor must NOT touch the wallet");

    // 5. Simulated Workflow Runner (workflowRunner)
    // Workflow detects failed node, terminates execution, surfaces root cause
    let workflowError = null;
    if (nodeRunResult.status === "failed") {
      workflowError = nodeRunResult.error;
    }

    // 6. Simulated UseCase Service (useCaseService)
    // The top-level decision maker that calls ErrorSystem.process and manages wallet actions
    let httpResponse = null;
    try {
      if (workflowError) {
        throw workflowError;
      }
      await mockWalletService.commit(holdId);
    } catch (useCaseErr) {
      const report = ErrorSystem.process(useCaseErr, {
        runId: "run_sim_401",
        userId: "user_789",
        nodeId: nodeRunResult.nodeId,
      });

      // Execute billing action
      if (report.actions.billingAction === "ROLLBACK" || report.actions.billingAction === "RELEASE") {
        await mockWalletService.release(holdId);
      }

      httpResponse = {
        statusCode: report.user.statusCode,
        body: { error: report.user },
      };
    }

    // 7. Verify Invariants (Zero Double-Release, Zero Double-Charge, Zero Leakage)
    assert.equal(releaseCallCount, 1, "WalletService.release must be called EXACTLY ONCE (no double-release)");
    assert.equal(commitCallCount, 0, "WalletService.commit must NOT be called on failure (no false charges)");
    assert.equal(releasedReferenceId, holdId, "Released hold ID must match upfront hold ID");

    // 8. Verify Sanitized User Response
    assert.equal(httpResponse.statusCode, 500);
    assert.equal(httpResponse.body.error.code, "PROVIDER_AUTH_FAILED");
    assert.equal(httpResponse.body.error.category, "SERVER_FAULT");
    assert.doesNotMatch(httpResponse.body.error.message, /fal|401|quota|exhausted/i, "User message must NOT leak provider secrets");
  });
});
