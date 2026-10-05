import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolveMediaMetadata } from "../../src/platform/media/mediaMetadataResolver.js";
import { calculateAspectRatio } from "../../src/utils/ratioUtils.js";

describe("D2.6 — Media Ratio & Dimension Preservation Boundary Tests", () => {
  after(() => {
    setTimeout(() => process.exit(0), 100);
  });
  it("TEST 1: resolveMediaMetadata extracts 16:9 from root ratio, root aspect_ratio, and parameters", () => {
    // 1a. Root ratio
    const fromRootRatio = resolveMediaMetadata({ ratio: "16:9" });
    assert.equal(fromRootRatio.aspect_ratio, "16:9");
    assert.equal(fromRootRatio.width, 1344);
    assert.equal(fromRootRatio.height, 768);

    // 1b. Root aspect_ratio
    const fromRootAspect = resolveMediaMetadata({ aspect_ratio: "16:9" });
    assert.equal(fromRootAspect.aspect_ratio, "16:9");
    assert.equal(fromRootAspect.width, 1344);
    assert.equal(fromRootAspect.height, 768);

    // 1c. Nested in parameters.ratio
    const fromParamsRatio = resolveMediaMetadata({ parameters: { ratio: "16:9" } });
    assert.equal(fromParamsRatio.aspect_ratio, "16:9");
    assert.equal(fromParamsRatio.width, 1344);
    assert.equal(fromParamsRatio.height, 768);

    // 1d. Nested in parameters.aspect_ratio
    const fromParamsAspect = resolveMediaMetadata({ parameters: { aspect_ratio: "16:9" } });
    assert.equal(fromParamsAspect.aspect_ratio, "16:9");
    assert.equal(fromParamsAspect.width, 1344);
    assert.equal(fromParamsAspect.height, 768);

    // 1e. 9:16 portrait
    const portrait = resolveMediaMetadata({ ratio: "9:16" });
    assert.equal(portrait.aspect_ratio, "9:16");
    assert.equal(portrait.width, 768);
    assert.equal(portrait.height, 1344);
  });

  it("TEST 2: calculateAspectRatio accurately snaps common aspect ratios without falling back to 1:1", () => {
    assert.equal(calculateAspectRatio(1920, 1080), "16:9");
    assert.equal(calculateAspectRatio(1280, 720), "16:9");
    assert.equal(calculateAspectRatio(1344, 768), "16:9");
    assert.equal(calculateAspectRatio(720, 1280), "9:16");
    assert.equal(calculateAspectRatio(1080, 1920), "9:16");
    assert.equal(calculateAspectRatio(1024, 1024), "1:1");
    assert.equal(calculateAspectRatio(1200, 800), "3:2");
    assert.equal(calculateAspectRatio(800, 600), "4:3");
  });

  it("TEST 3: V1StorageBridge createV1Placeholder uses resolveMediaMetadata instead of hardcoded 1024x1024", async () => {
    const { V1StorageBridge } = await import("../../src/v2/services/v1StorageBridge.js");
    let insertedMediaData = null;
    let insertedConfigData = null;

    const mockDb = {
      configs: {
        createConfig: async (cfg) => {
          insertedConfigData = cfg;
          return { id: "mock-cfg-id" };
        },
      },
      workflows: {
        createWorkflow: async (wf) => ({ id: "mock-wf-id", ...wf }),
        updatePrimaryMedia: async () => {},
      },
      media: {
        createMedia: async (m) => {
          insertedMediaData = m;
          return { id: "mock-media-id", ...m };
        },
      },
    };

    const bridge = new V1StorageBridge({ db: mockDb });

    await bridge.createV1Placeholder({
      userId: randomUUID(),
      projectId: randomUUID(),
      config: {
        prompt: "A cinematic scene",
        model: "nanobana_pro",
        ratio: "16:9", // Frontend passed 'ratio', not 'aspect_ratio'
      },
    });

    assert.ok(insertedConfigData, "Expected config to be created");
    assert.equal(
      insertedConfigData.aspect_ratio,
      "16:9",
      `Expected config.aspect_ratio to be 16:9, got ${insertedConfigData.aspect_ratio}`
    );

    assert.ok(insertedMediaData, "Expected media placeholder to be created");
    assert.equal(
      insertedMediaData.width,
      1344,
      `Expected media placeholder width to be 1344 for 16:9, got ${insertedMediaData.width}`
    );
    assert.equal(
      insertedMediaData.height,
      768,
      `Expected media placeholder height to be 768 for 16:9, got ${insertedMediaData.height}`
    );
  });

  it("TEST 4: V1StorageBridge finalizeV1Media preserves placeholder dimensions when asset has no width/height", async () => {
    const { V1StorageBridge } = await import("../../src/v2/services/v1StorageBridge.js");
    let updatedFields = null;

    const mockDb = {
      media: {
        findById: async (id) => ({
          id,
          width: 1344,
          height: 768,
        }),
        updateFields: async (id, fields) => {
          updatedFields = fields;
          return { id, ...fields };
        },
      },
    };

    const bridge = new V1StorageBridge({ db: mockDb });

    await bridge.finalizeV1Media("media-123", {
      url: "https://storage.example.com/asset.png",
      // width and height intentionally missing from provider output
    });

    assert.ok(updatedFields, "Expected media fields to be updated");
    assert.equal(
      updatedFields.width,
      1344,
      `Expected finalized width to preserve 1344, got ${updatedFields.width}`
    );
    assert.equal(
      updatedFields.height,
      768,
      `Expected finalized height to preserve 768, got ${updatedFields.height}`
    );
  });

  it("TEST 5: MediaWorkflowLifecycleService preserves ratio in generation_config and placeholder dimensions", async () => {
    const { MediaWorkflowLifecycleService } = await import("../../src/platform/media/MediaLifecycleService.js");
    let insertedMedia = null;
    let insertedConfig = null;
    let updatedMedia = null;

    const mockDb = {
      configs: {
        createConfig: async (cfg) => {
          insertedConfig = cfg;
          return { id: "cfg-123", ...cfg };
        },
      },
      workflows: {
        createWorkflow: async (wf) => ({ id: "wf-123", ...wf }),
        updatePrimaryMedia: async () => {},
      },
      media: {
        createMedia: async (m) => {
          insertedMedia = m;
          return { id: "m-123", ...m };
        },
        findById: async (id) => ({
          id,
          width: insertedMedia?.width || 1344,
          height: insertedMedia?.height || 768,
        }),
        updateFields: async (id, fields) => {
          updatedMedia = { id, ...fields };
          return updatedMedia;
        },
      },
    };

    const lifecycle = new MediaWorkflowLifecycleService({ db: mockDb });

    const result = await lifecycle.startPlaceholder({
      userId: randomUUID(),
      nodeType: "image-generation",
      input: {
        projectId: randomUUID(),
        prompt: "A neon cyberpunk cityscape",
        ratio: "16:9",
      },
    });

    assert.ok(result, "Placeholder result should not be null");
    assert.equal(insertedConfig.aspect_ratio, "16:9");
    assert.equal(insertedMedia.width, 1344);
    assert.equal(insertedMedia.height, 768);

    // Complete placeholder with asset lacking width/height
    const completed = await lifecycle.completePlaceholder("m-123", {
      url: "https://storage.example.com/cyberpunk.png",
    });

    assert.equal(completed, true);
    assert.equal(updatedMedia.width, 1344);
    assert.equal(updatedMedia.height, 768);
  });

  it("TEST 6: nodeExecutor executeNodePersistence preserves placeholder dimensions when provider asset lacks width/height", async () => {
    const { executeNodePersistence } = await import("../../src/v2/runner/nodeExecutor.js");

    let updatedMedia = null;
    const mockDb = {
      media: {
        findByWorkflow: async (wfId) => [
          {
            id: "placeholder-1",
            workflow_id: wfId,
            status: "processing",
            width: 1344,
            height: 768,
          },
        ],
        updateMedia: async (id, fields) => {
          updatedMedia = { id, ...fields };
          return updatedMedia;
        },
      },
    };

    await executeNodePersistence({
      nodeConfig: {
        id: "generate",
        persist: {
          target: "media",
          step_id: "image_generation",
          status: "completed",
        },
      },
      output: {
        assets: [{ url: "https://cdn.example.com/video.mp4" }], // width and height omitted
      },
      run: {
        targetWorkflowId: "wf-test-run",
        targetMediaIds: ["placeholder-1"],
      },
      resolvedInputs: {
        ratio: "16:9",
      },
      db: mockDb,
    });

    assert.ok(updatedMedia, "Expected updateMedia to be called");
    assert.equal(updatedMedia.width, 1344);
    assert.equal(updatedMedia.height, 768);
  });

  it("TEST 7: CharacterMediaService uploadDetailMedia preserves ingested 16:9 dimensions via resolveMediaMetadata", async () => {
    const { CharacterMediaService } = await import("../../src/domain/character/CharacterMediaService.js");

    let createdMediaRow = null;
    const mockDb = {
      workflows: {
        getWorkflow: async () => ({ id: "wf-char", project_id: "proj-1", user_id: "user-1" }),
      },
      media: {
        createMedia: async (m) => {
          createdMediaRow = m;
          return { id: "media-detail-1", ...m };
        },
      },
    };

    const mockIngestion = {
      ingest: async () => ({
        url: "https://storage.example.com/character-16-9.png",
        width: 1344,
        height: 768,
        ratio: "16:9",
      }),
    };

    const service = new CharacterMediaService({
      db: mockDb,
      storageService: {},
      mediaIngestionService: mockIngestion,
    });

    const res = await service.uploadDetailMedia({
      characterId: "char-123",
      imageUrl: "https://example.com/input.png",
    });

    assert.ok(res.ok);
    assert.equal(createdMediaRow.width, 1344);
    assert.equal(createdMediaRow.height, 768);
  });

  it("TEST 8: ElementMediaService fallback createMedia uses resolveMediaMetadata for non-1024 dimensions", async () => {
    const { ElementMediaService } = await import("../../src/domain/element/ElementMediaService.js");

    let createdMediaRow = null;
    const mockDb = {
      elements: {
        resolveRecord: async (id) => ({ id, workflow_id: "wf-elem", project_id: "proj-1" }),
        update: async () => {},
      },
      media: {
        createMedia: async (m) => {
          createdMediaRow = m;
          return { id: "elem-media-1", ...m };
        },
      },
      workflows: {
        updatePrimaryMedia: async () => {},
      },
    };

    // Instantiate without mediaIngestionService to test fallback path
    const service = new ElementMediaService({
      db: mockDb,
      storageService: {},
      mediaIngestionService: null,
    });

    await service.addReferenceMedia({
      elementId: "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d",
      projectId: "proj-1",
      userId: "user-1",
      source: {
        url: "https://example.com/ref.png",
        width: 1344,
        height: 768,
      },
    });

    assert.ok(createdMediaRow, "Expected media row to be created");
    assert.equal(createdMediaRow.width, 1344);
    assert.equal(createdMediaRow.height, 768);
  });
});
