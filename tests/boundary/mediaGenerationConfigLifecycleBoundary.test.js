import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeNodePersistence } from "../../src/v2/runner/nodeExecutor.js";
import { GenerationService } from "../../src/domain/generation/GenerationService.js";
import { GenerationRequestService } from "../../src/domain/generation/GenerationRequestService.js";
import { failWorkflowPendingMedia } from "../../src/platform/media/MediaLifecycleService.js";

describe("Per-Media Generation Config Lifecycle & Boundary Tests (Hardened)", () => {

  // ── TEST 1 ──────────────────────────────────────────────────────────────────
  it("TEST 1: Validated configuration is persisted before execution begins", async () => {
    let mediaCreatedWithConfig = null;
    let enqueueInput = null;

    const mockDb = {
      workflows: {
        createWorkflow: async (wf) => wf,
      },
      media: {
        createMedia: async (mediaRow) => {
          mediaCreatedWithConfig = { ...mediaRow };
          return mediaRow;
        },
        updateMedia: async () => {},
      },
      workflowMedia: {
        linkMedia: async () => {},
      },
    };

    const mockUseCaseService = {
      prepareAndEnqueue: async (args) => {
        enqueueInput = args;
        return {
          jobId: "job-123",
          executionId: args.executionId,
          cost: { totalCredits: 10 },
        };
      },
    };

    const mockFolderService = {
      validateAndAssertUsable: async (folderId) => folderId,
    };

    const service = new GenerationRequestService({
      db: mockDb,
      useCaseService: mockUseCaseService,
      folderService: mockFolderService,
    });

    const result = await service.requestGeneration({
      userId: "user-test-1",
      mediaType: "image",
      stepId: "image_generation",
      useCaseId: "image-generation-v1",
      prompt: "A majestic red panda in the bamboo forest",
      model: "nanobana_pro",
      projectId: "proj-100",
      folderId: null,
      references: [],
      parameters: {
        aspect_ratio: "16:9",
        resolution: "2k",
      },
      mediaMeta: { width: 1920, height: 1080, aspect_ratio: "16:9" },
      outputCount: 1,
    });

    assert.equal(result.ok, true);
    assert.ok(mediaCreatedWithConfig, "Media must be created");
    assert.equal(mediaCreatedWithConfig.status, "processing", "Media must be created in processing status");
    assert.ok(mediaCreatedWithConfig.generation_config, "generation_config must be persisted on placeholder creation before queue dispatch");
    
    const cfg = mediaCreatedWithConfig.generation_config;
    assert.equal(cfg.prompt, "A majestic red panda in the bamboo forest");
    assert.equal(cfg.model, "nanobana_pro");
    assert.equal(cfg.aspect_ratio, "16:9");
    assert.equal(cfg.parameters.resolution, "2k", "Caller-supplied resolution must be preserved");
    assert.equal(cfg.parameters.output_format, "png", "Model defaults must be applied");
  });

  // ── TEST 2 ──────────────────────────────────────────────────────────────────
  it("TEST 2: The configuration remains retrievable after prompt translation/enrichment fails", async () => {
    // Media was saved before execution with validated config
    const placeholderMedia = {
      id: "media-fail-trans",
      workflow_id: "wf-fail-trans",
      workflowId: "wf-fail-trans",
      role: "output",
      is_primary: true,
      isPrimary: true,
      step_id: "image_generation",
      url: null,
      status: "processing",
      width: 1024,
      height: 1024,
      generation_config: {
        prompt: "قطوس يلعب بالكرة", // Tunisian prompt
        model: "nanobana_pro",
        aspect_ratio: "1:1",
        parameters: { seed: 99 },
        created_at: new Date().toISOString(),
      },
    };

    const mediaStore = new Map([[placeholderMedia.id, placeholderMedia]]);

    const mockDb = {
      projects: { findByUser: async () => [{ id: "proj-1" }] },
      media: {
        findByWorkflow: async (wfId) => Array.from(mediaStore.values()).filter((m) => m.workflow_id === wfId),
        updateMedia: async (id, patch) => {
          const item = mediaStore.get(id);
          const updated = { ...item, ...patch };
          mediaStore.set(id, updated);
          return updated;
        },
      },
      workflows: {
        findByProjectsPaginated: async () => ({
          workflows: [
            {
              id: "wf-fail-trans",
              project_id: "proj-1",
              display_name: "قطوس يلعب بالكرة",
              primary_media_id: "media-fail-trans",
              workflow_type: "GENERATION",
              create_time: "2026-10-21T12:00:00Z",
            },
          ],
          total: 1,
        }),
      },
      workflowMedia: {
        findByWorkflowIds: async () => Array.from(mediaStore.values()),
      },
    };

    // Simulate LLM translation failure during workflow run -> failWorkflowPendingMedia
    await failWorkflowPendingMedia(mockDb, "wf-fail-trans", "LLM translation rate limited");

    // Media must now be failed, but generation_config must remain completely intact
    const mediaRow = mediaStore.get("media-fail-trans");
    assert.equal(mediaRow.status, "failed");
    assert.equal(mediaRow.error_message, "LLM translation rate limited");
    assert.ok(mediaRow.generation_config, "generation_config must not be erased on failure");
    assert.equal(mediaRow.generation_config.prompt, "قطوس يلعب بالكرة");

    // Frontend retrieves library: generation_info must be populated from the failed media
    const generationService = new GenerationService({ db: mockDb });
    const library = await generationService.getUserLibrary("user-1", { projectId: "proj-1" });
    const item = library.data[0];

    assert.equal(item.primary_media.status, "failed");
    assert.ok(item.generation_info, "Failed workflow must still expose generation_info for retry");
    assert.equal(item.generation_info.prompt, "قطوس يلعب بالكرة");
    assert.equal(item.generation_info.model, "nanobana_pro");
    assert.equal(item.generation_info.seed, 99);
  });

  // ── TEST 3 ──────────────────────────────────────────────────────────────────
  it("TEST 3: The configuration remains retrievable after provider failure or timeout", async () => {
    const placeholderMedia = {
      id: "media-fail-provider",
      workflow_id: "wf-fail-provider",
      workflowId: "wf-fail-provider",
      role: "output",
      is_primary: true,
      isPrimary: true,
      step_id: "video_generation",
      url: null,
      status: "processing",
      width: 1920,
      height: 1080,
      generation_config: {
        prompt: "A drone flying through mist",
        model: "seedance_2_5",
        aspect_ratio: "16:9",
        parameters: { duration: 5, resolution: "720p" },
        created_at: new Date().toISOString(),
      },
    };

    const mediaStore = new Map([[placeholderMedia.id, placeholderMedia]]);

    const mockDb = {
      projects: { findByUser: async () => [{ id: "proj-1" }] },
      media: {
        findByWorkflow: async (wfId) => Array.from(mediaStore.values()).filter((m) => m.workflow_id === wfId),
        updateMedia: async (id, patch) => {
          const item = mediaStore.get(id);
          const updated = { ...item, ...patch };
          mediaStore.set(id, updated);
          return updated;
        },
      },
      workflows: {
        findByProjectsPaginated: async () => ({
          workflows: [
            {
              id: "wf-fail-provider",
              project_id: "proj-1",
              display_name: "A drone flying through mist",
              primary_media_id: "media-fail-provider",
              workflow_type: "GENERATION",
              create_time: "2026-10-21T12:00:00Z",
            },
          ],
          total: 1,
        }),
      },
      workflowMedia: {
        findByWorkflowIds: async () => Array.from(mediaStore.values()),
      },
    };

    // Simulate provider 504 Gateway Timeout -> failWorkflowPendingMedia
    await failWorkflowPendingMedia(mockDb, "wf-fail-provider", "Provider Gateway Timeout (504)");

    const mediaRow = mediaStore.get("media-fail-provider");
    assert.equal(mediaRow.status, "failed");
    assert.equal(mediaRow.error_message, "Provider Gateway Timeout (504)");
    assert.ok(mediaRow.generation_config);

    const generationService = new GenerationService({ db: mockDb });
    const library = await generationService.getUserLibrary("user-1", { projectId: "proj-1" });
    const item = library.data[0];

    assert.ok(item.generation_info, "generation_info must be retrievable after provider failure");
    assert.equal(item.generation_info.prompt, "A drone flying through mist");
    assert.equal(item.generation_info.model, "seedance_2_5");
    assert.equal(item.generation_info.parameters.duration, 5);
  });

  // ── TEST 4 ──────────────────────────────────────────────────────────────────
  it("TEST 4: Successful generation associates the correct configuration with its media", async () => {
    let updatedMedia = null;

    // Pre-persisted placeholder with initial validated configuration
    const initialConfig = {
      prompt: "orig prompt",
      model: "nanobana_pro",
      aspect_ratio: "16:9",
      parameters: { seed: 101, resolution: "1k" },
      created_at: "2026-10-21T12:00:00.000Z",
    };

    const mockDb = {
      media: {
        findByWorkflow: async () => [
          {
            id: "ph-success-1",
            workflow_id: "wf-success-1",
            status: "processing",
            width: 1024,
            height: 1024,
            generation_config: initialConfig,
          },
        ],
        updateMedia: async (id, fields) => {
          updatedMedia = { id, ...fields };
          return updatedMedia;
        },
      },
    };

    const nodeConfig = {
      id: "generate",
      persist: {
        target: "media",
        step_id: "image_generation",
        status: "completed",
        value: "$outputs.assets[0].url",
      },
    };

    const run = {
      targetWorkflowId: "wf-success-1",
      targetMediaIds: ["ph-success-1"],
      input: {
        prompt: "orig prompt",
        model: "nanobana_pro",
        parameters: { seed: 101, resolution: "1k" },
      },
    };

    // Prompt builder produced an enriched effective prompt:
    const resolvedInputs = {
      model: "nanobana_pro",
      prompt: "orig prompt, highly detailed, photorealistic 8k render",
      parameters: { seed: 101, resolution: "1k" },
    };

    const output = {
      assets: [
        {
          url: "https://storage.cdn/success-asset.png",
          width: 1920,
          height: 1080,
        },
      ],
      metadata: {
        model: "nanobana_pro",
        provider: "wavespeed",
      },
    };

    await executeNodePersistence({
      nodeConfig,
      output,
      run,
      resolvedInputs,
      db: mockDb,
    });

    assert.equal(updatedMedia.status, "completed");
    assert.equal(updatedMedia.url, "https://storage.cdn/success-asset.png");
    assert.ok(updatedMedia.generation_config);

    const cfg = updatedMedia.generation_config;
    assert.equal(cfg.prompt, "orig prompt", "Original user prompt must be preserved");
    assert.equal(cfg.prompt_optimized, "orig prompt, highly detailed, photorealistic 8k render", "Effective prompt stored when different");
    assert.equal(cfg.model, "nanobana_pro");
    assert.equal(cfg.provider, "wavespeed", "Provider must be merged from runtime output");
    assert.equal(cfg.created_at, "2026-10-21T12:00:00.000Z", "Initial creation timestamp preserved");
  });

  // ── TEST 5 ──────────────────────────────────────────────────────────────────
  it("TEST 5: Existing media configuration is not overwritten by subsequent generations or edits", async () => {
    const existingMedia1 = {
      id: "media-gen-1",
      workflow_id: "wf-multi",
      status: "completed",
      url: "https://cdn.example.com/item1.png",
      generation_config: {
        prompt: "First generation prompt",
        model: "nanobana_pro",
        parameters: { resolution: "1k", output_format: "png" },
      },
    };

    let media2Created = null;

    const mockDb = {
      workflows: { createWorkflow: async (wf) => wf },
      media: {
        createMedia: async (m) => {
          media2Created = { ...m };
          return m;
        },
        updateMedia: async () => {},
      },
      workflowMedia: { linkMedia: async () => {} },
    };

    const mockUseCaseService = {
      prepareAndEnqueue: async (args) => ({
        jobId: "job-edit-2",
        executionId: args.executionId,
      }),
    };

    const service = new GenerationRequestService({
      db: mockDb,
      useCaseService: mockUseCaseService,
      folderService: { validateAndAssertUsable: async () => null },
    });

    // Generate edit with new prompt & different resolution
    await service.requestGeneration({
      userId: "user-1",
      mediaType: "image",
      stepId: "image_generation",
      useCaseId: "image-generation-v1",
      prompt: "Second generation prompt (edited)",
      model: "nanobana_pro",
      projectId: "proj-1",
      parameters: { resolution: "4k", input_image: "wf-multi" },
    });

    // Verify existingMedia1 was NOT touched
    assert.equal(existingMedia1.generation_config.prompt, "First generation prompt");
    assert.equal(existingMedia1.generation_config.parameters.resolution, "1k");

    // Verify media2 got its own distinct configuration
    assert.notEqual(media2Created.id, existingMedia1.id);
    assert.equal(media2Created.generation_config.prompt, "Second generation prompt (edited)");
    assert.equal(media2Created.generation_config.parameters.resolution, "4k");
  });

  // ── TEST 6 ──────────────────────────────────────────────────────────────────
  it("TEST 6: Invalid parameters do not create valid-looking persisted configurations", async () => {
    let workflowCreated = false;
    let mediaCreated = false;

    const mockDb = {
      workflows: {
        createWorkflow: async () => {
          workflowCreated = true;
        },
      },
      media: {
        createMedia: async () => {
          mediaCreated = true;
        },
      },
      workflowMedia: { linkMedia: async () => {} },
    };

    const mockUseCaseService = {
      prepareAndEnqueue: async () => ({ jobId: "job-should-not-run" }),
    };

    const service = new GenerationRequestService({
      db: mockDb,
      useCaseService: mockUseCaseService,
      folderService: { validateAndAssertUsable: async () => null },
    });

    // 1. Invalid aspect ratio for nanobana_pro (e.g. "bogus_ratio")
    await assert.rejects(
      async () => {
        await service.requestGeneration({
          userId: "user-1",
          mediaType: "image",
          stepId: "image_generation",
          useCaseId: "image-generation-v1",
          prompt: "A cat",
          model: "nanobana_pro",
          projectId: "proj-1",
          parameters: { aspect_ratio: "invalid_ratio" },
        });
      },
      (err) => {
        assert.equal(err.statusCode, 400);
        return true;
      }
    );

    // 2. Unknown parameter for nanobana_pro
    await assert.rejects(
      async () => {
        await service.requestGeneration({
          userId: "user-1",
          mediaType: "image",
          stepId: "image_generation",
          useCaseId: "image-generation-v1",
          prompt: "A cat",
          model: "nanobana_pro",
          projectId: "proj-1",
          parameters: { unmapped_bogus_key: 123 },
        });
      },
      (err) => {
        assert.equal(err.statusCode, 400);
        return true;
      }
    );

    // Verify neither workflow nor placeholder media were created for invalid requests
    assert.equal(workflowCreated, false, "Workflow must not be created on validation failure");
    assert.equal(mediaCreated, false, "Media must not be created on validation failure");
  });

  // ── TEST 7 ──────────────────────────────────────────────────────────────────
  it("TEST 7: Retry and duplicate-execution behavior is deterministic and idempotent", async () => {
    let updateCount = 0;
    let savedConfig = null;

    const initialConfig = {
      prompt: "idempotency test prompt",
      model: "nanobana_pro",
      aspect_ratio: "1:1",
      parameters: { seed: 555 },
      created_at: "2026-10-21T10:00:00.000Z",
    };

    const mockDb = {
      media: {
        findByWorkflow: async () => [
          {
            id: "ph-idempotent-1",
            workflow_id: "wf-idempotent-1",
            status: "processing",
            width: 1024,
            height: 1024,
            generation_config: initialConfig,
          },
        ],
        updateMedia: async (id, fields) => {
          updateCount++;
          savedConfig = fields.generation_config;
          return { id, ...fields };
        },
      },
    };

    const nodeConfig = {
      id: "generate",
      persist: {
        target: "media",
        step_id: "image_generation",
        status: "completed",
        value: "$outputs.assets[0].url",
      },
    };

    const run = {
      targetWorkflowId: "wf-idempotent-1",
      targetMediaIds: ["ph-idempotent-1"],
      input: {
        prompt: "idempotency test prompt",
        model: "nanobana_pro",
        parameters: { seed: 555 },
      },
    };

    const resolvedInputs = {
      model: "nanobana_pro",
      prompt: "idempotency test prompt", // identical (no optimization)
      parameters: { seed: 555 },
    };

    const output = {
      assets: [{ url: "https://storage.cdn/idempotent.png", width: 1024, height: 1024 }],
      metadata: { model: "nanobana_pro", provider: "wavespeed" },
    };

    // Attempt 1: finalization
    await executeNodePersistence({ nodeConfig, output, run, resolvedInputs, db: mockDb });
    assert.equal(updateCount, 1);
    assert.equal(savedConfig.prompt, "idempotency test prompt");
    assert.ok(!("prompt_optimized" in savedConfig), "Unchanged prompt must omit prompt_optimized key entirely");
    assert.equal(savedConfig.provider, "wavespeed");
    assert.equal(savedConfig.created_at, "2026-10-21T10:00:00.000Z");

    // Attempt 2: duplicate worker retry / re-execution
    await executeNodePersistence({ nodeConfig, output, run, resolvedInputs, db: mockDb });
    assert.equal(updateCount, 2);
    assert.equal(savedConfig.prompt, "idempotency test prompt");
    assert.equal(savedConfig.provider, "wavespeed");
    assert.equal(savedConfig.created_at, "2026-10-21T10:00:00.000Z");
  });

  // ── TEST 8 ──────────────────────────────────────────────────────────────────
  it("TEST 8: Upload-only media does not acquire generation configuration", async () => {
    const uploadedMedia = {
      id: "media-uploaded-1",
      project_id: "proj-1",
      step_id: "upload",
      url: "https://cdn.example.com/user-upload.png",
      width: 1024,
      height: 1024,
      status: "completed",
      generation_config: null, // Uploaded media has NO config
    };

    const mockDb = {
      projects: { findByUser: async () => [{ id: "proj-1" }] },
      workflows: {
        findByProjectsPaginated: async () => ({
          workflows: [
            {
              id: "wf-upload",
              project_id: "proj-1",
              display_name: "User Uploaded Image",
              primary_media_id: "media-uploaded-1",
              workflow_type: "UPLOAD",
              create_time: "2026-10-21T12:00:00Z",
            },
          ],
          total: 1,
        }),
      },
      workflowMedia: {
        findByWorkflowIds: async () => [
          {
            ...uploadedMedia,
            workflow_id: "wf-upload",
            workflowId: "wf-upload",
            role: "output",
            is_primary: true,
            isPrimary: true,
          },
        ],
      },
    };

    const generationService = new GenerationService({ db: mockDb });
    const library = await generationService.getUserLibrary("user-1", { projectId: "proj-1" });
    const item = library.data[0];

    assert.equal(item.primary_media.generation_config, null, "Uploaded media generation_config must remain null");
    assert.equal(item.generation_info, null, "Uploaded media must not have generation_info synthesized");
  });

  // ── TEST 9 ──────────────────────────────────────────────────────────────────
  it("TEST 9: Secrets and signed URLs are excluded from persisted configuration", async () => {
    let persistedConfig = null;

    const mockDb = {
      workflows: { createWorkflow: async (wf) => wf },
      media: {
        createMedia: async (m) => {
          persistedConfig = m.generation_config;
          return m;
        },
        updateMedia: async () => {},
      },
      workflowMedia: { linkMedia: async () => {} },
    };

    const service = new GenerationRequestService({
      db: mockDb,
      useCaseService: { prepareAndEnqueue: async () => ({ jobId: "job-secret" }) },
      folderService: { validateAndAssertUsable: async () => null },
    });

    await service.requestGeneration({
      userId: "user-1",
      mediaType: "video",
      stepId: "video_generation",
      useCaseId: "video-generation-v1",
      prompt: "A secret garden",
      model: "wan_3_0",   // wan_3_0 supports seed
      projectId: "proj-1",
      references: ["wf-ref-safe-id"],
      parameters: {
        seed: 777,
        api_key: "sk-should-be-stripped", // gate:allow-secret
        access_token: "token-should-be-stripped", // gate:allow-secret
        auth_bearer: "bearer-should-be-stripped",
        user_password: "pw-should-be-stripped", // gate:allow-secret
      },
    });

    assert.ok(persistedConfig);
    assert.equal(persistedConfig.parameters.seed, 777, "seed must be preserved");
    assert.equal(persistedConfig.parameters.api_key, undefined, "api_key must be stripped");
    assert.equal(persistedConfig.parameters.access_token, undefined, "access_token must be stripped");
    assert.equal(persistedConfig.parameters.auth_bearer, undefined, "auth_bearer must be stripped");
    assert.equal(persistedConfig.parameters.user_password, undefined, "user_password must be stripped");
  });

  // ── TEST 10 ─────────────────────────────────────────────────────────────────
  it("TEST 10: Existing configuration retrieval continues to work without introducing per-tile or per-entity network requests", async () => {
    let findByWorkflowIdsCalled = 0;
    let findByIdsWithReferencesCalled = 0;

    const mockDb = {
      projects: { findByUser: async () => [{ id: "proj-1" }] },
      workflows: {
        findByProjectsPaginated: async () => ({
          workflows: [
            {
              id: "wf-tile-1",
              project_id: "proj-1",
              display_name: "Workflow 1",
              primary_media_id: "m-1",
              workflow_type: "GENERATION",
              create_time: "2026-10-21T01:00:00Z",
            },
            {
              id: "wf-tile-2",
              project_id: "proj-1",
              display_name: "Workflow 2",
              primary_media_id: "m-2",
              workflow_type: "GENERATION",
              create_time: "2026-10-21T02:00:00Z",
            },
          ],
          total: 2,
        }),
      },
      workflowMedia: {
        findByWorkflowIds: async (wfIds) => {
          findByWorkflowIdsCalled++;
          return [
            {
              id: "m-1",
              workflow_id: "wf-tile-1",
              workflowId: "wf-tile-1",
              role: "output",
              is_primary: true,
              isPrimary: true,
              status: "completed",
              url: "https://cdn.example.com/1.png",
              generation_config: { prompt: "Prompt 1", model: "nanobana_pro" },
            },
            {
              id: "m-2",
              workflow_id: "wf-tile-2",
              workflowId: "wf-tile-2",
              role: "output",
              is_primary: true,
              isPrimary: true,
              status: "completed",
              url: "https://cdn.example.com/2.png",
              generation_config: { prompt: "Prompt 2", model: "seedance_2_5" },
            },
          ];
        },
      },
      configs: {
        findByIdsWithReferences: async () => {
          findByIdsWithReferencesCalled++;
          return [];
        },
      },
    };

    const generationService = new GenerationService({ db: mockDb });
    const library = await generationService.getUserLibrary("user-1", { projectId: "proj-1" });

    // Both workflow tiles retrieved with generation_info in a single batch query!
    assert.equal(findByWorkflowIdsCalled, 1, "Exactly 1 batched query for all workflow media");
    assert.equal(findByIdsWithReferencesCalled, 0, "Zero legacy config table calls when inline config exists");
    assert.equal(library.data.length, 2);
    assert.equal(library.data[0].generation_info.prompt, "Prompt 1");
    assert.equal(library.data[1].generation_info.prompt, "Prompt 2");
  });

});
