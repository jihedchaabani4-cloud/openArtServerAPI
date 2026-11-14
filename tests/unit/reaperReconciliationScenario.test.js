import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileExpiredHolds, runReservationReaper } from "#billing/tools";

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
