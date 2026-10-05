import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { InMemoryWalletService } from "../../src/services/walletService.js";
import { MediaWorkflowLifecycleService } from "../../src/platform/media/MediaLifecycleService.js";
import { runReservationReaper } from "../../src/workers/reservationReaperWorker.js";
import { mediaWorkflowLifecycleService, db } from "../../src/container.js";

describe("Reservation Reaper & Media Reconciliation Boundary Tests", () => {
  after(() => {
    setTimeout(() => process.exit(0), 50);
  });

  it("TEST 1: InMemoryWalletService stores workflowId and mediaId in hold metadata", async () => {
    const wallet = new InMemoryWalletService();
    await wallet.setBalance("user-1", 100);

    const res = await wallet.reserve({
      userId: "user-1",
      amount: 20,
      metadata: {
        workflowId: "wf-100",
        mediaId: "media-200",
      },
    });

    assert.equal(res.workflowId, "wf-100");
    assert.equal(res.mediaId, "media-200");
    assert.equal(res.status, "held");
    assert.equal(await wallet.getBalance("user-1"), 80);
  });

  it("TEST 2: reapExpiredHolds returns structured list of expired holds with correlation ids", async () => {
    const wallet = new InMemoryWalletService();
    await wallet.setBalance("user-2", 100);

    const res = await wallet.reserve({
      userId: "user-2",
      amount: 30,
      metadata: {
        workflowId: "wf-expired-1",
        mediaId: "media-expired-1",
      },
    });

    // Force expire the hold by setting expiresAtMs to past
    wallet.reservations.get(res.reservationId).expiresAtMs = Date.now() - 1000;

    const expired = await wallet.reapExpiredHolds();
    assert.equal(expired.length, 1);
    assert.equal(expired[0].holdId, res.reservationId);
    assert.equal(expired[0].workflowId, "wf-expired-1");
    assert.equal(expired[0].mediaId, "media-expired-1");
    assert.equal(expired[0].amount, 30);

    // Balance refunded
    assert.equal(await wallet.getBalance("user-2"), 100);
  });

  it("TEST 3: MediaWorkflowLifecycleService.failForExpiredHold marks media placeholder as failed", async () => {
    // Mock db with media repository
    let updatedMediaId = null;
    let updatedFields = null;

    const mockDb = {
      media: {
        findByWorkflow: async (wfId) => [
          { id: "media-999", workflow_id: wfId, status: "processing" },
        ],
        updateFields: async (id, fields) => {
          updatedMediaId = id;
          updatedFields = fields;
          return { id, ...fields };
        },
      },
    };

    const lifecycle = new MediaWorkflowLifecycleService({ db: mockDb });

    // 3a. Fail with explicit mediaId
    const ok1 = await lifecycle.failForExpiredHold({
      holdId: "hold-1",
      workflowId: "wf-999",
      mediaId: "media-999",
      reason: "Expired test",
    });

    assert.equal(ok1, true);
    assert.equal(updatedMediaId, "media-999");
    assert.equal(updatedFields.status, "failed");
    assert.equal(updatedFields.error_message, "Expired test");

    // 3b. Fail with workflowId only (reconciliation lookup)
    updatedMediaId = null;
    updatedFields = null;

    const ok2 = await lifecycle.failForExpiredHold({
      holdId: "hold-2",
      workflowId: "wf-999",
      reason: "Reconciliation lookup test",
    });

    assert.equal(ok2, true);
    assert.equal(updatedMediaId, "media-999");
    assert.equal(updatedFields.status, "failed");
    assert.equal(updatedFields.error_message, "Reconciliation lookup test");
  });

  it("TEST 4: runReservationReaper reconciles orphaned holds and marks media as failed", async () => {
    // Set up a mock in-memory hold that is expired
    const inMemoryWallet = (await import("../../src/services/walletService.js")).walletService;
    await inMemoryWallet.setBalance("user-reaper-test", 100);

    let failedHoldParam = null;
    const originalFail = mediaWorkflowLifecycleService.failForExpiredHold;
    mediaWorkflowLifecycleService.failForExpiredHold = async (params) => {
      failedHoldParam = params;
      return true;
    };

    try {
      const res = await inMemoryWallet.reserve({
        userId: "user-reaper-test",
        amount: 25,
        metadata: {
          workflowId: "wf-reaper-1",
          mediaId: "media-reaper-1",
        },
      });

      // Expire the hold
      inMemoryWallet.reservations.get(res.reservationId).expiresAtMs = Date.now() - 5000;

      const count = await runReservationReaper({ walletService: inMemoryWallet });
      assert.ok(count >= 1);
      assert.ok(failedHoldParam !== null);
      assert.equal(failedHoldParam.workflowId, "wf-reaper-1");
      assert.equal(failedHoldParam.mediaId, "media-reaper-1");
      assert.ok(failedHoldParam.reason.includes("timed out"));
    } finally {
      mediaWorkflowLifecycleService.failForExpiredHold = originalFail;
    }
  });
});

