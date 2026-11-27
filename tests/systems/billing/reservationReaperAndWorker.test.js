import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { InMemoryWalletService } from "../../helpers/inMemoryWalletService.js";
import { runReservationReaper, settleCredits, startWalletWorker, stopWalletWorker } from "#billing/tools";
import { WalletService } from "../../../src/systems/billing/internal/services/WalletService.js";
import { reconcileExpiredHolds, handleExpireStaleHolds } from "../../../src/systems/billing/internal/services/ReservationReaperService.js";
import { walletWorker } from "../../../src/systems/billing/internal/workers/walletWorker.js";
import { SaveMediaNode } from "../../../src/systems/workflow-engine/internal/nodes/index.js";
import { WorkflowMediaService } from "../../../src/systems/generation/internal/services/WorkflowMediaService.js";
import { db, mediaWorkflowLifecycleService } from "../../../src/container.js";
import { MediaWorkflowLifecycleService, WorkflowMediaRepository } from "#media/tools";

// ─── Source: reaperRaceHeartbeatBoundary.test.js ───
{
describe("Reservation Reaper Race & Hold Heartbeat Boundary Tests (Task T10 / BUG-03)", () => {
  let originalFindByWorkflow;
  let originalFindById;
  let originalUpdateMedia;
  let originalUpdateFields;
  let updatedCalls = [];


  beforeEach(() => {
    updatedCalls = [];
    originalFindByWorkflow = db.media?.findByWorkflow;
    originalFindById = db.media?.findById;
    originalUpdateMedia = db.media?.updateMedia;
    originalUpdateFields = db.media?.updateFields;
  });

  afterEach(() => {
    if (db.media) {
      db.media.findByWorkflow = originalFindByWorkflow;
      db.media.findById = originalFindById;
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

  it("TEST 2: SaveMediaNode must NEVER overwrite a terminal 'failed' placeholder (prevent free media resurrection)", async () => {
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
    db.media.findById = async (id) => mediaList.find((m) => m.id === id) || null;
    db.media.updateMedia = async (id, patch) => {
      updatedCalls.push({ id, ...patch });
      return { id, ...patch };
    };

    await assert.rejects(
      async () => {
        await SaveMediaNode.execute(
          {
            media_id: "media-reaped-1",
            asset_url: "https://storage.example.com/free-video.mp4",
          },
          { db, mediaRepository: db.media }
        );
      },
      (err) => {
        assert.ok(
          err.code === "HOLD_EXPIRED" || err.code === "PERSISTENCE_FAILED",
          `Expected HOLD_EXPIRED or PERSISTENCE_FAILED, got ${err.code}`
        );
        return true;
      },
      "SaveMediaNode must refuse to overwrite a 'failed' placeholder"
    );

    // Verify media record was NEVER updated to success/completed
    const completedUpdate = updatedCalls.find((c) => c.status === "success" || c.status === "completed");
    assert.strictEqual(completedUpdate, undefined, "Media status must NEVER be resurrected to success");
  });

  it("TEST 4: Settling an expired/released hold throws cleanly without crashing process", async () => {
    const wallet = new InMemoryWalletService();
    await wallet.setBalance("user-hb-4", 100);

    const res = await wallet.reserve({
      userId: "user-hb-4",
      amount: 25,
      metadata: { workflowId: "wf-hb-4" },
    });

    // Hold is reaped/released
    await wallet.release(res.reservationId, { reason: "ttl_expired" });

    // Attempting to settle an already-expired hold must cleanly throw
    await assert.rejects(
      async () => {
        await settleCredits(
          { referenceId: res.reservationId, metadata: { totalCost: 25 } },
          { walletService: wallet }
        );
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
});
}

// ─── Source: reaperReconciliationBoundary.test.js ───
{
describe("Reservation Reaper & Media Reconciliation Boundary Tests", () => {

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
    const inMemoryWallet = (await import("../../helpers/inMemoryWalletService.js")).walletService;
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
}

// ─── Source: reaperReconciliationScenario.test.js ───
{
describe("Stale Holds Reaper & Media Reconciliation Scenarios (Option 2)", () => {
    describe("1. Scenario: Server Cron wins race and reconciles media state", () => {
        it("expires holds and immediately marks associated media as failed", async () => {
            const expiredRecords = [
                {
                    holdId: "hold-uuid-1",
                    referenceId: "hold-uuid-1",
                    workflowId: "wf-1",
                    mediaId: "media-1",
                    amount: 5,
                    walletId: "wallet-1",
                },
                {
                    holdId: "hold-uuid-2",
                    referenceId: "hold-uuid-2",
                    workflowId: "wf-2",
                    mediaId: "media-2",
                    amount: 10,
                    walletId: "wallet-2",
                },
            ];

            const mockWallet = {
                reapExpiredHolds: async () => expiredRecords,
            };

            const failedCalls = [];
            const mockLifecycle = {
                failForExpiredHold: async (params) => {
                    failedCalls.push(params);
                    return true;
                },
            };

            const reaped = await reconcileExpiredHolds({
                walletService: mockWallet,
                lifecycleService: mockLifecycle,
            });

            assert.equal(reaped.length, 2);
            assert.equal(failedCalls.length, 2);
            assert.equal(failedCalls[0].holdId, "hold-uuid-1");
            assert.equal(failedCalls[0].workflowId, "wf-1");
            assert.equal(failedCalls[0].mediaId, "media-1");
            assert.equal(failedCalls[1].holdId, "hold-uuid-2");
            assert.equal(failedCalls[1].workflowId, "wf-2");
            assert.equal(failedCalls[1].mediaId, "media-2");
        });
    });

    describe("2. Scenario: Worker runs afterwards, finds 0 rows, does nothing", () => {
        it("completes cleanly without redundant failForExpiredHold calls", async () => {
            // Once cron expires the holds, subsequent query returns 0 holds
            const mockWallet = {
                reapExpiredHolds: async () => [],
            };

            let failCallCount = 0;
            let sweepCalled = false;
            const mockLifecycle = {
                failForExpiredHold: async () => {
                    failCallCount++;
                },
                sweepStalePlaceholders: async () => {
                    sweepCalled = true;
                },
            };

            const reapedCount = await runReservationReaper({
                walletService: mockWallet,
                lifecycleService: mockLifecycle,
            });

            assert.equal(reapedCount, 0);
            assert.equal(failCallCount, 0, "No media should be marked failed when 0 holds are returned");
            assert.equal(sweepCalled, true, "sweepStalePlaceholders is still invoked by worker");
        });
    });

    describe("3. Scenario: Individual row failure isolation", () => {
        it("continues processing remaining holds when failForExpiredHold throws for one row", async () => {
            const records = [
                {
                    holdId: "hold-faulty",
                    referenceId: "hold-faulty",
                    workflowId: "wf-faulty",
                    mediaId: "media-faulty",
                    amount: 5,
                },
                {
                    holdId: "hold-healthy",
                    referenceId: "hold-healthy",
                    workflowId: "wf-healthy",
                    mediaId: "media-healthy",
                    amount: 5,
                },
            ];

            const mockWallet = {
                reapExpiredHolds: async () => records,
            };

            const successfulFails = [];
            const mockLifecycle = {
                failForExpiredHold: async (params) => {
                    if (params.holdId === "hold-faulty") {
                        throw new Error("PostgreSQL lock contention error");
                    }
                    successfulFails.push(params);
                    return true;
                },
            };

            const warnings = [];
            const mockLogger = {
                warn: (meta, msg) => {
                    warnings.push({ meta, msg });
                },
                info: () => {},
                error: () => {},
            };

            // Must NOT throw
            const reaped = await reconcileExpiredHolds({
                walletService: mockWallet,
                lifecycleService: mockLifecycle,
                logger: mockLogger,
            });

            assert.equal(reaped.length, 2);
            assert.equal(successfulFails.length, 1);
            assert.equal(successfulFails[0].holdId, "hold-healthy");
            assert.equal(warnings.length, 1);
            assert.ok(warnings[0].msg.includes("Failed to mark media failed for expired hold hold-faulty"));
        });
    });

    describe("4. Scenario: Dev/test fallback when mediaWorkflowLifecycleService is unavailable", () => {
        it("safely releases holds without error when lifecycle service is null", async () => {
            const records = [
                {
                    holdId: "hold-dev-1",
                    referenceId: "hold-dev-1",
                    workflowId: "wf-dev-1",
                    amount: 3,
                },
            ];

            const mockWallet = {
                reapExpiredHolds: async () => records,
            };

            const reaped = await reconcileExpiredHolds({
                walletService: mockWallet,
                lifecycleService: null,
            });

            assert.equal(reaped.length, 1);
            assert.equal(reaped[0].holdId, "hold-dev-1");
        });
    });
});
}

// ─── Source: walletWorkerReaperReconciliationBoundary.test.js ───
{
describe("Ticket 07: BullMQ Reservation Reaper Worker & Media Deletion Concurrency Boundary Tests", () => {

  beforeEach(() => {
    WorkflowMediaRepository.enableTestMemoryFallback();
  });

  it("TEST 1: handleExpireStaleHolds invokes reaper and reconciles both expired hold and placeholder media", async () => {
    const failedHolds = [];
    let sweptPlaceholders = false;

    const mockWallet = {
      reapExpiredHolds: async () => [
        {
          holdId: "hold-expired-100",
          referenceId: "hold-expired-100",
          workflowId: "wf-100",
          mediaId: "media-100",
          amount: 25,
        },
      ],
      expireStaleHolds: async () => 1,
    };

    const mockLifecycle = {
      failForExpiredHold: async (params) => {
        failedHolds.push(params);
        return true;
      },
      sweepStalePlaceholders: async () => {
        sweptPlaceholders = true;
        return { sweptCount: 0 };
      },
    };

    const reapedCount = await handleExpireStaleHolds({
      walletService: mockWallet,
      lifecycleService: mockLifecycle,
    });

    assert.equal(reapedCount, 1);
    assert.equal(failedHolds.length, 1);
    assert.equal(failedHolds[0].holdId, "hold-expired-100");
    assert.equal(failedHolds[0].workflowId, "wf-100");
    assert.equal(failedHolds[0].mediaId, "media-100");
    assert.match(failedHolds[0].reason, /timed out/i);
    assert.equal(sweptPlaceholders, true);
  });

  it("TEST 2: handleExpireStaleHolds isolates individual hold reconciliation errors and completes the sweep", async () => {
    const attempted = [];
    let sweptPlaceholders = false;

    const mockWallet = {
      reapExpiredHolds: async () => [
        {
          holdId: "hold-flaky-1",
          referenceId: "hold-flaky-1",
          workflowId: "wf-flaky",
          mediaId: "media-flaky",
          amount: 10,
        },
        {
          holdId: "hold-healthy-2",
          referenceId: "hold-healthy-2",
          workflowId: "wf-healthy",
          mediaId: "media-healthy",
          amount: 15,
        },
      ],
    };

    const mockLifecycle = {
      failForExpiredHold: async (params) => {
        attempted.push(params.holdId);
        if (params.holdId === "hold-flaky-1") {
          throw new Error("Simulated transient lifecycle failure");
        }
        return true;
      },
      sweepStalePlaceholders: async () => {
        sweptPlaceholders = true;
        return { sweptCount: 0 };
      },
    };

    const reapedCount = await handleExpireStaleHolds({
      walletService: mockWallet,
      lifecycleService: mockLifecycle,
    });

    assert.equal(reapedCount, 2);
    assert.deepEqual(attempted, ["hold-flaky-1", "hold-healthy-2"]);
    assert.equal(sweptPlaceholders, true);
  });

  it("TEST 3: WorkflowMediaRepository.unlink safely deletes relations by mediaId alone when workflowId is omitted", async () => {
    const repo = new WorkflowMediaRepository();

    await repo.linkMedia({
      workflowId: "wf-a",
      mediaId: "m-target",
      role: "output",
    });
    await repo.linkMedia({
      workflowId: "wf-b",
      mediaId: "m-target",
      role: "reference",
    });
    await repo.linkMedia({
      workflowId: "wf-c",
      mediaId: "m-keep",
      role: "output",
    });

    assert.equal(await repo.countLinksForMedia("m-target"), 2);
    assert.equal(await repo.countLinksForMedia("m-keep"), 1);

    // Call unlink with only mediaId (as WorkflowMediaService.deleteMedia does)
    await repo.unlink({ mediaId: "m-target" });

    assert.equal(await repo.countLinksForMedia("m-target"), 0);
    assert.equal(await repo.countLinksForMedia("m-keep"), 1);
  });

  it("TEST 4: WorkflowMediaService.deleteMedia unlinks workflow_media rows and deletes storage file for orphaned media", async () => {
    const repo = new WorkflowMediaRepository();
    const mediaStore = new Map([
      ["m-orphan", { id: "m-orphan", url: "https://storage.local/orphan.png" }],
    ]);
    const deletedStorage = [];

    await repo.linkMedia({
      workflowId: "wf-1",
      mediaId: "m-orphan",
      role: "output",
    });

    const mockDb = {
      media: {
        findById: async (id) => mediaStore.get(id) || null,
        deleteById: async (id) => {
          const row = mediaStore.get(id);
          mediaStore.delete(id);
          return row;
        },
        findByWorkflow: async () => [],
        client: () => ({
          from: () => ({
            delete: () => ({
              eq: async () => ({ error: null }),
            }),
          }),
        }),
      },
      workflows: {
        findById: async () => null,
      },
      workflowMedia: repo,
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyMediaOwnership: async () => true,
      verifyWorkflowOwnership: async () => true,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    const result = await service.deleteMedia({
      mediaId: "m-orphan",
      workflowId: "wf-1",
      userId: "user-1",
    });

    assert.equal(result.deleted, true);
    assert.equal(await repo.countLinksForMedia("m-orphan"), 0);
    assert.equal(mediaStore.has("m-orphan"), false);
    assert.deepEqual(deletedStorage, ["https://storage.local/orphan.png"]);
  });

  describe("P1-5: walletWorker zero import-time side effects & explicit idempotent startWalletWorker()", () => {
    afterEach(async () => {
      await stopWalletWorker();
    });

    it("has zero import-time side effects (walletWorker is null before startWalletWorker is called)", () => {
      assert.equal(walletWorker, null, "Importing #billing/tools must NOT auto-start walletWorker");
    });

    it("startWalletWorker() starts cleanly, registers handlers & schedules once, is idempotent, and cleans up on stopWalletWorker()", async () => {
      let constructedCount = 0;
      let scheduleCount = 0;
      let closedCount = 0;
      let capturedQueueName = null;
      let capturedProcessor = null;

      class FakeWorker extends EventEmitter {
        constructor(queueName, processor, opts) {
          super();
          constructedCount++;
          capturedQueueName = queueName;
          capturedProcessor = processor;
          this.opts = opts;
        }
        async close() {
          closedCount++;
        }
      }

      const beforeSigint = process.listenerCount("SIGINT");
      const beforeSigterm = process.listenerCount("SIGTERM");

      const started1 = await startWalletWorker({
        WorkerClass: FakeWorker,
        scheduleJobs: async () => {
          scheduleCount++;
        },
        registerShutdownHooks: true,
      });

      assert.equal(constructedCount, 1);
      assert.equal(scheduleCount, 1);
      assert.equal(capturedQueueName, "wallet-maintenance");
      assert.equal(typeof capturedProcessor, "function");
      assert.ok(started1.listenerCount("completed") >= 1);
      assert.ok(started1.listenerCount("failed") >= 1);
      assert.ok(started1.listenerCount("error") >= 1);
      assert.equal(process.listenerCount("SIGINT"), beforeSigint + 1);
      assert.equal(process.listenerCount("SIGTERM"), beforeSigterm + 1);

      // Idempotent second call returns the same instance with zero duplicate workers/schedules/listeners
      const started2 = await startWalletWorker({
        WorkerClass: FakeWorker,
        scheduleJobs: async () => {
          scheduleCount++;
        },
        registerShutdownHooks: true,
      });

      assert.strictEqual(started2, started1, "Second startWalletWorker() call must be idempotent");
      assert.equal(constructedCount, 1);
      assert.equal(scheduleCount, 1);
      assert.equal(process.listenerCount("SIGINT"), beforeSigint + 1);
      assert.equal(process.listenerCount("SIGTERM"), beforeSigterm + 1);

      await stopWalletWorker();
      assert.equal(closedCount, 1);
      assert.equal(process.listenerCount("SIGINT"), beforeSigint);
      assert.equal(process.listenerCount("SIGTERM"), beforeSigterm);
    });
  });
});
}
after(() => {
  setTimeout(() => process.exit(0), 100);
});
