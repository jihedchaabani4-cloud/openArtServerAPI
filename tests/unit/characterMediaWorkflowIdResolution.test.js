import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CharacterMediaService } from "../../src/domain/character/CharacterMediaService.js";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";

describe("Workflow ID resolution to media relation in Character & Element services", () => {
  it("CharacterMediaService.uploadDetailMedia with workflow ID resolves source media and links workflow_media relation with role 'detail'", async () => {
    let linkedPayload = null;
    let createMediaCalled = false;

    const mockSourceMedia = {
      id: "media-uuid-456",
      workflow_id: "wf-source-123",
      url: "https://storage.example.com/generated-shot.png",
      width: 1024,
      height: 1024,
      status: "success",
    };

    const mockDb = {
      workflows: {
        getWorkflow: async (id) => {
          if (id === "char-wf-1") return { id: "char-wf-1", project_id: "proj-1", user_id: "user-1", workflow_type: "CHARACTER" };
          if (id === "wf-source-123") return { id: "wf-source-123", primary_media_id: "media-uuid-456" };
          return null;
        },
      },
      media: {
        findById: async (id) => (id === "media-uuid-456" ? mockSourceMedia : null),
        findMediaByIdOrWorkflow: async (id) => (id === "wf-source-123" ? mockSourceMedia : null),
        findByWorkflow: async (id) => (id === "wf-source-123" ? [mockSourceMedia] : []),
        createMedia: async () => {
          createMediaCalled = true;
          return { id: "new-media-uuid" };
        },
      },
      workflowMedia: {
        linkMedia: async (payload) => {
          linkedPayload = payload;
          return payload;
        },
      },
    };

    const service = new CharacterMediaService({
      db: mockDb,
      storageService: {},
      mediaIngestionService: {
        ingest: async () => ({
          media: mockSourceMedia,
          isNew: false,
          mediaId: mockSourceMedia.id,
          url: mockSourceMedia.url,
          width: 1024,
          height: 1024,
        }),
      },
    });

    // Frontend passes workflow ID as mediaId (architectural contract)
    const result = await service.uploadDetailMedia({
      characterId: "char-wf-1",
      mediaId: "wf-source-123",
      projectId: "proj-1",
      userId: "user-1",
    });

    assert.equal(result.ok, true);
    assert.equal(createMediaCalled, false, "Should not create a duplicate media row for an existing asset");
    assert.ok(linkedPayload, "Should link existing media to character workflow in workflow_media");
    assert.equal(linkedPayload.workflowId, "char-wf-1");
    assert.equal(linkedPayload.mediaId, "media-uuid-456");
    assert.equal(linkedPayload.role, "detail");
    assert.equal(result.media.id, "media-uuid-456");
  });

  it("CharacterMediaService.uploadSheetMedia with workflow ID resolves source media and sets sheet relation", async () => {
    let linkedPayload = null;
    let updatedPrimaryMedia = null;
    let characterFieldsUpdated = null;

    const mockSourceMedia = {
      id: "media-uuid-789",
      workflow_id: "wf-sheet-source",
      url: "https://storage.example.com/character-sheet.png",
      width: 1344,
      height: 768,
      status: "success",
    };

    const mockDb = {
      workflows: {
        getWorkflow: async (id) => {
          if (id === "char-wf-1") return { id: "char-wf-1", project_id: "proj-1", user_id: "user-1", workflow_type: "CHARACTER" };
          if (id === "wf-sheet-source") return { id: "wf-sheet-source", primary_media_id: "media-uuid-789" };
          return null;
        },
        updatePrimaryMedia: async (wfId, mediaId) => {
          updatedPrimaryMedia = { wfId, mediaId };
          return {};
        },
      },
      media: {
        findById: async (id) => (id === "media-uuid-789" ? mockSourceMedia : null),
        findMediaByIdOrWorkflow: async (id) => (id === "wf-sheet-source" ? mockSourceMedia : null),
        findByWorkflow: async (id) => (id === "char-wf-1" ? [] : [mockSourceMedia]),
        createMedia: async () => ({ id: "fail-media" }),
        updateFields: async (id, fields) => ({ id, ...fields }),
        deleteByIdAndWorkflow: async () => ({}),
      },
      characters: {
        updateCharacterFields: async (charId, fields) => {
          characterFieldsUpdated = { charId, fields };
          return {};
        },
      },
      workflowMedia: {
        linkMedia: async (payload) => {
          linkedPayload = payload;
          return payload;
        },
      },
    };

    const service = new CharacterMediaService({
      db: mockDb,
      storageService: {},
      mediaIngestionService: {
        ingest: async () => ({
          media: mockSourceMedia,
          isNew: false,
          mediaId: mockSourceMedia.id,
          url: mockSourceMedia.url,
          width: 1344,
          height: 768,
        }),
      },
    });

    const result = await service.uploadSheetMedia({
      characterId: "char-wf-1",
      mediaId: "wf-sheet-source",
      projectId: "proj-1",
      userId: "user-1",
    });

    assert.equal(result.ok, true);
    assert.ok(linkedPayload, "Must link sheet media in workflow_media");
    assert.equal(linkedPayload.workflowId, "char-wf-1");
    assert.equal(linkedPayload.mediaId, "media-uuid-789");
    assert.equal(linkedPayload.role, "sheet");
    assert.deepEqual(updatedPrimaryMedia, { wfId: "char-wf-1", mediaId: "media-uuid-789" });
    assert.equal(characterFieldsUpdated.fields.status, "completed");
  });

  it("ElementMediaService.addReferenceMedia with workflow ID resolves source media and links relation", async () => {
    let linkedPayload = null;
    let updatedElement = null;

    const mockSourceMedia = {
      id: "media-elem-source-456",
      workflow_id: "wf-source-prop",
      url: "https://storage.example.com/prop.png",
      width: 1024,
      height: 1024,
      status: "success",
    };

    const mockDb = {
      elements: {
        resolveRecord: async (id) => ({ id, workflow_id: "elem-wf-1", project_id: "proj-1", source_images: [] }),
        update: async (id, patch) => {
          updatedElement = { id, patch };
          return {};
        },
      },
      workflows: {
        getWorkflow: async (id) => {
          if (id === "wf-source-prop") return { id: "wf-source-prop", primary_media_id: "media-elem-source-456" };
          return null;
        },
      },
      media: {
        findById: async (id) => (id === "media-elem-source-456" ? mockSourceMedia : null),
        findMediaByIdOrWorkflow: async (id) => (id === "wf-source-prop" ? mockSourceMedia : null),
        findByWorkflow: async (id) => (id === "wf-source-prop" ? [mockSourceMedia] : []),
        createMedia: async () => ({ id: "fail" }),
      },
      workflowMedia: {
        linkMedia: async (payload) => {
          linkedPayload = payload;
          return payload;
        },
      },
    };

    const service = new ElementMediaService({
      db: mockDb,
      storageService: {},
      mediaIngestionService: {
        ingest: async () => ({
          media: mockSourceMedia,
          isNew: false,
          mediaId: mockSourceMedia.id,
          url: mockSourceMedia.url,
          width: 1024,
          height: 1024,
        }),
      },
    });

    const result = await service.addReferenceMedia({
      elementId: "11111111-1111-4111-8111-111111111111",
      mediaId: "wf-source-prop",
      projectId: "proj-1",
      userId: "user-1",
    });

    assert.equal(result.media.id, "media-elem-source-456");
    assert.ok(linkedPayload, "Must link media to element in workflow_media");
    assert.equal(linkedPayload.workflowId, "elem-wf-1");
    assert.equal(linkedPayload.mediaId, "media-elem-source-456");
    assert.equal(linkedPayload.role, "detail");
    assert.deepEqual(updatedElement.patch.source_images, ["media-elem-source-456"]);
  });

  it("CharacterMediaService.removeDetailMedia unlinks workflow_media and keeps source media intact when linked from another workflow", async () => {
    let unlinkedPayload = null;
    let deleteByIdAndWorkflowCalled = false;
    let storageDeleteCalled = false;

    const mockDb = {
      workflows: {
        getWorkflow: async (id) => ({ id, project_id: "proj-1", user_id: "user-1", workflow_type: "CHARACTER" }),
      },
      media: {
        findById: async () => ({
          id: "media-uuid-456",
          workflow_id: "wf-source-123", // Belongs to an external source workflow!
          role: "detail",
          mediaRole: "detail",
          step_id: "character_detail",
          url: "https://storage.example.com/asset.png",
        }),
        deleteByIdAndWorkflow: async () => {
          deleteByIdAndWorkflowCalled = true;
        },
      },
      workflowMedia: {
        unlink: async (payload) => {
          unlinkedPayload = payload;
        },
        countLinksForMedia: async () => 1, // Still has original link
      },
    };

    const mockStorage = {
      deleteByUrl: async () => {
        storageDeleteCalled = true;
      },
    };

    const service = new CharacterMediaService({
      db: mockDb,
      storageService: mockStorage,
    });

    const result = await service.removeDetailMedia({
      characterId: "char-wf-1",
      mediaId: "media-uuid-456",
      userId: "user-1",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(unlinkedPayload, {
      workflowId: "char-wf-1",
      mediaId: "media-uuid-456",
      role: "detail",
    });
    assert.equal(deleteByIdAndWorkflowCalled, false, "Must NOT delete media row when linked from another workflow");
    assert.equal(storageDeleteCalled, false, "Must NOT delete storage file when linked from another workflow");
  });
});

