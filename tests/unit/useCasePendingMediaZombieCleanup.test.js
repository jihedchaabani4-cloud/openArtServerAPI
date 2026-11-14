import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { UseCaseService } from "#generation/tools";
import { registerAllUseCases } from "#generation/tools";

describe("Sprint R2: UseCase Pending Media Zombie Cleanup", () => {
  before(() => {
    registerAllUseCases();
  });

  it("when queue.addUseCaseJob throws, both the credit hold is released AND pending media rows are marked failed", async () => {
    let rollbackCalledWith = null;
    const updatedMedia = [];

    const mockBillingRuntime = {
      reserveUseCase: async () => ({
        billingHoldId: "hold-test-123",
        billingStatus: "reserved",
        reservedCredits: 50,
      }),
      rollbackUseCase: async (holdId, meta) => {
        rollbackCalledWith = { holdId, meta };
      },
    };

    const mockQueue = {
      addUseCaseJob: async () => {
        throw new Error("Redis cluster connection lost during dispatch");
      },
    };

    const mockDb = {
      media: {
        updateMedia: async (mediaId, fields) => {
          updatedMedia.push({ mediaId, fields });
          return { id: mediaId, ...fields };
        },
      },
    };

    const service = new UseCaseService({
      billingRuntime: mockBillingRuntime,
      jobQueueService: mockQueue,
      db: mockDb,
    });

    const serverMediaIds = ["media-pending-1", "media-pending-2"];
    let caughtError = null;

    try {
      await service.prepareAndEnqueue({
        useCaseId: "image-generation-v1",
        input: {
          prompt: "A neon cyborg cat",
          model: "gemini-3.1-flash-lite",
          serverMediaIds,
          serverWorkflowId: "wf-test-1",
        },
        userId: "user-1",
        serverContext: {
          workflowId: "wf-test-1",
          mediaIds: serverMediaIds,
        },
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, "prepareUseCaseJob should throw when queue dispatch fails");
    assert.equal(caughtError.code, "QUEUE_DISPATCH_FAILED");
    assert.equal(caughtError.statusCode, 503);

    // Verify hold was released
    assert.ok(rollbackCalledWith, "Credit hold must be released on queue dispatch failure");
    assert.equal(rollbackCalledWith.holdId, "hold-test-123");
    assert.equal(rollbackCalledWith.meta.errorCategory, "QUEUE_DISPATCH_FAILED");

    // Verify pending media rows were marked failed
    assert.equal(updatedMedia.length, 2, "All pending media rows must be marked failed");
    assert.equal(updatedMedia[0].mediaId, "media-pending-1");
    assert.equal(updatedMedia[0].fields.status, "failed");
    assert.match(updatedMedia[0].fields.error_message, /Queue dispatch failed/);
    assert.equal(updatedMedia[1].mediaId, "media-pending-2");
    assert.equal(updatedMedia[1].fields.status, "failed");
  });

  it("when standalone generation fails with workflowId = null, pending serverMediaIds are marked failed", async () => {
    let rollbackCalled = false;
    const updatedMedia = [];

    const mockBillingRuntime = {
      rollbackUseCase: async () => {
        rollbackCalled = true;
      },
    };

    const mockDb = {
      media: {
        updateMedia: async (mediaId, fields) => {
          updatedMedia.push({ mediaId, fields });
          return { id: mediaId, ...fields };
        },
      },
    };

    const service = new UseCaseService({
      billingRuntime: mockBillingRuntime,
      db: mockDb,
    });

    // Mock runUseCase to simulate worker failure
    service.runUseCase = async () => {
      throw new Error("Provider GPU timeout during rendering");
    };

    let caughtError = null;
    try {
      await service.executeQueuedUseCase({
        useCaseId: "image-generation-v1",
        input: {
          serverMediaIds: ["media-standalone-1", "media-standalone-2"],
          billing_hold_id: "hold-standalone-99",
          reserved_credits: 20,
        },
        userId: "user-2",
        billingHoldId: "hold-standalone-99",
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, "executeQueuedUseCase should re-throw execution error");
    assert.ok(rollbackCalled, "Hold must be rolled back on standalone failure");

    // Verify standalone pending media marked as failed
    assert.equal(updatedMedia.length, 2, "Both standalone media rows must be marked failed");
    assert.equal(updatedMedia[0].mediaId, "media-standalone-1");
    assert.equal(updatedMedia[0].fields.status, "failed");
    assert.equal(updatedMedia[1].mediaId, "media-standalone-2");
    assert.equal(updatedMedia[1].fields.status, "failed");
  });
});
