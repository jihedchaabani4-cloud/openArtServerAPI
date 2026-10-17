import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkflowMediaService } from "../../src/platform/workflow/WorkflowMediaService.js";

/**
 * WM-T5: Delete and orphan rules.
 *
 * Rules under test:
 *  1. workflow_media relation rows are unlinked BEFORE the media row is deleted.
 *  2. Storage file is deleted only when media has no remaining workflow_media links (orphan).
 *  3. Storage file is NOT deleted when media is still linked to other workflows (shared).
 *  4. Cross-tenant: deleteMedia returns 404 (via verifyMediaOwnership = false).
 */
describe("WorkflowMediaService delete and orphan rules (WM-T5)", () => {

  /** Build a minimal service under test with injectable spy stubs */
  function makeService({
    mediaRec = { id: "media-1", url: "https://cdn.example.com/img.png" },
    countLinks = 0,       // remaining links AFTER unlink
    authorised = true,
  } = {}) {
    const calls = {
      unlink: [],
      deleteById: [],
      storageDelete: [],
      deleteGenRef: false,
      workflowFindById: [],
      workflowUpdatePrimary: [],
    };

    const db = {
      media: {
        findById: async () => mediaRec,
        deleteById: async (id) => { calls.deleteById.push(id); return { id }; },
        findByWorkflow: async () => [],
        client: () => ({
          from: () => ({
            delete: () => ({
              eq: () => Promise.resolve({ error: null }),
            }),
          }),
        }),
      },
      workflows: {
        findById: async (id) => { calls.workflowFindById.push(id); return { id, primary_media_id: "media-1" }; },
        deleteById: async () => ({}),
        updateFields: async () => ({}),
        updatePrimaryMedia: async (wfId, mid) => { calls.workflowUpdatePrimary.push({ wfId, mid }); return {}; },
      },
      workflowMedia: {
        findByMedia: async () => [{ workflow_id: "wf-1", media_id: "media-1" }],
        unlink: async (args) => { calls.unlink.push(args); },
        countLinksForMedia: async () => countLinks,
      },
    };

    const storageService = {
      deleteByUrl: async (url) => { calls.storageDelete.push(url); },
    };

    const authService = {
      verifyMediaOwnership: async () => authorised,
    };

    const service = new WorkflowMediaService({ db, storageService, authService });
    return { service, calls };
  }

  it("unlinks workflow_media relation before deleting media row (orphaned media — 0 links)", async () => {
    const { service, calls } = makeService({ countLinks: 0 });

    const result = await service.deleteMedia({ mediaId: "media-1", userId: "user-1" });

    assert.equal(result.deleted, true);
    // unlink must have been called with the correct mediaId
    assert.equal(calls.unlink.length, 1);
    assert.equal(calls.unlink[0].mediaId, "media-1");
    // media row deleted
    assert.deepEqual(calls.deleteById, ["media-1"]);
    // storage deleted because orphaned (0 remaining links after unlink)
    assert.deepEqual(calls.storageDelete, ["https://cdn.example.com/img.png"]);
  });

  it("does NOT delete storage file when media still has relation links (shared media)", async () => {
    const { service, calls } = makeService({ countLinks: 2 });

    const result = await service.deleteMedia({ mediaId: "media-1", userId: "user-1" });

    assert.equal(result.deleted, true);
    // unlink still called
    assert.equal(calls.unlink.length, 1);
    // media row still deleted (user asked for it)
    assert.deepEqual(calls.deleteById, ["media-1"]);
    // storage NOT deleted — other workflows still reference this file
    assert.deepEqual(calls.storageDelete, []);
  });

  it("returns 404 (throws CrudServiceError) when media belongs to another user", async () => {
    const { service } = makeService({ authorised: false });

    await assert.rejects(
      () => service.deleteMedia({ mediaId: "media-1", userId: "attacker" }),
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.equal(err.errorCode, "NOT_FOUND");
        return true;
      }
    );
  });

  it("unlink is called before deleteById (ordering guarantee)", async () => {
    const order = [];
    const mediaRec = { id: "media-1", url: "https://cdn.example.com/img.png" };

    const db = {
      media: {
        findById: async () => mediaRec,
        deleteById: async (id) => { order.push("deleteById"); return { id }; },
        findByWorkflow: async () => [],
        client: () => ({
          from: () => ({ delete: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
        }),
      },
      workflows: {
        findById: async () => ({ id: "wf-1", primary_media_id: null }),
        deleteById: async () => ({}),
        updatePrimaryMedia: async () => ({}),
      },
      workflowMedia: {
        findByMedia: async () => [{ workflow_id: "wf-1", media_id: "media-1" }],
        unlink: async () => { order.push("unlink"); },
        countLinksForMedia: async () => 0,
      },
    };

    const service = new WorkflowMediaService({
      db,
      storageService: { deleteByUrl: async () => {} },
      authService: { verifyMediaOwnership: async () => true },
    });

    await service.deleteMedia({ mediaId: "media-1", userId: "user-1" });

    assert.equal(order[0], "unlink", "unlink must happen before deleteById");
    assert.equal(order[1], "deleteById");
  });
});
