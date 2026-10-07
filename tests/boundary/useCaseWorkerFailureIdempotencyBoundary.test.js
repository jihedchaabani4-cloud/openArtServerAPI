import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handleUseCaseWorkerFailure } from "../../src/workers/useCaseWorker.js";
import { useCaseService, db } from "../../src/container.js";
import { InMemoryWalletService } from "../../src/services/walletService.js";

describe("RC1.4-D3(3) — UseCaseWorker Failure Handler Idempotency & Boot Assertions", () => {
  let originalRollback;
  let originalFindByWorkflow;
  let originalUpdateMedia;
  let originalWalletService;

  beforeEach(() => {
    originalRollback = useCaseService.rollbackPreparedBilling;
    originalFindByWorkflow = db?.media?.findByWorkflow;
    originalUpdateMedia = db?.media?.updateMedia;
    originalWalletService = useCaseService.billingRuntime?.walletService;
  });

  afterEach(() => {
    useCaseService.rollbackPreparedBilling = originalRollback;
    if (useCaseService.billingRuntime) {
      useCaseService.billingRuntime.walletService = originalWalletService;
    }
    if (db?.media) {
      db.media.findByWorkflow = originalFindByWorkflow;
      db.media.updateMedia = originalUpdateMedia;
    }
  });

  it("TEST 1: useCaseWorker failure handler is idempotent when invoked multiple times for same job", async () => {
    const testUserId = "user-idempotency-test";
    const initialBalance = 100;
    const holdAmount = 10;
    const holdId = "hold-idem-test-123";
    const workflowId = "wf-idem-test-123";

    const mockWallet = new InMemoryWalletService();
    await mockWallet.setBalance(testUserId, initialBalance);
    await mockWallet.reserve({
      userId: testUserId,
      amount: holdAmount,
      referenceId: holdId,
      metadata: { workflowId }
    });

    if (useCaseService.billingRuntime) {
      useCaseService.billingRuntime.walletService = mockWallet;
    }

    const balanceAfterHold = await mockWallet.getBalance(testUserId);
    assert.equal(balanceAfterHold, initialBalance - holdAmount, "Balance should be debited by hold amount");

    let mediaUpdateCalls = 0;
    if (db?.media) {
      db.media.findByWorkflow = async (wfId) => [
        { id: "media-test-1", workflow_id: wfId, status: "pending" }
      ];
      db.media.updateMedia = async (mediaId, patch) => {
        mediaUpdateCalls++;
        return { id: mediaId, ...patch };
      };
    }

    // Prepare job object
    const failedJob = {
      id: "job-failed-test-999",
      data: {
        billingHoldId: holdId,
        input: {
          workflow_id: workflowId,
          billing_hold_id: holdId,
        }
      }
    };
    const testError = new Error("Simulated worker process crash");

    // FIRST CALL
    await handleUseCaseWorkerFailure(failedJob, testError);

    const balanceAfterFirstCall = await mockWallet.getBalance(testUserId);
    assert.equal(balanceAfterFirstCall, initialBalance, "Balance should be restored to initial balance after first failure handling");

    // SECOND CALL (e.g. queue retry, duplicate event, process restart)
    await handleUseCaseWorkerFailure(failedJob, testError);

    const balanceAfterSecondCall = await mockWallet.getBalance(testUserId);
    assert.equal(
      balanceAfterSecondCall,
      initialBalance,
      "Balance MUST NOT be refunded a second time (must remain initialBalance)"
    );
  });

  it("TEST 2: walletWorker imports container to ensure boot assertions run", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync(new URL("../../src/workers/walletWorker.js", import.meta.url), "utf8");
    assert.ok(
      content.includes("container.js"),
      "walletWorker.js must import container.js to execute fail-fast boot assertions"
    );
  });
});
