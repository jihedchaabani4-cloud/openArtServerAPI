import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, useCaseService } from "../../src/container.js";
import { generateImage } from "../../controllers/imageController.js";
import { generateVideo } from "../../controllers/videoController.js";
import { CharacterGenerationService } from "../../src/domain/character/CharacterGenerationService.js";
import { CharacterMediaService } from "../../src/domain/character/CharacterMediaService.js";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";
import { MediaService } from "../../src/platform/media/MediaService.js";
import { WorkflowMediaService } from "../../src/platform/workflow/WorkflowMediaService.js";
import { MediaRepository } from "../../src/db/MediaRepository.js";
import { ElementRepository } from "../../src/db/ElementRepository.js";
import { createWorkflowWithMedia, appendMediaToWorkflow } from "../../src/db/workflowMediaOps.js";
import * as workflowMediaLinker from "../../src/db/workflowMediaLinker.js";

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

describe("workflow_media write helper (B1) — workflow_media ONLY, no media.workflow_id", () => {
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

  it("createMediaInWorkflow({ workflowId, mediaId, role }) writes strictly to workflow_media and never touches media", async () => {
    assert.equal(typeof workflowMediaLinker.createMediaInWorkflow, "function", "createMediaInWorkflow must be exported");

    const linkCalls = [];
    let mediaTouched = false;
    db.media = {
      createMedia: async () => { mediaTouched = true; },
      updateFields: async () => { mediaTouched = true; },
    };
    db.workflowMedia = {
      linkMedia: async (payload) => {
        linkCalls.push(payload);
        return { workflow_id: payload.workflowId, media_id: payload.mediaId, role: payload.role };
      },
    };

    const res = await workflowMediaLinker.createMediaInWorkflow({
      workflowId: "wf-strict-1",
      mediaId: "media-strict-1",
      role: "output",
    });

    assert.equal(mediaTouched, false, "createMediaInWorkflow must NEVER write to media table");
    assert.equal(linkCalls.length, 1);
    assert.deepEqual(linkCalls[0], {
      workflowId: "wf-strict-1",
      mediaId: "media-strict-1",
      role: "output",
    });
    assert.equal(res.workflow_id, "wf-strict-1");
  });

  it("MediaRepository.createMedia does NOT insert workflow_id into media even if passed", async () => {
    let insertedPayload = null;
    const repo = new MediaRepository();
    repo.client = () => ({
      from: (table) => {
        assert.equal(table, "media");
        return {
          insert: (payload) => {
            insertedPayload = payload;
            return {
              select: () => ({
                single: async () => ({ data: { id: "m-1", ...payload }, error: null }),
              }),
            };
          },
        };
      },
    });

    await repo.createMedia({
      workflow_id: "should-be-stripped",
      project_id: "proj-1",
      generation_config_id: "cfg-1",
      step_id: "CAE",
      url: "https://cdn.example.com/cae.png",
      width: 1024,
      height: 1024,
      status: "success",
    });

    assert.ok(insertedPayload, "insert must be called");
    assert.equal("workflow_id" in insertedPayload, false, "workflow_id must NOT be present in media insert payload");
    assert.equal(insertedPayload.project_id, "proj-1");
    assert.equal(insertedPayload.step_id, "CAE");
  });

  it("Path 1 (Uploads / MediaService) & Path 5 (CAE): creates media without workflow_id and links via workflow_media", async () => {
    const createMediaPayloads = [];
    const linkCalls = [];
    const service = new MediaService({
      db: {
        media: {
          createMedia: async (payload) => {
            createMediaPayloads.push(payload);
            return { id: `${payload.step_id}-media`, ...payload };
          },
        },
        workflowMedia: {
          linkMedia: async (payload) => {
            linkCalls.push(payload);
            return payload;
          },
        },
      },
    });

    await service.createMedia({
      workflowId: "wf-upload-1",
      projectId: "proj-1",
      stepId: "upload",
      url: "https://cdn.example.com/upload.png",
    });

    await service.createMedia({
      workflowId: "wf-cae-1",
      projectId: "proj-1",
      stepId: "CAE",
      url: "https://cdn.example.com/cae.png",
    });

    assert.equal(createMediaPayloads.length, 2);
    assert.equal("workflow_id" in createMediaPayloads[0], false, "Upload createMedia must not pass workflow_id");
    assert.equal("workflow_id" in createMediaPayloads[1], false, "CAE createMedia must not pass workflow_id");
    assert.deepEqual(linkCalls, [
      { workflowId: "wf-upload-1", mediaId: "upload-media", stepId: "upload" },
      { workflowId: "wf-cae-1", mediaId: "CAE-media", stepId: "CAE" },
    ]);
  });

  it("Path 2 (Image and video generation): links placeholders to workflow_media without writing workflow_id to media", async () => {
    const linkCalls = [];
    const mediaCreateCalls = [];
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
      createMedia: async (payload) => {
        mediaCreateCalls.push(payload);
        return { id: payload.id || `${payload.step_id}-media`, ...payload };
      },
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
    assert.equal(mediaCreateCalls.length, 2);
    assert.equal("workflow_id" in mediaCreateCalls[0], false, "generateImage must not write workflow_id to media");
    assert.equal("workflow_id" in mediaCreateCalls[1], false, "generateVideo must not write workflow_id to media");
    assert.equal(linkCalls.length, 2);
    assert.equal(linkCalls[0].workflowId, imageRes.body.workflowId);
    assert.equal(linkCalls[0].mediaId, imageRes.body.mediaId);
    assert.equal(linkCalls[0].stepId, "image_generation");
    assert.equal(linkCalls[1].workflowId, videoRes.body.workflowId);
    assert.equal(linkCalls[1].mediaId, videoRes.body.mediaId);
    assert.equal(linkCalls[1].stepId, "video_generation");
  });

  it("Path 3 (Character generation & sheet/detail uploads): links to workflow_media without writing workflow_id to media", async () => {
    const linkCalls = [];
    const mediaCreateCalls = [];
    const mockDb = {
      workflows: {
        getWorkflow: async (id) => ({ id, project_id: "proj-1", user_id: "user-1" }),
        updatePrimaryMedia: async () => ({}),
      },
      characters: {
        updateCharacterFields: async () => ({}),
      },
      media: {
        findByWorkflow: async () => [],
        createMedia: async (payload) => {
          mediaCreateCalls.push(payload);
          return { id: `${payload.step_id}-media`, ...payload };
        },
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
    await mediaService.uploadSheetMedia({
      characterId: "char-wf-1",
      imageUrl: "https://example.com/sheet.png",
    });
    await mediaService.uploadDetailMedia({
      characterId: "char-wf-1",
      imageUrl: "https://example.com/detail.png",
    });

    for (const call of mediaCreateCalls) {
      assert.equal("workflow_id" in call, false, "Character media creation must not pass workflow_id");
    }
    assert.deepEqual(linkCalls, [
      { workflowId: "char-wf-1", mediaId: "character_sheet-media", stepId: "character_sheet", workflowType: "CHARACTER" },
      { workflowId: "char-wf-1", mediaId: "character_sheet-media", stepId: "character_sheet", workflowType: "CHARACTER" },
      { workflowId: "char-wf-1", mediaId: "character_detail-media", stepId: "character_detail", workflowType: "CHARACTER" },
    ]);
  });

  it("Path 4 (Element sheet & reference uploads): links to workflow_media, does NOT write workflow_id to media or primary_media_id to element", async () => {
    const linkCalls = [];
    const mediaCreateCalls = [];
    const elementUpdateCalls = [];
    const mockDb = {
      elements: {
        resolveRecord: async (id) => ({ id, workflow_id: "elem-wf-1", project_id: "proj-1", source_images: [] }),
        update: async (id, patch) => {
          elementUpdateCalls.push({ id, patch });
          return {};
        },
      },
      workflows: {
        updatePrimaryMedia: async () => ({}),
      },
      media: {
        createMedia: async (payload) => {
          mediaCreateCalls.push(payload);
          return { id: `${payload.step_id}-media`, ...payload };
        },
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
    await service.ingestElementSources({
      workflowId: "elem-wf-1",
      sourceImages: ["https://example.com/s1.png"],
      projectId: "proj-1",
      userId: "user-1",
    });

    for (const call of mediaCreateCalls) {
      assert.equal("workflow_id" in call, false, "Element media creation must not pass workflow_id");
    }
    for (const u of elementUpdateCalls) {
      assert.equal("primary_media_id" in u.patch, false, "ElementMediaService must not write primary_media_id to element");
    }
    assert.deepEqual(linkCalls, [
      { workflowId: "elem-wf-1", mediaId: "element_sheet-media", stepId: "element_sheet", workflowType: "ELEMENT_SHEET" },
      { workflowId: "elem-wf-1", mediaId: "element_reference-media", stepId: "element_reference", workflowType: "ELEMENT" },
      { workflowId: "elem-wf-1", mediaId: "element_sheet-media", stepId: "element_sheet", workflowType: "ELEMENT_SHEET" },
    ]);
  });

  it("workflowMediaOps createWorkflowWithMedia and appendMediaToWorkflow do NOT pass workflow_id to media.createMedia", async () => {
    const linkCalls = [];
    const mediaCreateCalls = [];
    const mockDb = {
      workflows: {
        createWorkflow: async (payload) => ({ id: "wf-created", ...payload }),
        updatePrimaryMedia: async () => ({}),
      },
      media: {
        createMedia: async (payload) => {
          mediaCreateCalls.push(payload);
          return { id: `${payload.step_id}-media`, ...payload };
        },
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
      mediaData: { project_id: "proj-1", step_id: "CAE", width: 1024, height: 1024 },
    });

    assert.equal("workflow_id" in mediaCreateCalls[0], false);
    assert.equal("workflow_id" in mediaCreateCalls[1], false);
    assert.deepEqual(linkCalls, [
      { workflowId: "wf-created", mediaId: "image_generation-media", stepId: "image_generation", workflowType: "GENERATION" },
      { workflowId: "wf-created", mediaId: "CAE-media", stepId: "CAE" },
    ]);
  });

  it("WorkflowMediaService.detachMedia uses workflow_media instead of media.workflow_id", async () => {
    const mediaUpdateCalls = [];
    const unlinkedCalls = [];
    const linkedCalls = [];

    const service = new WorkflowMediaService({
      db: {
        media: {
          client: () => ({
            from: () => ({
              select: (cols) => {
                assert.equal(cols.includes("workflow_id"), false, "detachMedia must not select workflow!workflow_id join");
                return {
                  eq: () => ({
                    single: async () => ({
                      data: { id: "m-detach-1", status: "success", project_id: "proj-1", step_id: "image_generation" },
                      error: null,
                    }),
                  }),
                };
              },
            }),
          }),
          updateFields: async (id, fields) => {
            mediaUpdateCalls.push({ id, fields });
            return { id, ...fields };
          },
          findByWorkflow: async () => [{ id: "m-remaining" }],
        },
        workflows: {
          createWorkflow: async (data) => ({ id: "wf-new-detached", ...data }),
          updateFields: async (id, fields) => ({ id, ...fields }),
          findById: async (id) => ({ id, primary_media_id: "m-detach-1", project_id: "proj-1", display_name: "Original" }),
        },
        workflowMedia: {
          findByMedia: async () => [{ workflow_id: "wf-old-1", media_id: "m-detach-1", role: "output" }],
          unlink: async (args) => { unlinkedCalls.push(args); },
          linkMedia: async (args) => { linkedCalls.push(args); return args; },
        },
      },
      storageService: {},
      authService: { verifyMediaOwnership: async () => true },
    });

    await service.detachMedia({ mediaId: "m-detach-1", userId: "user-1" });

    for (const u of mediaUpdateCalls) {
      assert.equal("workflow_id" in u.fields, false, "detachMedia must not update media.workflow_id");
    }
    assert.equal(unlinkedCalls.length, 1);
    assert.equal(unlinkedCalls[0].workflowId, "wf-old-1");
    assert.equal(linkedCalls.length, 1);
    assert.equal(linkedCalls[0].workflowId, "wf-new-detached");
  });

  it("CharacterMediaService._resolveSourceMedia and ElementMediaService._resolveSourceMedia resolve workflow context via workflow_media, not sourceMedia.workflow_id", async () => {
    const mockDb = {
      media: {
        findById: async (id) => (id === "m-source-1" ? { id: "m-source-1", url: "https://cdn.example.com/1.png", status: "success" } : null),
      },
      workflowMedia: {
        findByMedia: async (id) => (id === "m-source-1" ? [{ workflow_id: "wf-owner-1", media_id: "m-source-1" }] : []),
      },
      workflows: {
        getWorkflow: async (id) => (id === "wf-owner-1" ? { id: "wf-owner-1", user_id: "other-user", project_id: "proj-1" } : null),
      },
    };

    const charService = new CharacterMediaService({ db: mockDb, storageService: {} });
    const elemService = new ElementMediaService({ db: mockDb, storageService: {} });

    await assert.rejects(
      () => charService._resolveSourceMedia("m-source-1", { userId: "user-1", projectId: "proj-1" }),
      (err) => err.statusCode === 404
    );
    await assert.rejects(
      () => elemService._resolveSourceMedia("m-source-1", { userId: "user-1", projectId: "proj-1" }),
      (err) => err.statusCode === 404
    );
  });
});

