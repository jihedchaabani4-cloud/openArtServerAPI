import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkflowMediaService } from "../../src/platform/workflow/WorkflowMediaService.js";
import { ElementService } from "../../src/domain/element/ElementService.js";
import { ElementRepository } from "../../src/db/ElementRepository.js";
import { CharacterService } from "../../src/domain/character/CharacterService.js";

/**
 * WM-T5 & B4a: Delete, orphan rules, and sidecar preservation.
 *
 * Rules under test:
 *  1. workflow_media relation rows are unlinked BEFORE the media row is deleted.
 *  2. Storage file is deleted only when media has no remaining workflow_media links (orphan).
 *  3. Storage file is NOT deleted when media is still linked to other workflows (shared).
 *  4. Cross-tenant: deleteMedia returns 404 (via verifyMediaOwnership = false).
 *  5. B4a: Deleting the last media of a workflow preserves the workflow container if a character or element sidecar is attached.
 *  6. B4a: Explicit user DELETE of element or character still deletes the sidecar and releases/deletes its workflow container.
 *  7. B4a: ElementRepository and ElementService handle workflow_id = null safely without throwing or dropping entities.
 */
describe("WorkflowMediaService delete, orphan rules, and sidecar preservation (WM-T5 / B4a)", () => {

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

  it("Test 1 (B4a): deleting the last media unlinks without deleting workflow container when character or element sidecar is attached", async () => {
    const deletedWorkflowIds = [];
    const updatedPrimaryCalls = [];

    const db = {
      media: {
        findById: async (id) => ({ id, url: `https://cdn.example.com/${id}.png` }),
        deleteById: async (id) => ({ id }),
        findByWorkflow: async () => [], // 0 remaining media!
        client: () => ({
          from: () => ({ delete: () => ({ eq: async () => ({ error: null }) }) }),
        }),
      },
      workflows: {
        findById: async (wfId) => {
          if (wfId === "wf-char-1") return { id: "wf-char-1", primary_media_id: "m-char-last", workflow_type: "IMAGE" };
          if (wfId === "wf-elem-1") return { id: "wf-elem-1", primary_media_id: "m-elem-last", workflow_type: "IMAGE" };
          return { id: wfId, primary_media_id: null, workflow_type: "IMAGE" };
        },
        deleteById: async (wfId) => {
          deletedWorkflowIds.push(wfId);
          return {};
        },
        updatePrimaryMedia: async (wfId, mediaId) => {
          updatedPrimaryCalls.push({ wfId, mediaId });
          return {};
        },
      },
      characters: {
        findByCharacterId: async (wfId) => (wfId === "wf-char-1" ? { id: "char-1", workflow_id: "wf-char-1" } : null),
      },
      elements: {
        findByWorkflowId: async (wfId) => (wfId === "wf-elem-1" ? { id: "elem-1", workflow_id: "wf-elem-1" } : null),
      },
      workflowMedia: {
        findByMedia: async (mediaId) => {
          if (mediaId === "m-char-last") return [{ workflow_id: "wf-char-1", media_id: "m-char-last" }];
          if (mediaId === "m-elem-last") return [{ workflow_id: "wf-elem-1", media_id: "m-elem-last" }];
          return [{ workflow_id: "wf-plain-1", media_id: mediaId }];
        },
        unlink: async () => {},
        countLinksForMedia: async () => 0,
      },
    };

    const service = new WorkflowMediaService({
      db,
      storageService: { deleteByUrl: async () => {} },
      authService: { verifyMediaOwnership: async () => true },
    });

    // 1. Delete last media of character workflow -> container MUST NOT be deleted
    const charRes = await service.deleteMedia({ mediaId: "m-char-last", userId: "user-1" });
    assert.equal(charRes.deleted, true);
    assert.equal(charRes.workflow_deleted, false, "Character workflow container must NOT be deleted when last media is removed");
    assert.equal(deletedWorkflowIds.includes("wf-char-1"), false);
    assert.deepEqual(updatedPrimaryCalls[0], { wfId: "wf-char-1", mediaId: null });

    // 2. Delete last media of element workflow -> container MUST NOT be deleted
    const elemRes = await service.deleteMedia({ mediaId: "m-elem-last", userId: "user-1" });
    assert.equal(elemRes.deleted, true);
    assert.equal(elemRes.workflow_deleted, false, "Element workflow container must NOT be deleted when last media is removed");
    assert.equal(deletedWorkflowIds.includes("wf-elem-1"), false);
    assert.deepEqual(updatedPrimaryCalls[1], { wfId: "wf-elem-1", mediaId: null });

    // 3. Delete last media of plain non-sidecar workflow -> container IS deleted
    const plainRes = await service.deleteMedia({ mediaId: "m-plain-last", userId: "user-1" });
    assert.equal(plainRes.deleted, true);
    assert.equal(plainRes.workflow_deleted, true);
    assert.equal(deletedWorkflowIds.includes("wf-plain-1"), true);
  });

  it("Test 2 (B4a): explicit user DELETE of element or character deletes the sidecar entity and releases its workflow container", async () => {
    const deletedElementIds = [];
    const deletedCharacterIds = [];
    const deletedWorkflowIds = [];

    const elemService = new ElementService({
      db: {
        elements: {
          resolveRecord: async (id) => ({ id, workflow_id: "wf-elem-del-1", name: "Prop" }),
          deleteById: async (id) => { deletedElementIds.push(id); return { id }; },
        },
        workflows: {
          deleteById: async (wfId) => { deletedWorkflowIds.push(wfId); },
        },
        media: {},
      },
      workflowService: {
        deleteWorkflow: async ({ workflowId }) => { deletedWorkflowIds.push(workflowId); },
      },
    });

    const elemDeleted = await elemService.deleteElement("elem-del-1", "user-1");
    assert.equal(elemDeleted, true);
    assert.deepEqual(deletedElementIds, ["elem-del-1"]);
    assert.deepEqual(deletedWorkflowIds, ["wf-elem-del-1"]);

    const charService = new CharacterService({
      db: {
        workflows: {
          getWorkflow: async (id) => ({ id, user_id: "user-1", project_id: "proj-1", workflow_type: "CHARACTER" }),
          deleteById: async (id) => { deletedWorkflowIds.push(id); },
        },
        characters: {
          deleteById: async (id) => { deletedCharacterIds.push(id); },
        },
      },
      workflowService: {
        deleteWorkflow: async ({ workflowId }) => {
          deletedWorkflowIds.push(workflowId);
          return { ok: true };
        },
      },
    });

    const charDeleted = await charService.deleteCharacter({ characterId: "wf-char-del-1" });
    assert.equal(charDeleted.ok, true);
    assert.deepEqual(deletedCharacterIds, ["wf-char-del-1"]);
    assert.equal(deletedWorkflowIds.includes("wf-char-del-1"), true);
  });

  it("Test 3 (B4a): ElementRepository and ElementService handle workflow_id = null safely without throwing or dropping entities", async () => {
    const repo = new ElementRepository();
    assert.equal(await repo.findByWorkflowId(null), null);
    assert.equal(await repo.resolveRecord(null), null);

    let getPrimaryMediaCalled = false;
    let findByWorkflowCalled = false;
    let deleteWorkflowCalled = false;

    const service = new ElementService({
      db: {
        elements: {
          list: async () => [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Detached Element",
              description: "Still intact",
              workflow_id: null,
              source_images: [],
              tags: ["object"],
              create_time: "2026-01-01T00:00:00Z",
            },
          ],
          resolveRecord: async () => ({
            id: "11111111-1111-4111-8111-111111111111",
            name: "Detached Element",
            description: "Still intact",
            workflow_id: null,
            source_images: [],
            tags: ["object"],
          }),
          findById: async () => ({
            id: "11111111-1111-4111-8111-111111111111",
            name: "Detached Element",
            description: "Still intact",
            workflow_id: null,
          }),
          deleteById: async (id) => ({ id }),
        },
        workflows: {
          getPrimaryMediaUrl: async () => {
            getPrimaryMediaCalled = true;
            throw new Error("Should not call getPrimaryMediaUrl with null workflow_id");
          },
          deleteById: async () => {
            deleteWorkflowCalled = true;
          },
        },
        media: {
          findByWorkflow: async () => {
            findByWorkflowCalled = true;
            throw new Error("Should not call findByWorkflow with null workflow_id");
          },
        },
      },
      workflowService: {
        deleteWorkflow: async () => {
          deleteWorkflowCalled = true;
        },
      },
    });

    const list = await service.listProjectElements("proj-1");
    assert.equal(list.length, 1, "Element with workflow_id = null must not be dropped from listProjectElements");
    assert.equal(list[0].workflow_id, null);
    assert.equal(list[0].primary_media_url, null);
    assert.equal(getPrimaryMediaCalled, false);

    const detail = await service.getElementById("11111111-1111-4111-8111-111111111111");
    assert.ok(detail);
    assert.equal(detail.workflow_id, null);
    assert.deepEqual(detail.reference_images, []);
    assert.equal(detail.primary_media_url, null);
    assert.equal(findByWorkflowCalled, false);

    const promptCtx = await service.getElementContextForPrompt({
      nameOrId: "11111111-1111-4111-8111-111111111111",
      projectId: "proj-1",
    });
    assert.ok(promptCtx);
    assert.deepEqual(promptCtx.referenceImageUrls, []);
    assert.equal(findByWorkflowCalled, false);

    const delRes = await service.deleteElement("11111111-1111-4111-8111-111111111111", "user-1");
    assert.equal(delRes, true);
    assert.equal(deleteWorkflowCalled, false, "deleteElement must not call deleteWorkflow when workflow_id is null");
  });
});
