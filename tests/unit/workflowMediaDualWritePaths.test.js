import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, useCaseService } from "../../src/container.js";
import { generateImage } from "../../controllers/imageController.js";
import { generateVideo } from "../../controllers/videoController.js";
import { CharacterGenerationService } from "../../src/domain/character/CharacterGenerationService.js";
import { CharacterMediaService } from "../../src/domain/character/CharacterMediaService.js";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";
import { createWorkflowWithMedia, appendMediaToWorkflow } from "../../src/db/workflowMediaOps.js";

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe("workflow_media dual-write paths", () => {
  const originals = {};

  beforeEach(() => {
    originals.projects = db.projects;
    originals.workflows = db.workflows;
    originals.media = db.media;
    originals.workflowMedia = db.workflowMedia;
    originals.prepareAndEnqueue = useCaseService.prepareAndEnqueue;
  });

  afterEach(() => {
    db.projects = originals.projects;
    db.workflows = originals.workflows;
    db.media = originals.media;
    db.workflowMedia = originals.workflowMedia;
    useCaseService.prepareAndEnqueue = originals.prepareAndEnqueue;
  });

  it("links image and video generation placeholders to workflow_media", async () => {
    const linkCalls = [];
    useCaseService.prepareAndEnqueue = async (params) => ({
      jobId: `${params.executionId}-job`,
      executionId: params.executionId,
      cost: { totalCredits: 1 },
    });
    db.projects = {
      findById: async (id) => ({ id, user_id: "user-1" }),
    };
    db.workflows = {
      createWorkflow: async (payload) => ({ id: payload.id, ...payload }),
      updateFields: async () => ({}),
    };
    db.media = {
      createMedia: async (payload) => ({ id: payload.id || `${payload.step_id}-media`, ...payload }),
      updateMedia: async (_id, payload) => payload,
    };
    db.workflowMedia = {
      linkMedia: async (payload) => {
        linkCalls.push(payload);
        return payload;
      },
    };

    const imageRes = makeRes();
    await generateImage({
      user: { id: "user-1" },
      body: { prompt: "mountain", projectId: "proj-1", model: "nanobana_2" },
    }, imageRes);

    const videoRes = makeRes();
    await generateVideo({
      user: { id: "user-1" },
      body: { prompt: "ocean", projectId: "proj-1", model: "wan_3_0" },
    }, videoRes);

    assert.equal(imageRes.body.ok, true);
    assert.equal(videoRes.body.ok, true);
    assert.equal(linkCalls.length, 2);
    assert.equal(linkCalls[0].workflowId, imageRes.body.workflowId);
    assert.equal(linkCalls[0].mediaId, imageRes.body.mediaId);
    assert.equal(linkCalls[0].stepId, "image_generation");
    assert.equal(linkCalls[1].workflowId, videoRes.body.workflowId);
    assert.equal(linkCalls[1].mediaId, videoRes.body.mediaId);
    assert.equal(linkCalls[1].stepId, "video_generation");
  });

  it("links character generation and character detail media to workflow_media", async () => {
    const linkCalls = [];
    const mockDb = {
      workflows: {
        getWorkflow: async (id) => ({ id, project_id: "proj-1", user_id: "user-1" }),
      },
      media: {
        createMedia: async (payload) => ({ id: `${payload.step_id}-media`, ...payload }),
      },
      workflowMedia: {
        linkMedia: async (payload) => {
          linkCalls.push(payload);
          return payload;
        },
      },
    };

    const generationService = new CharacterGenerationService({
      db: mockDb,
      useCaseService: {
        prepareAndEnqueue: async (params) => ({ executionId: params.executionId }),
      },
    });
    await generationService.enqueueSheetGeneration({
      characterId: "char-wf-1",
      prompt: "editorial hero",
      projectId: "proj-1",
      userId: "user-1",
    });

    const mediaService = new CharacterMediaService({
      db: mockDb,
      storageService: {},
      mediaIngestionService: {
        ingest: async () => ({
          url: "https://storage.example.com/detail.png",
          width: 1344,
          height: 768,
        }),
      },
    });
    await mediaService.uploadDetailMedia({
      characterId: "char-wf-1",
      imageUrl: "https://example.com/detail.png",
    });

    assert.deepEqual(linkCalls, [
      { workflowId: "char-wf-1", mediaId: "character_sheet-media", stepId: "character_sheet", workflowType: "CHARACTER" },
      { workflowId: "char-wf-1", mediaId: "character_detail-media", stepId: "character_detail", workflowType: "CHARACTER" },
    ]);
  });

  it("links element sheet and reference media to workflow_media", async () => {
    const linkCalls = [];
    const mockDb = {
      elements: {
        resolveRecord: async (id) => ({ id, workflow_id: "elem-wf-1", project_id: "proj-1", source_images: [] }),
        update: async () => ({}),
      },
      workflows: {
        updatePrimaryMedia: async () => ({}),
      },
      media: {
        createMedia: async (payload) => ({ id: `${payload.step_id}-media`, ...payload }),
      },
      workflowMedia: {
        linkMedia: async (payload) => {
          linkCalls.push(payload);
          return payload;
        },
      },
    };
    const service = new ElementMediaService({
      db: mockDb,
      storageService: {},
      mediaIngestionService: null,
    });

    await service.setSheetMedia({
      elementId: "11111111-1111-4111-8111-111111111111",
      source: { url: "https://example.com/sheet.png", width: 1344, height: 768 },
    });
    await service.addReferenceMedia({
      elementId: "11111111-1111-4111-8111-111111111111",
      source: { url: "https://example.com/ref.png", width: 1024, height: 1024 },
    });

    assert.deepEqual(linkCalls, [
      { workflowId: "elem-wf-1", mediaId: "element_sheet-media", stepId: "element_sheet", workflowType: "ELEMENT_SHEET" },
      { workflowId: "elem-wf-1", mediaId: "element_reference-media", stepId: "element_reference", workflowType: "ELEMENT" },
    ]);
  });

  it("links workflowMediaOps create and append media to workflow_media", async () => {
    const linkCalls = [];
    const mockDb = {
      workflows: {
        createWorkflow: async (payload) => ({ id: "wf-created", ...payload }),
        updatePrimaryMedia: async () => ({}),
      },
      media: {
        createMedia: async (payload) => ({ id: `${payload.workflow_id}-${payload.step_id}-media`, ...payload }),
      },
      workflowMedia: {
        linkMedia: async (payload) => {
          linkCalls.push(payload);
          return payload;
        },
      },
    };

    await createWorkflowWithMedia(mockDb, {
      workflowData: { project_id: "proj-1", display_name: "Generated", workflow_type: "GENERATION" },
      mediaData: { project_id: "proj-1", step_id: "image_generation", width: 1024, height: 1024 },
    });
    await appendMediaToWorkflow(mockDb, {
      workflow_id: "wf-created",
      mediaData: { project_id: "proj-1", step_id: "element_reference", width: 1024, height: 1024 },
    });

    assert.deepEqual(linkCalls, [
      { workflowId: "wf-created", mediaId: "wf-created-image_generation-media", stepId: "image_generation", workflowType: "GENERATION" },
      { workflowId: "wf-created", mediaId: "wf-created-element_reference-media", stepId: "element_reference" },
    ]);
  });
});
