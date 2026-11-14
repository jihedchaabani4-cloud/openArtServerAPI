import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { WorkflowMediaService } from "#generation/tools";
import { WorkflowMediaRepository } from "#media/tools";

/**
 * Concurrency Safety & Orphan Cleanup Boundary Tests
 *
 * Tests the race conditions identified in the verification audit:
 * 1. Two concurrent unlink requests for the same media.
 * 2. An attach racing with the final unlink and orphan cleanup.
 * 3. An attach completing before cleanup starts.
 * 4. The existing shared-media invariant: deleting workflow A's association preserves workflow B's association and asset.
 * 5. A genuine orphan being cleaned up exactly once.
 */
describe("Shared-Media Concurrency Safety & Atomic Orphan Cleanup", () => {
  beforeEach(() => {
    WorkflowMediaRepository.enableTestMemoryFallback();
    WorkflowMediaRepository.clearMemory();
  });

  it("TEST 1: Two concurrent unlinks of the same media execute safely and reap storage exactly once", async () => {
    const repo = new WorkflowMediaRepository();
    const mediaId = "media-concurrent-1";
    const wfId = "wf-concurrent-1";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-concurrent-1.png";

    await repo.linkMedia({ workflowId: wfId, mediaId, role: "output" });

    const deletedStorage = [];
    const mediaStore = new Map([[mediaId, { id: mediaId, url: storageUrl }]]);

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async (id) => mediaStore.get(id) || null,
        deleteById: async (id) => {
          mediaStore.delete(id);
          return { id };
        },
        findByWorkflow: async () => [],
      },
      workflows: {
        findById: async () => ({ id: wfId, primary_media_id: null }),
        deleteById: async () => {},
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        // Simulate real network latency on storage delete
        await new Promise((resolve) => setTimeout(resolve, 10));
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyWorkflowOwnership: async () => true,
      verifyMediaOwnership: async () => true,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    // Fire two simultaneous deleteMedia requests for the exact same media
    const [res1, res2] = await Promise.all([
      service.deleteMedia({ workflowId: wfId, mediaId, userId }),
      service.deleteMedia({ workflowId: wfId, mediaId, userId }),
    ]);

    // Storage file must be deleted EXACTLY ONCE
    assert.equal(
      deletedStorage.length,
      1,
      `Storage file must be deleted exactly once across concurrent unlinks, but was deleted ${deletedStorage.length} times`
    );

    // Exactly one call should report having deleted the media record
    const deleteSuccessCount = [res1.deleted, res2.deleted].filter(Boolean).length;
    assert.equal(
      deleteSuccessCount,
      1,
      `Exactly one caller must report deleted=true, but ${deleteSuccessCount} did`
    );
  });

  it("TEST 2: An attach racing with the final unlink preserves the media row and storage asset", async () => {
    const repo = new WorkflowMediaRepository();
    const mediaId = "media-race-attach";
    const wfA = "wf-race-a";
    const wfB = "wf-race-b";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-race-attach.png";

    // Media initially linked only to wfA
    await repo.linkMedia({ workflowId: wfA, mediaId, role: "output" });

    const deletedStorage = [];
    const mediaStore = new Map([[mediaId, { id: mediaId, url: storageUrl }]]);

    // Hook unlink to simulate a concurrent attach occurring during the unlink process
    const originalUnlink = repo.unlink.bind(repo);
    let attachDone = false;

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async (id) => mediaStore.get(id) || null,
        deleteById: async (id) => {
          mediaStore.delete(id);
          return { id };
        },
        findByWorkflow: async () => [],
      },
      workflows: {
        findById: async () => ({ id: wfA, primary_media_id: null }),
        deleteById: async () => {},
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyWorkflowOwnership: async () => true,
      verifyMediaOwnership: async () => true,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    // Simulate concurrent attach to Workflow B racing with the unlink-and-reap operation
    const originalReap = repo.unlinkAndReapOrphan.bind(repo);
    repo.unlinkAndReapOrphan = async (args) => {
      // Concurrent attach races in: Workflow B establishes its association
      await repo.linkMedia({ workflowId: wfB, mediaId, role: "reference" });
      attachDone = true;
      return originalReap(args);
    };

    const result = await service.deleteMedia({ workflowId: wfA, mediaId, userId });

    // Since Workflow B attached the media, it is NOT an orphan
    assert.equal(attachDone, true, "Concurrent attach must have executed");
    assert.equal(result.deleted, false, "Media must NOT be reported as deleted when racing attach references it");
    assert.equal(deletedStorage.length, 0, "Storage file must NOT be deleted when a concurrent attach holds a reference");
    assert.equal(mediaStore.has(mediaId), true, "Media database row must remain in media table");

    const linksB = await repo.findByWorkflow(wfB);
    assert.equal(linksB.some((r) => r.media_id === mediaId), true, "Workflow B must still hold active association");
  });

  it("TEST 3: An attach completing before cleanup starts preserves shared media", async () => {
    const repo = new WorkflowMediaRepository();
    const mediaId = "media-attach-before";
    const wfA = "wf-ab-1";
    const wfB = "wf-ab-2";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-attach-before.png";

    await repo.linkMedia({ workflowId: wfA, mediaId, role: "output" });
    await repo.linkMedia({ workflowId: wfB, mediaId, role: "detail" });

    const deletedStorage = [];
    const mediaStore = new Map([[mediaId, { id: mediaId, url: storageUrl }]]);

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async (id) => mediaStore.get(id) || null,
        deleteById: async (id) => {
          mediaStore.delete(id);
          return { id };
        },
        findByWorkflow: async () => [],
      },
      workflows: {
        findById: async () => ({ id: wfA, primary_media_id: null }),
        deleteById: async () => {},
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyWorkflowOwnership: async () => true,
      verifyMediaOwnership: async () => true,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    const result = await service.deleteMedia({ workflowId: wfA, mediaId, userId });

    assert.equal(result.deleted, false);
    assert.equal(deletedStorage.length, 0);
    assert.equal(mediaStore.has(mediaId), true);
    assert.equal(await repo.countLinksForMedia(mediaId), 1);
  });

  it("TEST 4: Removing workflow A's association preserves workflow B's association and asset", async () => {
    const repo = new WorkflowMediaRepository();
    const mediaId = "media-shared-preserve";
    const wfA = "wf-preserve-a";
    const wfB = "wf-preserve-b";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-shared-preserve.png";

    await repo.linkMedia({ workflowId: wfA, mediaId, role: "output" });
    await repo.linkMedia({ workflowId: wfB, mediaId, role: "reference" });

    const deletedStorage = [];
    const mediaStore = new Map([[mediaId, { id: mediaId, url: storageUrl }]]);

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async (id) => mediaStore.get(id) || null,
        deleteById: async (id) => {
          mediaStore.delete(id);
          return { id };
        },
        findByWorkflow: async () => [],
      },
      workflows: {
        findById: async () => ({ id: wfA, primary_media_id: null }),
        deleteById: async () => {},
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyWorkflowOwnership: async () => true,
      verifyMediaOwnership: async () => true,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    const result = await service.deleteMedia({ workflowId: wfA, mediaId, userId });

    assert.equal(result.deleted, false);
    assert.equal(deletedStorage.length, 0);
    assert.equal(mediaStore.has(mediaId), true);

    const wfBLinks = await repo.findByWorkflow(wfB);
    assert.equal(wfBLinks.some((l) => l.media_id === mediaId), true);

    const wfALinks = await repo.findByWorkflow(wfA);
    assert.equal(wfALinks.some((l) => l.media_id === mediaId), false);
  });

  it("TEST 5: A genuine orphan is cleaned up exactly once and storage is deleted", async () => {
    const repo = new WorkflowMediaRepository();
    const mediaId = "media-orphan-clean";
    const wfA = "wf-orphan-only";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-orphan-clean.png";

    await repo.linkMedia({ workflowId: wfA, mediaId, role: "output" });

    const deletedStorage = [];
    const mediaStore = new Map([[mediaId, { id: mediaId, url: storageUrl }]]);

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async (id) => mediaStore.get(id) || null,
        deleteById: async (id) => {
          mediaStore.delete(id);
          return { id };
        },
        findByWorkflow: async () => [],
      },
      workflows: {
        findById: async () => ({ id: wfA, primary_media_id: null }),
        deleteById: async () => {},
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyWorkflowOwnership: async () => true,
      verifyMediaOwnership: async () => true,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    const result = await service.deleteMedia({ workflowId: wfA, mediaId, userId });

    assert.equal(result.deleted, true);
    assert.deepEqual(deletedStorage, [storageUrl]);
    assert.equal(mediaStore.has(mediaId), false);
    assert.equal(await repo.countLinksForMedia(mediaId), 0);
  });
});
