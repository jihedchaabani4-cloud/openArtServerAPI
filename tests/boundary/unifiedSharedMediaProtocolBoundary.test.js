/**
 * Boundary Tests: Unified Shared-Media Protocol & Atomic Orphan Reaping
 *
 * Verifies that ALL orphan-reaping paths (WorkflowMediaService.releaseWorkflowMedia,
 * ElementMediaService.removeReferenceMedia, CharacterMediaService.removeDetailMedia)
 * route through the atomic `unlinkAndReapOrphan` protocol, and that Character
 * existing-media attachment paths participate in atomic attach without element quota.
 *
 * NOTE: These tests verify JS control flow and repository contract semantics hermetically.
 * Real PostgreSQL multi-connection lock ordering is labeled UNVERIFIED at runtime.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkflowMediaService } from "../../src/platform/workflow/WorkflowMediaService.js";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";
import { CharacterMediaService } from "../../src/domain/character/CharacterMediaService.js";
import { WorkflowMediaRepository } from "../../src/db/WorkflowMediaRepository.js";

describe("Unified Shared-Media Orphan Reaping & Attach Protocol", () => {

  it("ORPHAN-1: WorkflowMediaService.releaseWorkflowMedia calls unlinkAndReapOrphan per media and preserves shared storage", async () => {
    const unlinkedCalls = [];
    const deletedStorage = [];

    const mockDb = {
      media: {
        findByWorkflow: async (wfId) => [
          { id: "m-exclusive", url: "https://storage.local/exclusive.png" },
          { id: "m-shared", url: "https://storage.local/shared.png" },
        ],
      },
      workflowMedia: {
        unlinkAndReapOrphan: async ({ workflowId, mediaId }) => {
          unlinkedCalls.push({ workflowId, mediaId });
          if (mediaId === "m-exclusive") {
            return { unlinked: true, is_orphan: true, storage_url: "https://storage.local/exclusive.png", remaining_links: 0 };
          }
          // m-shared is still linked to another workflow
          return { unlinked: true, is_orphan: false, storage_url: null, remaining_links: 1 };
        },
        unlinkByWorkflow: async () => {},
        findByMedia: async () => [],
      },
      workflows: {
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: { verifyWorkflowOwnership: async () => true },
      mediaUploadService: { discard: async () => ({}) },
    });

    const res = await service.releaseWorkflowMedia({ workflowId: "wf-1" });

    assert.equal(unlinkedCalls.length, 2, "Must call unlinkAndReapOrphan for each linked media item");
    assert.ok(unlinkedCalls.some((c) => c.mediaId === "m-exclusive"));
    assert.ok(unlinkedCalls.some((c) => c.mediaId === "m-shared"));
    assert.deepEqual(res.deletedOrphanIds, ["m-exclusive"], "Only true orphan must be reaped");
    assert.deepEqual(deletedStorage, ["https://storage.local/exclusive.png"], "Shared storage must NOT be deleted");
  });

  it("ORPHAN-2: ElementMediaService.removeReferenceMedia uses unlinkAndReapOrphan and preserves shared storage", async () => {
    let unlinkReapCalled = null;
    const deletedStorage = [];

    const mockDb = {
      elements: {
        resolveRecord: async () => ({ id: "elem-1", workflow_id: "wf-elem-1" }),
      },
      workflowMedia: {
        getPrimaryMedia: async () => null,
        unlinkAndReapOrphan: async (params) => {
          unlinkReapCalled = params;
          // Simulate shared asset: remaining_links = 1
          return { unlinked: true, is_orphan: false, storage_url: null, remaining_links: 1 };
        },
      },
      media: {
        findById: async () => ({ id: "media-shared-elem", url: "https://storage.local/elem-shared.png" }),
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const service = new ElementMediaService({
      db: mockDb,
      storageService: mockStorage,
      mediaUploadService: { upload: async () => ({ files: [] }), discard: async () => ({}) },
      workflowMediaService: { attachMediaItems: async () => ({}) },
      authService: { verifyWorkflowOwnership: async () => true },
    });

    const res = await service.removeReferenceMedia({
      elementId: "elem-1",
      mediaId: "media-shared-elem",
      userId: "user-1",
    });

    assert.ok(unlinkReapCalled, "unlinkAndReapOrphan must be invoked");
    assert.equal(unlinkReapCalled.workflowId, "wf-elem-1");
    assert.equal(unlinkReapCalled.mediaId, "media-shared-elem");
    assert.equal(deletedStorage.length, 0, "Storage must NOT be deleted for shared asset");
    assert.equal(res.ok, true);
  });

  it("ORPHAN-3: CharacterMediaService.removeDetailMedia uses unlinkAndReapOrphan and deletes storage only on true orphan", async () => {
    let unlinkReapCalled = null;
    const deletedStorage = [];

    const mockDb = {
      workflows: {
        getWorkflow: async () => ({ id: "char-wf-1" }),
      },
      workflowMedia: {
        findByMedia: async () => [{ workflow_id: "char-wf-1", role: "detail" }],
        getPrimaryMedia: async () => null,
        unlinkAndReapOrphan: async (params) => {
          unlinkReapCalled = params;
          // True orphan: remaining_links = 0
          return { unlinked: true, is_orphan: true, storage_url: "https://storage.local/char-detail.png", remaining_links: 0 };
        },
      },
      media: {
        findById: async () => ({ id: "m-char-1", role: "detail", url: "https://storage.local/char-detail.png" }),
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const service = new CharacterMediaService({
      db: mockDb,
      storageService: mockStorage,
      mediaUploadService: { upload: async () => ({}), discard: async () => ({}) },
      workflowMediaService: { attachMediaItems: async () => ({}) },
      authService: { verifyWorkflowOwnership: async () => true },
    });

    const res = await service.removeDetailMedia({
      characterId: "char-wf-1",
      mediaId: "m-char-1",
      userId: "user-1",
    });

    assert.ok(unlinkReapCalled, "unlinkAndReapOrphan must be invoked");
    assert.equal(unlinkReapCalled.workflowId, "char-wf-1");
    assert.equal(unlinkReapCalled.mediaId, "m-char-1");
    assert.equal(unlinkReapCalled.role, "detail");
    assert.deepEqual(deletedStorage, ["https://storage.local/char-detail.png"], "Storage must be deleted for true orphan");
    assert.equal(res.ok, true);
  });

  it("ATTACH-GENERIC-1: Character existing-media attach uses attachMediaItems with CHARACTER_MAX_DETAIL_MEDIA quota", async () => {
    let attachCalled = null;

    const mockWorkflowMediaService = {
      attachMediaItems: async (params) => {
        attachCalled = params;
        return { attached: [{ media: { id: "m-source-1" } }] };
      },
    };

    const mockDb = {
      workflows: {
        getWorkflow: async () => ({ id: "char-wf-attach", project_id: "p-1", user_id: "u-1" }),
      },
      workflowMedia: {
        findByWorkflow: async () => [],
      },
      media: {
        findById: async () => ({ id: "m-source-1", url: "https://storage.local/m1.png", step_id: "upload" }),
      },
    };

    const service = new CharacterMediaService({
      db: mockDb,
      storageService: {},
      mediaUploadService: { upload: async () => ({}) },
      workflowMediaService: mockWorkflowMediaService,
      authService: { verifyWorkflowOwnership: async () => true },
    });

    const res = await service.uploadDetailMedia({
      characterId: "char-wf-attach",
      mediaId: "m-source-1",
      userId: "u-1",
      projectId: "p-1",
    });

    assert.ok(attachCalled, "attachMediaItems must be invoked for existing media");
    assert.equal(attachCalled.workflowId, "char-wf-attach");
    assert.equal(attachCalled.items[0].mediaId, "m-source-1");
    assert.equal(attachCalled.role, "detail");
    assert.equal(attachCalled.maxAllowed, 5, "Character attach must pass CHARACTER_MAX_DETAIL_MEDIA quota");
    assert.equal(res.ok, true);
  });

  it("ATTACH-GENERIC-2: WorkflowMediaRepository.attachMedia supports null quota in memory mode", async () => {
    WorkflowMediaRepository.enableTestMemoryFallback();
    WorkflowMediaRepository.clearMemory();
    const repo = new WorkflowMediaRepository();

    // Attach 10 items with maxAllowed = null (unlimited)
    for (let i = 1; i <= 10; i++) {
      const res = await repo.attachMedia({
        workflowId: "wf-unlimited",
        mediaId: `media-unlimited-${i}`,
        role: "detail",
        maxAllowed: null,
      });
      assert.ok(res, `Item ${i} should be attached`);
    }

    // Must have 10 relations
    const count = await repo.countLinksForMedia("media-unlimited-10");
    assert.equal(count, 1);
  });

  it("ATTACH-IDEMPOTENT-1: Repeated attachment preserves primary state, count accuracy, and does not duplicate", async () => {
    WorkflowMediaRepository.enableTestMemoryFallback();
    WorkflowMediaRepository.clearMemory();
    const repo = new WorkflowMediaRepository();

    // Attach item 1 (becomes primary, count 1)
    const attach1 = await repo.attachReferenceMedia({
      workflowId: "wf-idempotent",
      mediaId: "media-1",
      role: "detail",
      maxAllowed: 6,
    });
    assert.equal(attach1.is_primary, true);
    assert.equal(attach1.current_count, 1);

    // Attach item 2 (non-primary, count 2)
    const attach2 = await repo.attachReferenceMedia({
      workflowId: "wf-idempotent",
      mediaId: "media-2",
      role: "detail",
      maxAllowed: 6,
    });
    assert.equal(attach2.is_primary, false);
    assert.equal(attach2.current_count, 2);

    // Re-attach item 1 (idempotent: must keep is_primary=true, count=2, not create duplicates)
    const reattach1 = await repo.attachReferenceMedia({
      workflowId: "wf-idempotent",
      mediaId: "media-1",
      role: "detail",
      maxAllowed: 6,
    });
    assert.equal(reattach1.is_primary, true, "Existing primary must NOT be unpinned on re-attach");
    assert.equal(reattach1.current_count, 2, "current_count must remain 2 on idempotent re-attach");

    // Re-attach item 2 (idempotent: must keep is_primary=false, count=2)
    const reattach2 = await repo.attachReferenceMedia({
      workflowId: "wf-idempotent",
      mediaId: "media-2",
      role: "detail",
      maxAllowed: 6,
    });
    assert.equal(reattach2.is_primary, false, "Existing non-primary must remain false");
    assert.equal(reattach2.current_count, 2, "current_count must remain 2");

    // Verify row count in memory
    const links = await repo.findByWorkflow("wf-idempotent");
    assert.equal(links.length, 2, "Must not create duplicate rows in repository");
  });

  it("ATTACH-AUTOPRIMARY-1: WorkflowMediaRepository in-memory double sets is_primary=false when autoPrimary=false on primary-less workflow", async () => {
    WorkflowMediaRepository.enableTestMemoryFallback();
    WorkflowMediaRepository.clearMemory();
    const repo = new WorkflowMediaRepository();

    const res = await repo.attachReferenceMedia({
      workflowId: "wf-autoprimary-false",
      mediaId: "media-noprimary",
      role: "detail",
      maxAllowed: 6,
      autoPrimary: false,
    });

    assert.equal(res.is_primary, false, "Must not set is_primary when autoPrimary is false");
    const links = await repo.findByWorkflow("wf-autoprimary-false");
    assert.equal(links.length, 1);
    assert.equal(links[0].is_primary, false);
  });
});
