import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkflowMediaService, sanitizeStoragePath } from "../../src/platform/workflow/WorkflowMediaService.js";
import { ElementService } from "../../src/domain/element/ElementService.js";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";
import { ElementRepository } from "../../src/db/ElementRepository.js";
import { CharacterService } from "../../src/domain/character/CharacterService.js";
import { CharacterMediaService } from "../../src/domain/character/CharacterMediaService.js";

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
        unlinkAndReapOrphan: async ({ workflowId, mediaId } = {}) => {
          calls.unlink.push({ workflowId, mediaId });
          return {
            unlinked: true,
            is_orphan: countLinks === 0,
            storage_url: countLinks === 0 ? (mediaRec?.url || null) : null,
            remaining_links: countLinks,
            was_primary: false,
          };
        },
      },
    };

    const storageService = {
      deleteByUrl: async (url) => { calls.storageDelete.push(url); },
    };

    const authService = {
      verifyWorkflowOwnership: async () => true,
      verifyMediaOwnership: async () => authorised,
    };

    const service = new WorkflowMediaService({ db, storageService, authService, mediaUploadService: { discard: async () => ({}) } });
    const origDeleteMedia = service.deleteMedia.bind(service);
    service.deleteMedia = ({ workflowId = "wf-1", ...args }) => origDeleteMedia({ workflowId, ...args });
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

    assert.equal(result.deleted, false);
    // unlink still called (to remove the global association)
    assert.equal(calls.unlink.length, 1);
    // media row NOT deleted — still linked to other workflows
    assert.deepEqual(calls.deleteById, []);
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
        unlinkAndReapOrphan: async ({ workflowId, mediaId } = {}) => {
          order.push("unlink");
          return { unlinked: true, is_orphan: true, storage_url: "https://cdn.example.com/img.png", remaining_links: 0, was_primary: false };
        },
      },
    };

    const service = new WorkflowMediaService({
      db,
      storageService: { deleteByUrl: async () => {} },
      authService: { verifyMediaOwnership: async () => true, verifyWorkflowOwnership: async () => true },
      mediaUploadService: { discard: async () => ({}) },
    });

    await service.deleteMedia({ mediaId: "media-1", workflowId: "wf-1", userId: "user-1" });

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
        unlinkAndReapOrphan: async ({ workflowId, mediaId } = {}) => {
          return {
            unlinked: true,
            is_orphan: true,
            storage_url: `https://cdn.example.com/${mediaId}.png`,
            remaining_links: 0,
            was_primary: true,
          };
        },
      },
    };

    const service = new WorkflowMediaService({
      db,
      storageService: { deleteByUrl: async () => {} },
      authService: { verifyMediaOwnership: async () => true, verifyWorkflowOwnership: async () => true },
      mediaUploadService: { discard: async () => ({}) },
    });

    // 1. Delete last media of character workflow -> container MUST NOT be deleted
    const charRes = await service.deleteMedia({ mediaId: "m-char-last", workflowId: "wf-char-1", userId: "user-1" });
    assert.equal(charRes.deleted, true);
    assert.equal(charRes.workflow_deleted, false, "Character workflow container must NOT be deleted when last media is removed");
    assert.equal(deletedWorkflowIds.includes("wf-char-1"), false);
    assert.deepEqual(updatedPrimaryCalls[0], { wfId: "wf-char-1", mediaId: null });

    // 2. Delete last media of element workflow -> container MUST NOT be deleted
    const elemRes = await service.deleteMedia({ mediaId: "m-elem-last", workflowId: "wf-elem-1", userId: "user-1" });
    assert.equal(elemRes.deleted, true);
    assert.equal(elemRes.workflow_deleted, false, "Element workflow container must NOT be deleted when last media is removed");
    assert.equal(deletedWorkflowIds.includes("wf-elem-1"), false);
    assert.deepEqual(updatedPrimaryCalls[1], { wfId: "wf-elem-1", mediaId: null });

    // 3. Delete last media of plain non-sidecar workflow -> container IS deleted
    const plainRes = await service.deleteMedia({ mediaId: "m-plain-last", workflowId: "wf-plain-1", userId: "user-1" });
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
      mediaService: {},
    });

    const elemDeleted = await elemService.deleteElement("elem-del-1", "user-1");
    assert.deepEqual(elemDeleted, {
      workflowId: "wf-elem-del-1",
      unlinkedMediaCount: 0,
      deletedOrphanCount: 0,
      deletedMediaCount: 0,
      storageFailures: [],
    });
    assert.deepEqual(deletedElementIds, ["elem-del-1"]);
    assert.deepEqual(deletedWorkflowIds, ["wf-elem-del-1"]);

    const charService = new CharacterService({
      mediaService: {},
      db: {
        workflows: {
          getWorkflow: async (id) => ({ id, user_id: "user-1", project_id: "proj-1", workflow_type: "CHARACTER" }),
          deleteById: async (id) => { deletedWorkflowIds.push(id); },
        },
        characters: {
          findByCharacterId: async (id) => ({ id, workflow_id: id }),
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
      mediaService: {},
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
    assert.deepEqual(delRes, {
      workflowId: "11111111-1111-4111-8111-111111111111",
      unlinkedMediaCount: 0,
      deletedOrphanCount: 0,
      deletedMediaCount: 0,
      storageFailures: [],
    });
    assert.equal(deleteWorkflowCalled, false, "deleteElement must not call deleteWorkflow when workflow_id is null");
  });

  it("T0 (STD-08/STD-10): ElementService.deleteElement deletes the workflow BEFORE deleting the element row, keeps the element row if deleteWorkflow fails, and throws if workflowService is missing", async () => {
    const callOrder = [];
    const elemService = new ElementService({
      db: {
        elements: {
          resolveRecord: async (id) => ({ id: "elem-order-1", workflow_id: "wf-elem-order-1", name: "Ordered Prop" }),
          deleteById: async (id) => {
            callOrder.push(`deleteElementRow:${id}`);
            return { id };
          },
        },
        workflows: {
          deleteById: async () => {
            callOrder.push("directDbWorkflowDelete");
          },
        },
        media: {},
      },
      workflowService: {
        deleteWorkflow: async ({ workflowId, userId }) => {
          callOrder.push(`deleteWorkflow:${workflowId}:${userId}`);
          return {
            workflowId,
            unlinkedMediaCount: 2,
            deletedOrphanCount: 1,
            deletedMediaCount: 1,
            storageFailures: [],
          };
        },
      },
      mediaService: {},
    });

    const result = await elemService.deleteElement("elem-order-1", "user-order-1");
    assert.deepEqual(callOrder, [
      "deleteWorkflow:wf-elem-order-1:user-order-1",
      "deleteElementRow:elem-order-1",
    ], "workflowService.deleteWorkflow must run BEFORE db.elements.deleteById");
    assert.deepEqual(result, {
      workflowId: "wf-elem-order-1",
      unlinkedMediaCount: 2,
      deletedOrphanCount: 1,
      deletedMediaCount: 1,
      storageFailures: [],
    });

    // Partial failure: deleteWorkflow rejects -> element row is KEPT
    let elementRowDeletedOnFailure = false;
    const failingElemService = new ElementService({
      db: {
        elements: {
          resolveRecord: async () => ({ id: "elem-fail-1", workflow_id: "wf-elem-fail-1", name: "Keep On Fail" }),
          deleteById: async () => {
            elementRowDeletedOnFailure = true;
          },
        },
        workflows: {},
        media: {},
      },
      workflowService: {
        deleteWorkflow: async () => {
          throw new Error("deleteWorkflow failed mid-reap");
        },
      },
      mediaService: {},
    });

    await assert.rejects(
      () => failingElemService.deleteElement("elem-fail-1", "user-1"),
      /deleteWorkflow failed mid-reap/
    );
    assert.equal(elementRowDeletedOnFailure, false, "element row must be kept when deleteWorkflow rejects");

    // Missing workflowService on non-null workflow_id -> throws and never falls back to db.workflows.deleteById
    let fallbackWorkflowDeleteCalled = false;
    let elementDeletedWithoutWfService = false;
    const noWfServiceElem = new ElementService({
      db: {
        elements: {
          resolveRecord: async () => ({ id: "elem-nowf-1", workflow_id: "wf-elem-nowf-1", name: "No Fallback" }),
          deleteById: async () => {
            elementDeletedWithoutWfService = true;
          },
        },
        workflows: {
          deleteById: async () => {
            fallbackWorkflowDeleteCalled = true;
          },
        },
        media: {},
      },
      workflowService: null,
      mediaService: {},
    });

    await assert.rejects(
      () => noWfServiceElem.deleteElement("elem-nowf-1", "user-1"),
      /ElementService\.deleteElement requires workflowService/
    );
    assert.equal(fallbackWorkflowDeleteCalled, false, "must never call db.workflows.deleteById fallback");
    assert.equal(elementDeletedWithoutWfService, false, "must not delete element row when workflowService is missing");
  });

  it("T0 (STD-08): CharacterService.deleteCharacter deletes the workflow BEFORE deleting the characters row, keeps the characters row if deleteWorkflow fails, and handles orphan characters with workflow_id = null", async () => {
    const callOrder = [];
    const charService = new CharacterService({
      mediaService: {},
      db: {
        workflows: {
          getWorkflow: async (id) => ({ id, user_id: "user-char-1", project_id: "proj-1", workflow_type: "CHARACTER" }),
        },
        characters: {
          findByCharacterId: async (id) => ({ id, user_id: "user-char-1", project_id: "proj-1", workflow_id: id }),
          deleteById: async (id) => {
            callOrder.push(`deleteCharacterRow:${id}`);
            return true;
          },
        },
      },
      workflowService: {
        deleteWorkflow: async ({ workflowId }) => {
          callOrder.push(`deleteWorkflow:${workflowId}`);
          return {
            workflowId,
            unlinkedMediaCount: 3,
            deletedOrphanCount: 2,
            deletedMediaCount: 2,
            storageFailures: [],
          };
        },
      },
    });

    const delResult = await charService.deleteCharacter({ characterId: "char-order-1" });
    assert.deepEqual(callOrder, [
      "deleteWorkflow:char-order-1",
      "deleteCharacterRow:char-order-1",
    ], "workflowService.deleteWorkflow must run BEFORE db.characters.deleteById");
    assert.deepEqual(delResult, {
      workflowId: "char-order-1",
      unlinkedMediaCount: 3,
      deletedOrphanCount: 2,
      deletedMediaCount: 2,
      storageFailures: [],
    });

    // Partial failure: deleteWorkflow rejects -> characters row is KEPT
    let charRowDeletedOnFailure = false;
    const failingCharService = new CharacterService({
      mediaService: {},
      db: {
        workflows: {},
        characters: {
          findByCharacterId: async (id) => ({ id, user_id: "user-char-1", project_id: "proj-1", workflow_id: id }),
          deleteById: async () => {
            charRowDeletedOnFailure = true;
          },
        },
      },
      workflowService: {
        deleteWorkflow: async () => {
          throw new Error("character workflow delete failed");
        },
      },
    });

    await assert.rejects(
      () => failingCharService.deleteCharacter({ characterId: "char-fail-1" }),
      /character workflow delete failed/
    );
    assert.equal(charRowDeletedOnFailure, false, "characters row must be kept when deleteWorkflow rejects");

    // Missing workflowService on non-null workflow_id -> throws and keeps characters row
    let charRowDeletedWithoutWfService = false;
    const noWfCharService = new CharacterService({
      mediaService: {},
      db: {
        workflows: {},
        characters: {
          findByCharacterId: async (id) => ({ id, user_id: "user-char-1", project_id: "proj-1", workflow_id: id }),
          deleteById: async () => {
            charRowDeletedWithoutWfService = true;
          },
        },
      },
      workflowService: null,
    });

    await assert.rejects(
      () => noWfCharService.deleteCharacter({ characterId: "char-nowf-1" }),
      /CharacterService\.deleteCharacter requires workflowService/
    );
    assert.equal(charRowDeletedWithoutWfService, false, "characters row must be kept when workflowService is missing");

    // Orphan character (workflow_id === null): deletes characters row directly without calling deleteWorkflow
    let orphanDeleteWorkflowCalled = false;
    const deletedOrphanCharIds = [];
    const orphanCharService = new CharacterService({
      mediaService: {},
      db: {
        workflows: {},
        characters: {
          findByCharacterId: async (id) => ({ id, user_id: "user-char-1", project_id: "proj-1", workflow_id: null }),
          deleteById: async (id) => {
            deletedOrphanCharIds.push(id);
            return true;
          },
        },
      },
      workflowService: {
        deleteWorkflow: async () => {
          orphanDeleteWorkflowCalled = true;
        },
      },
    });

    const orphanRes = await orphanCharService.deleteCharacter({ characterId: "char-orphan-1" });
    assert.equal(orphanDeleteWorkflowCalled, false, "deleteCharacter must not call deleteWorkflow when workflow_id is null");
    assert.deepEqual(deletedOrphanCharIds, ["char-orphan-1"]);
    assert.deepEqual(orphanRes, {
      workflowId: "char-orphan-1",
      unlinkedMediaCount: 0,
      deletedOrphanCount: 0,
      deletedMediaCount: 0,
      storageFailures: [],
    });
  });

  it("Test 1 (B4b): deleting a character's turnaround sheet sets primary_media_id to null while remaining detail photos remain unpinned", async () => {
    const primaryUpdates = [];
    const detailPhotos = [
      { id: "m-detail-1", url: "https://cdn.example.com/detail-1.png", step_id: "character_detail", role: "detail", mediaRole: "detail" },
      { id: "m-detail-2", url: "https://cdn.example.com/detail-2.png", step_id: "character_detail", role: "detail", mediaRole: "detail" },
    ];

    const db = {
      media: {
        findById: async (id) => ({ id, url: `https://cdn.example.com/${id}.png`, step_id: "character_sheet" }),
        deleteById: async (id) => ({ id }),
        findByWorkflow: async () => detailPhotos, // 2 detail photos remain after turnaround sheet is deleted
        client: () => ({
          from: () => ({ delete: () => ({ eq: async () => ({ error: null }) }) }),
        }),
      },
      workflows: {
        findById: async (wfId) => ({
          id: wfId,
          primary_media_id: "m-sheet-1",
          workflow_type: "CHARACTER_SHEET",
        }),
        deleteById: async () => ({}),
        updatePrimaryMedia: async (wfId, mediaId) => {
          primaryUpdates.push({ wfId, mediaId });
          return { id: wfId, primary_media_id: mediaId };
        },
      },
      characters: {
        findByCharacterId: async (wfId) => ({ id: wfId, workflow_id: wfId }),
      },
      workflowMedia: {
        findByMedia: async () => [{ workflow_id: "wf-char-sheet", media_id: "m-sheet-1", role: "sheet" }],
        unlink: async () => {},
        countLinksForMedia: async () => 0,
        unlinkAndReapOrphan: async () => ({ unlinked: true, is_orphan: true, storage_url: "https://cdn.example.com/m-sheet-1.png", remaining_links: 0, was_primary: true }),
      },
    };

    const service = new WorkflowMediaService({
      db,
      storageService: { deleteByUrl: async () => {} },
      authService: { verifyMediaOwnership: async () => true, verifyWorkflowOwnership: async () => true },
      mediaUploadService: { discard: async () => ({}) },
    });

    const result = await service.deleteMedia({ mediaId: "m-sheet-1", workflowId: "wf-char-sheet", userId: "user-1" });

    assert.equal(result.deleted, true);
    assert.equal(result.workflow_deleted, false);
    assert.equal(result.next_primary_media_id, null, "Must NOT auto-promote remaining detail photo to primary_media_id");
    assert.deepEqual(primaryUpdates, [{ wfId: "wf-char-sheet", mediaId: null }]);
  });

  it("Test 2 (B4b): deleting or detaching a pinned generation or upload sets primary_media_id to null without auto-promoting remaining media", async () => {
    const primaryUpdates = [];
    const fieldUpdates = [];
    const remainingVariations = [
      { id: "m-var-2", url: "https://cdn.example.com/var-2.png", step_id: "txt2img" },
      { id: "m-var-3", url: "https://cdn.example.com/var-3.png", step_id: "txt2img" },
    ];

    const db = {
      media: {
        findById: async (id) => ({ id, url: `https://cdn.example.com/${id}.png`, step_id: "txt2img" }),
        deleteById: async (id) => ({ id }),
        updateFields: async (id, fields) => ({ id, ...fields }),
        findByWorkflow: async () => remainingVariations,
        client: () => ({
          from: () => ({
            delete: () => ({ eq: async () => ({ error: null }) }),
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: "m-pinned-1", status: "ready", project_id: "proj-1", user_id: "user-1", step_id: "txt2img" },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      },
      workflows: {
        findById: async (wfId) => ({
          id: wfId,
          project_id: "proj-1",
          user_id: "user-1",
          primary_media_id: "m-pinned-1",
          workflow_type: "IMAGE",
        }),
        createWorkflow: async (payload) => ({ id: "wf-detached-new", ...payload }),
        deleteById: async () => ({}),
        updatePrimaryMedia: async (wfId, mediaId) => {
          primaryUpdates.push({ wfId, mediaId });
          return { id: wfId, primary_media_id: mediaId };
        },
        updateFields: async (wfId, fields) => {
          fieldUpdates.push({ wfId, fields });
          return { id: wfId, ...fields };
        },
      },
      workflowMedia: {
        findByMedia: async () => [{ workflow_id: "wf-gen-1", media_id: "m-pinned-1", role: "output" }],
        link: async () => ({}),
        unlink: async () => {},
        unlinkByWorkflow: async () => {},
        countLinksForMedia: async () => 0,
        unlinkAndReapOrphan: async () => ({ unlinked: true, is_orphan: true, storage_url: "https://cdn.example.com/m-pinned-1.png", remaining_links: 0, was_primary: true }),
      },
    };

    const service = new WorkflowMediaService({
      db,
      storageService: { deleteByUrl: async () => {} },
      authService: { verifyMediaOwnership: async () => true, verifyWorkflowOwnership: async () => true },
      mediaUploadService: { discard: async () => ({}) },
    });

    // 1. deleteMedia on pinned generation/upload variation -> sets primary_media_id to null
    const deleteRes = await service.deleteMedia({ mediaId: "m-pinned-1", workflowId: "wf-gen-1", userId: "user-1" });
    assert.equal(deleteRes.deleted, true);
    assert.equal(deleteRes.workflow_deleted, false);
    assert.equal(deleteRes.next_primary_media_id, null, "Must NOT auto-promote m-var-2 to primary_media_id on delete");
    assert.deepEqual(primaryUpdates, [{ wfId: "wf-gen-1", mediaId: null }]);

    // 2. detachMedia on pinned generation/upload variation -> sets old workflow primary_media_id to null
    fieldUpdates.length = 0;
    await service.detachMedia({ mediaId: "m-pinned-1", userId: "user-1" });
    const oldWfUpdate = fieldUpdates.find((u) => u.wfId === "wf-gen-1");
    assert.ok(oldWfUpdate, "Old workflow primary_media_id must be updated when detaching pinned media");
    assert.equal(oldWfUpdate.fields.primary_media_id, null, "Old workflow primary_media_id must be nullified, never auto-promoted");
  });

  it("Test 1 (B4c): reference-counted unlinking in ElementMediaService.removeReferenceMedia and CharacterMediaService.removeDetailMedia deletes DB row and storage ONLY when countLinksForMedia === 0", async () => {
    const elemUnlinkCalls = [];
    const elemDeletedIds = [];
    const elemStorageDeletes = [];
    const elemOrder = [];

    let elemLinkCount = 1; // Shared at first
    const elemMediaService = new ElementMediaService({
      mediaUploadService: { upload: async () => ({ uploaded: [] }), discard: async () => ({}) },
      workflowMediaService: { attachMediaItems: async () => ({ attached: [] }) },
      authService: { verifyWorkflowOwnership: async () => true },
      db: {
        elements: {
          resolveRecord: async () => ({
            id: "11111111-1111-4111-8111-111111111111",
            workflow_id: "wf-elem-ref",
            source_images: ["m-elem-ref-1", "m-elem-ref-2"],
          }),
          update: async () => ({}),
        },
        workflows: {
          findById: async () => ({ id: "wf-elem-ref", primary_media_id: "m-elem-ref-1" }),
          updatePrimaryMedia: async () => ({}),
        },
        media: {
          findById: async (id) => ({ id, url: `https://cdn.example.com/${id}.png` }),
          deleteById: async (id) => {
            elemOrder.push("deleteById");
            elemDeletedIds.push(id);
          },
        },
        workflowMedia: {
          unlink: async (args) => {
            elemOrder.push("unlink");
            elemUnlinkCalls.push(args);
          },
          unlinkAndReapOrphan: async (args) => {
            elemOrder.push("unlink");
            elemUnlinkCalls.push(args);
            return {
              unlinked: true,
              is_orphan: elemLinkCount === 0,
              storage_url: `https://cdn.example.com/${args.mediaId}.png`,
            };
          },
          countLinksForMedia: async () => elemLinkCount,
        },
      },
      storageService: {
        deleteByUrl: async (url) => {
          elemOrder.push("deleteByUrl");
          elemStorageDeletes.push(url);
        },
      },
    });

    // Case A: Shared media (countLinksForMedia = 1) -> unlinks, does NOT delete media row or storage
    await elemMediaService.removeReferenceMedia({
      elementId: "11111111-1111-4111-8111-111111111111",
      mediaId: "m-elem-ref-1",
      userId: "user-1",
    });
    assert.equal(elemUnlinkCalls.length, 1);
    assert.deepEqual(elemDeletedIds, [], "Must NOT delete media row when remainingLinks > 0");
    assert.deepEqual(elemStorageDeletes, [], "Must NOT delete storage file when remainingLinks > 0");

    // Case B: Orphaned media (countLinksForMedia = 0) -> unlinks, deletes media row FIRST, then deletes storage
    elemLinkCount = 0;
    elemOrder.length = 0;
    await elemMediaService.removeReferenceMedia({
      elementId: "11111111-1111-4111-8111-111111111111",
      mediaId: "m-elem-ref-2",
      userId: "user-1",
    });
    assert.deepEqual(elemDeletedIds, ["m-elem-ref-2"]);
    assert.deepEqual(elemStorageDeletes, ["https://cdn.example.com/m-elem-ref-2.png"]);
    assert.deepEqual(elemOrder, ["unlink", "deleteById", "deleteByUrl"], "Storage delete must run post-DB-delete");

    // Case C: CharacterMediaService.removeDetailMedia with countLinksForMedia = 0 and db.media.deleteById
    const charOrder = [];
    const charMediaService = new CharacterMediaService({
      mediaUploadService: { upload: async () => ({}) },
      workflowMediaService: { attachMediaItems: async () => ({}) },
      authService: { verifyWorkflowOwnership: async () => true },
      db: {
        workflows: {
          getWorkflow: async (id) => ({ id, primary_media_id: "m-char-det-1" }),
          updatePrimaryMedia: async () => ({}),
        },
        media: {
          findById: async (id) => ({ id, url: "https://cdn.example.com/char-det-1.png", step_id: "character_detail", role: "detail" }),
          deleteById: async () => { charOrder.push("deleteById"); },
        },
        workflowMedia: {
          findByMedia: async () => [{ workflow_id: "wf-char-1", media_id: "m-char-det-1", role: "detail" }],
          unlink: async () => { charOrder.push("unlink"); },
          countLinksForMedia: async () => 0,
        },
      },
      storageService: {
        deleteByUrl: async () => { charOrder.push("deleteByUrl"); },
      },
    });

    await charMediaService.removeDetailMedia({
      characterId: "wf-char-1",
      mediaId: "m-char-det-1",
      userId: "user-1",
    });
    assert.deepEqual(charOrder, ["unlink", "deleteById", "deleteByUrl"]);
  });

  it("Test 2 (B4c): scanOrphanMediaDryRun lists candidate orphan media IDs and sanitized storage paths without performing deletions", async () => {
    let deleteByIdCalled = false;
    let deleteByUrlCalled = false;

    const candidateMedia = [
      {
        id: "m-linked-1",
        url: "https://project.supabase.co/storage/v1/object/sign/bucket/u1/linked.png?token=secret-jwt-linked",
        project_id: "proj-1",
      },
      {
        id: "m-orphan-1",
        url: "https://project.supabase.co/storage/v1/object/sign/bucket/u1/orphan-1.png?token=secret-jwt-orphan-1&sig=xyz",
        project_id: "proj-1",
      },
      {
        id: "m-orphan-2",
        url: "character-sheets/u1/c1/orphan-2.png?token=secret-jwt-orphan-2",
        project_id: "proj-1",
      },
    ];

    const service = new WorkflowMediaService({
      db: {
        media: {
          listAll: async () => candidateMedia,
          deleteById: async () => { deleteByIdCalled = true; },
        },
        workflowMedia: {
          countLinksForMedia: async (mediaId) => (mediaId === "m-linked-1" ? 2 : 0),
          findByMedia: async () => [],
        },
      },
      storageService: {
        deleteByUrl: async () => { deleteByUrlCalled = true; },
      },
      authService: { verifyWorkflowOwnership: async () => true, verifyMediaOwnership: async () => true },
      mediaUploadService: { discard: async () => ({}) },
    });

    const report = await service.scanOrphanMediaDryRun({ projectId: "proj-1" });

    assert.equal(report.dryRun, true);
    assert.equal(report.count, 2);
    assert.deepEqual(report.orphanMediaIds, ["m-orphan-1", "m-orphan-2"]);
    assert.deepEqual(report.orphanStoragePaths, [
      "/storage/v1/object/sign/bucket/u1/orphan-1.png",
      "character-sheets/u1/c1/orphan-2.png",
    ]);
    for (const p of report.orphanStoragePaths) {
      assert.equal(p.includes("token="), false, "Sanitized storage path must never contain signed URL tokens");
      assert.equal(p.includes("secret-jwt"), false, "Sanitized storage path must never leak signed URL secrets");
    }
    assert.equal(deleteByIdCalled, false, "Dry-run sweep must NEVER delete media DB rows");
    assert.equal(deleteByUrlCalled, false, "Dry-run sweep must NEVER delete storage binaries");
  });

  it("Test 3 (B4c): sanitizeStoragePath strips signed URL query tokens and storage deletion errors never leak signed URLs", async () => {
    const signedUrl = "https://project.supabase.co/storage/v1/object/sign/media-bucket/user-1/img.png?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret&Expires=1999999999";
    const sanitized = sanitizeStoragePath(signedUrl);

    assert.equal(sanitized, "/storage/v1/object/sign/media-bucket/user-1/img.png");
    assert.equal(sanitized.includes("token="), false);
    assert.equal(sanitized.includes("eyJ"), false);

    const { service } = makeService({
      mediaRec: { id: "media-signed-err", url: signedUrl },
      countLinks: 0,
    });
    service.storageService = {
      deleteByUrl: async () => {
        throw new Error("Storage bucket temporarily unavailable");
      },
    };

    const res = await service.deleteMedia({ mediaId: "media-signed-err", userId: "user-1" });
    assert.equal(res.deleted, true);
  });
});
