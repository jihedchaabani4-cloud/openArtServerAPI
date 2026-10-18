import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MediaWorkflowLifecycleService } from "../../src/platform/media/MediaLifecycleService.js";
import { runReservationReaper } from "../../src/workers/reservationReaperWorker.js";

describe("Ticket 05: Stale processing media reaper", () => {
  it("MediaWorkflowLifecycleService.sweepStalePlaceholders sweeps placeholders older than cutoff", async () => {
    const updatedMedia = [];
    const mockDb = {
      media: {
        findStalePlaceholders: async (cutoff) => [
          { id: "m-stale-1", status: "processing", create_time: "2026-01-01T00:00:00Z" },
          { id: "m-stale-2", status: "processing", create_time: "2026-01-01T01:00:00Z" },
        ],
        updateFields: async (id, fields) => {
          updatedMedia.push({ id, fields });
          return { id, ...fields };
        },
      },
    };

    const service = new MediaWorkflowLifecycleService({ db: mockDb });
    const swept = await service.sweepStalePlaceholders({ maxAgeMinutes: 30 });

    assert.equal(swept, 2, "Should sweep 2 stale placeholders");
    assert.equal(updatedMedia.length, 2);
    assert.equal(updatedMedia[0].id, "m-stale-1");
    assert.equal(updatedMedia[0].fields.status, "failed");
    assert.match(updatedMedia[0].fields.error_message, /timed out/i);
  });

  it("runReservationReaper invokes sweepStalePlaceholders when available", async () => {
    let sweepCalled = false;
    const mockWallet = {
      reapExpiredHolds: async () => [],
    };
    const mockLifecycle = {
      failForExpiredHold: async () => true,
      sweepStalePlaceholders: async () => {
        sweepCalled = true;
        return 1;
      },
    };

    await runReservationReaper({
      walletService: mockWallet,
      lifecycleService: mockLifecycle,
    });

    assert.equal(sweepCalled, true, "runReservationReaper must call sweepStalePlaceholders");
  });
});
