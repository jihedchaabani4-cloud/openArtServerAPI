import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleExpireStaleHolds } from "../../src/workers/walletWorker.js";
import { WorkflowMediaRepository } from "../../src/db/WorkflowMediaRepository.js";
import { WorkflowMediaService } from "../../src/platform/workflow/WorkflowMediaService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Ticket 07: BullMQ Reservation Reaper Worker & Media Deletion Concurrency Boundary Tests", () => {
  after(() => {
    setTimeout(() => process.exit(0), 50);
  });

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
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
    });

    const result = await service.deleteMedia({
      mediaId: "m-orphan",
      userId: "user-1",
    });

    assert.equal(result.deleted, true);
    assert.equal(await repo.countLinksForMedia("m-orphan"), 0);
    assert.equal(mediaStore.has("m-orphan"), false);
    assert.deepEqual(deletedStorage, ["https://storage.local/orphan.png"]);
  });

  it("TEST 5: Zero console.* calls in production worker, queue, and billing files", () => {
    const targetFiles = [
      "src/workers/walletWorker.js",
      "src/queue/walletQueue.js",
      "src/platform/billing/FailedOpsService.js",
      "src/platform/billing/PricingService.js",
      "src/platform/billing/UsageEventRepository.js",
    ];

    const violations = [];

    for (const relPath of targetFiles) {
      const fullPath = path.resolve(__dirname, "../../", relPath);
      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");

      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (/console\.(log|error|warn|info|debug)\(/.test(line)) {
          violations.push(`${relPath}:${index + 1}: ${trimmed}`);
        }
      });
    }

    assert.deepEqual(
      violations,
      [],
      `Found forbidden console.* calls:\n${violations.join("\n")}`
    );
  });
});
