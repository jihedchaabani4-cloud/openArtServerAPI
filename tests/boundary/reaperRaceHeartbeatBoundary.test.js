import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { InMemoryWalletService } from "../../src/services/walletService.js";
import { WalletService } from "../../src/platform/billing/WalletService.js";
import { executeNodePersistence } from "../../src/v2/runner/nodeExecutor.js";
import { UseCaseService } from "../../src/services/useCaseService.js";
import { db } from "../../src/container.js";

describe("Reservation Reaper Race & Hold Heartbeat Boundary Tests (Task T10 / BUG-03)", () => {
  let originalFindByWorkflow;
  let originalUpdateMedia;
  let originalUpdateFields;
  let updatedCalls = [];

  after(() => {
    setTimeout(() => process.exit(0), 100);
  });

  beforeEach(() => {
    updatedCalls = [];
    originalFindByWorkflow = db.media?.findByWorkflow;
    originalUpdateMedia = db.media?.updateMedia;
    originalUpdateFields = db.media?.updateFields;
  });

  afterEach(() => {
    if (db.media) {
      db.media.findByWorkflow = originalFindByWorkflow;
      db.media.updateMedia = originalUpdateMedia;
      db.media.updateFields = originalUpdateFields;
    }
  });

  it("TEST 1: InMemoryWalletService.extendHold extends reservation TTL and rejects non-held reservations", async () => {
    const wallet = new InMemoryWalletService();
    await wallet.setBalance("user-hb-1", 100);

    const res = await wallet.reserve({
      userId: "user-hb-1",
      amount: 20,
      metadata: { workflowId: "wf-hb-1" },
    });

    const initialExpiresAtMs = res.expiresAtMs;
    assert.ok(typeof wallet.extendHold === "function", "wallet.extendHold must be implemented");

    // Extend by 300 seconds (5 minutes)
    const extended = await wallet.extendHold(res.reservationId, 300);
    assert.ok(
      extended.expiresAtMs >= initialExpiresAtMs + 300_000 - 100,
      `Expected expiresAtMs to increase by ~300,000ms, got ${extended.expiresAtMs - initialExpiresAtMs}`
    );

    // Commit reservation
    await wallet.commit(res.reservationId);

    // Extending committed reservation must throw
    await assert.rejects(
      async () => wallet.extendHold(res.reservationId, 300),
      /Cannot extend hold in status "committed"/,
      "Cannot extend a non-held reservation"
    );
  });

  it("TEST 2: executeNodePersistence must NEVER overwrite a terminal 'failed' placeholder (prevent free media resurrection)", async () => {
    const workflowId = "wf-race-test-2";
    const targetStepId = "video_generation";

    // Media was already reaped and marked failed
    const mediaList = [
      {
        id: "media-reaped-1",
        workflow_id: workflowId,
        step_id: targetStepId,
        status: "failed",
        error_message: "Generation execution timed out. Your credits have been refunded.",
      },
    ];

    db.media.findByWorkflow = async (wfId) => mediaList.filter((m) => m.workflow_id === wfId);
    db.media.updateMedia = async (id, patch) => {
      updatedCalls.push({ id, ...patch });
      return { id, ...patch };
    };

    const nodeConfig = {
      id: "generate_video",
      type: "video-generation",
      persist: {
        target: "media",
        step_id: targetStepId,
        status: "completed",
        value: "$outputs.assets[0].url",
      },
    };

    const output = { assets: [{ url: "https://storage.example.com/free-video.mp4" }] };
    const run = { input: { workflow_id: workflowId } };

    // BUG-03 DEFECT: Previously nodeExecutor picked existingList[0] and updated status: 'completed'!
    await assert.rejects(
      async () => {
        await executeNodePersistence({ nodeConfig, output, run });
      },
      (err) => {
        assert.ok(
          err.code === "HOLD_EXPIRED" || err.code === "PERSISTENCE_FAILED",
          `Expected HOLD_EXPIRED or PERSISTENCE_FAILED, got ${err.code}`
        );
        return true;
      },
      "executeNodePersistence must refuse to overwrite a 'failed' placeholder"
    );

    // Verify media record was NEVER updated to completed
    const completedUpdate = updatedCalls.find((c) => c.status === "completed");
    assert.strictEqual(completedUpdate, undefined, "Media status must NEVER be resurrected to completed");
  });

  it("TEST 3: UseCaseService maintains an active hold heartbeat during workflow execution", async () => {
    const wallet = new InMemoryWalletService();
    await wallet.setBalance("user-hb-3", 100);

    const res = await wallet.reserve({
      userId: "user-hb-3",
      amount: 15,
      metadata: { workflowId: "wf-hb-3" },
    });

    let heartbeatCount = 0;
    const originalExtend = wallet.extendHold?.bind(wallet);
    wallet.extendHold = async (holdId, seconds) => {
      heartbeatCount++;
      if (originalExtend) return originalExtend(holdId, seconds);
      return res;
    };

    const ucService = new UseCaseService({
      walletService: wallet,
      db,
      jobQueueService: { enqueueUseCase: async () => ({ id: "job-1" }) },
    });

    // Trigger heartbeat with short interval
    const heartbeatPromise = ucService.startHoldHeartbeat(res.reservationId, { intervalMs: 25, extensionSeconds: 300 });

    // Wait deterministically for heartbeat to fire
    const startWait = Date.now();
    while (heartbeatCount < 2 && Date.now() - startWait < 400) {
      await new Promise((r) => setTimeout(r, 20));
    }
    heartbeatPromise.stop();

    assert.ok(heartbeatCount >= 1, `Expected heartbeat to trigger at least once, got ${heartbeatCount}`);
  });

  it("TEST 4: Settling an expired hold throws ReservationExpiredError without crashing process", async () => {
    const wallet = new InMemoryWalletService();
    await wallet.setBalance("user-hb-4", 100);

    const res = await wallet.reserve({
      userId: "user-hb-4",
      amount: 25,
      metadata: { workflowId: "wf-hb-4" },
    });

    // Hold is reaped/released
    await wallet.release(res.reservationId, { reason: "ttl_expired" });

    const ucService = new UseCaseService({
      walletService: wallet,
      db,
      jobQueueService: { enqueueUseCase: async () => ({ id: "job-1" }) },
    });

    // Attempting to settle an already-expired hold must cleanly throw
    await assert.rejects(
      async () => {
        await ucService.settlePreparedBilling(res.reservationId, { totalCost: 25 });
      },
      (err) => {
        assert.ok(
          err.code === "RESERVATION_EXPIRED" || err.message?.includes("expired") || err.message?.includes("status"),
          `Expected expired reservation error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("TEST 5: Video generation workflows configure a 30-minute hold TTL (1800 seconds)", async () => {
    const ucService = new UseCaseService({ db });
    assert.strictEqual(typeof ucService.getHoldTTLForUseCase, "function", "getHoldTTLForUseCase must be defined");

    const videoTTL = ucService.getHoldTTLForUseCase("video-generation-v1");
    const imageTTL = ucService.getHoldTTLForUseCase("image-generation-v1");

    assert.strictEqual(videoTTL, 1800, "Video generation hold TTL must be 1800 seconds (30 minutes)");
    assert.strictEqual(imageTTL, 600, "Standard image generation hold TTL must be 600 seconds (10 minutes)");
  });
});
