/**
 * Boundary Tests: F2.2 — RunRepository Target Columns & Entry Point Wiring Invariants
 *
 * Verifies:
 * 1. F2.2-a: RunRepository writes and reads `v1_workflow_id`, `target_media_ids`, and `metadata`
 *    as first-class database columns in Supabase.
 * 2. F2.2-a: Backward compatibility for pre-migration rows: falls back to execution_plan
 *    targetWorkflowId / targetMediaIds if present.
 * 3. F2.2-a: Fail-closed invariant: runs without targets have null/empty targets and fail closed
 *    with normalized errors upon node persistence (never falling back to user input).
 * 4. F2.2-b: CharacterGenerationService.enqueueSheetGeneration creates placeholder media and
 *    propagates its mediaId and server-verified targets into runtime input and serverContext.
 * 5. F2.2-b: imageController.generateImage and videoController.generateVideo pass explicit
 *    server-verified targets (serverWorkflowId, serverMediaIds, serverProjectId).
 * 6. F2.2-b: End-to-end integration: execution of queued character sheet job completes the placeholder.
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { RunRepository } from "../../src/v2/runner/runRepository.js";
import { executeNodePersistence } from "../../src/v2/runner/nodeExecutor.js";
import { CharacterGenerationService } from "../../src/domain/character/CharacterGenerationService.js";
import { generateImage } from "../../controllers/imageController.js";
import { generateVideo } from "../../controllers/videoController.js";
import { useCaseService, db } from "../../src/container.js";
import { registerNodeExecutor, registry } from "../../src/v2/nodes/index.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { bootstrapV2 } from "../../src/v2/bootstrap.js";

bootstrapV2();

after(async () => {
  try {
    await redisConnection.quit().catch(() => redisConnection.disconnect());
    await workerRedisConnection.quit().catch(() => workerRedisConnection.disconnect());
  } catch {}
});

describe("F2.2-a — RunRepository Target Columns & Fallback Invariants (Supabase Mocked)", () => {
  let originalClientOverride;
  let originalUseMemoryFallback;

  beforeEach(() => {
    originalClientOverride = RunRepository.clientOverride;
    originalUseMemoryFallback = RunRepository.useMemoryFallback;
    RunRepository.useMemoryFallback = false;
  });

  afterEach(() => {
    RunRepository.clientOverride = originalClientOverride;
    RunRepository.useMemoryFallback = originalUseMemoryFallback;
  });

  it("TEST 1: createRun writes metadata, v1_workflow_id, and target_media_ids to Supabase columns", async () => {
    let capturedTable = null;
    let capturedInsert = null;

    const mockSupabase = {
      from: (table) => {
        capturedTable = table;
        return {
          insert: (payload) => {
            capturedInsert = payload;
            return {
              select: () => ({
                single: async () => ({
                  data: {
                    ...payload,
                    run_id: payload.run_id || "mock-run-id",
                  },
                  error: null,
                }),
              }),
            };
          },
        };
      },
    };

    RunRepository.clientOverride = mockSupabase;
    const repo = new RunRepository();

    const created = await repo.createRun({
      run_id: "test-run-cols-1",
      workflow_id: "image-generation-v1",
      workflow_version: "1.0.0",
      user_id: "user-123",
      status: "pending",
      input: { prompt: "a cat" },
      execution_plan: { nodes: [] },
      v1_workflow_id: "wf-v1-uuid-111",
      target_media_ids: ["media-uuid-222"],
      metadata: { billingAccumulator: [] },
    });

    assert.strictEqual(capturedTable, "v2_workflow_runs");
    assert.ok(capturedInsert, "Supabase insert payload must be provided");
    assert.strictEqual(capturedInsert.v1_workflow_id, "wf-v1-uuid-111", "v1_workflow_id must be written as column");
    assert.deepStrictEqual(capturedInsert.target_media_ids, ["media-uuid-222"], "target_media_ids must be written as column");
    assert.deepStrictEqual(capturedInsert.metadata, { billingAccumulator: [] }, "metadata must be written as column");

    // Also assert normalized read properties on returned run
    assert.strictEqual(created.v1_workflow_id, "wf-v1-uuid-111");
    assert.deepStrictEqual(created.target_media_ids, ["media-uuid-222"]);
  });

  it("TEST 2: getRun returns normalized row reading new columns directly", async () => {
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                run_id: "test-run-cols-2",
                workflow_id: "video-generation-v1",
                workflow_version: "1.0.0",
                v1_workflow_id: "wf-v1-direct-888",
                target_media_ids: ["media-direct-999"],
                metadata: { key: "val" },
                execution_plan: {},
              },
              error: null,
            }),
          }),
        }),
      }),
    };

    RunRepository.clientOverride = mockSupabase;
    const repo = new RunRepository();

    const run = await repo.getRun("test-run-cols-2");
    assert.ok(run);
    assert.strictEqual(run.v1_workflow_id, "wf-v1-direct-888");
    assert.deepStrictEqual(run.target_media_ids, ["media-direct-999"]);
    assert.strictEqual(run.targetWorkflowId, "wf-v1-direct-888");
    assert.deepStrictEqual(run.targetMediaIds, ["media-direct-999"]);
  });

  it("TEST 3: getRun backward compatibility: row with null columns falls back to execution_plan targets", async () => {
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                run_id: "test-run-legacy-3",
                workflow_id: "image-generation-v1",
                workflow_version: "1.0.0",
                v1_workflow_id: null,
                target_media_ids: [],
                metadata: {},
                execution_plan: {
                  targetWorkflowId: "wf-legacy-fallback-444",
                  targetMediaIds: ["media-legacy-fallback-555"],
                },
              },
              error: null,
            }),
          }),
        }),
      }),
    };

    RunRepository.clientOverride = mockSupabase;
    const repo = new RunRepository();

    const run = await repo.getRun("test-run-legacy-3");
    assert.ok(run);
    assert.strictEqual(run.v1_workflow_id, "wf-legacy-fallback-444", "Must fall back to execution_plan.targetWorkflowId");
    assert.deepStrictEqual(run.target_media_ids, ["media-legacy-fallback-555"], "Must fall back to execution_plan.targetMediaIds");
    assert.strictEqual(run.targetWorkflowId, "wf-legacy-fallback-444");
    assert.deepStrictEqual(run.targetMediaIds, ["media-legacy-fallback-555"]);
  });

  it("TEST 4: getRun fail-closed: run with neither column nor execution_plan targets fails closed in node persistence", async () => {
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                run_id: "test-run-empty-4",
                workflow_id: "image-generation-v1",
                workflow_version: "1.0.0",
                v1_workflow_id: null,
                target_media_ids: [],
                metadata: {},
                execution_plan: {},
                input: {
                  workflow_id: "spoofed-wf-input",
                  media_id: "spoofed-media-input",
                },
              },
              error: null,
            }),
          }),
        }),
      }),
    };

    RunRepository.clientOverride = mockSupabase;
    const repo = new RunRepository();

    const run = await repo.getRun("test-run-empty-4");
    assert.ok(run);
    assert.strictEqual(run.v1_workflow_id, null, "Must NOT fall back to run.input.workflow_id");
    assert.deepStrictEqual(run.target_media_ids, [], "Must NOT fall back to run.input.media_id");

    // Assert executeNodePersistence rejects immediately and fails closed
    await assert.rejects(
      async () => {
        await executeNodePersistence({
          nodeConfig: {
            persist: {
              target: "media",
              field: "url",
              value: "https://example.com/asset.png",
            },
          },
          output: { url: "https://example.com/asset.png" },
          run,
          resolvedInputs: {},
        });
      },
      (err) => {
        assert.ok(err.message.includes("requires server-verified targetWorkflowId"), `Unexpected error: ${err.message}`);
        return true;
      }
    );
  });
});

describe("F2.2-b — Entry Point Wiring & Target Media Propagation Tests", () => {
  let origPrepareAndEnqueue;
  let origCreateWorkflow;
  let origCreateMedia;
  let origUpdateMedia;
  let origUpdateFields;
  let origFindWorkflow;
  let origProjectsFindById;
  let origWalletService;
  let origImageGenExecutor;
  let origVideoGenExecutor;
  let origLLMExecutor;

  beforeEach(() => {
    origPrepareAndEnqueue = useCaseService.prepareAndEnqueue;
    origCreateWorkflow = db.workflows?.createWorkflow;
    origCreateMedia = db.media?.createMedia;
    origUpdateMedia = db.media?.updateMedia;
    origUpdateFields = db.media?.updateFields;
    origFindWorkflow = db.workflows?.findById;
    origProjectsFindById = db.projects?.findById;
    origWalletService = useCaseService.walletService;

    origImageGenExecutor = registry["image-generation"];
    origVideoGenExecutor = registry["video-generation"];
    origLLMExecutor = registry["llm"];

    // Zero real provider calls
    registerNodeExecutor("llm", async () => ({
      text: "Processed character prompt",
      json: { title: "Cyber Warrior", description: "Cybernetic samurai warrior." },
    }));

    registerNodeExecutor("image-generation", async () => ({
      assets: [{ url: "https://storage.openart.ai/character-sheets/turnaround-char-999.png", width: 1344, height: 768 }],
    }));

    registerNodeExecutor("video-generation", async () => ({
      assets: [{ url: "https://storage.openart.ai/videos/turnaround-char-999.mp4", width: 1280, height: 720 }],
    }));
  });

  afterEach(() => {
    useCaseService.prepareAndEnqueue = origPrepareAndEnqueue;
    useCaseService.walletService = origWalletService;
    if (useCaseService.billingRuntime) {
      useCaseService.billingRuntime.walletService = origWalletService;
    }
    if (origImageGenExecutor) registerNodeExecutor("image-generation", origImageGenExecutor);
    if (origVideoGenExecutor) registerNodeExecutor("video-generation", origVideoGenExecutor);
    if (origLLMExecutor) registerNodeExecutor("llm", origLLMExecutor);

    if (db.workflows) {
      db.workflows.createWorkflow = origCreateWorkflow;
      db.workflows.findById = origFindWorkflow;
    }
    if (db.media) {
      db.media.createMedia = origCreateMedia;
      db.media.updateMedia = origUpdateMedia;
      db.media.updateFields = origUpdateFields;
    }
    if (db.projects) {
      db.projects.findById = origProjectsFindById;
    }
  });

  it("TEST 5: CharacterGenerationService.enqueueSheetGeneration creates placeholder and propagates its mediaId", async () => {
    let capturedMediaCreate = null;
    let capturedWorkflowMediaLink = null;
    let capturedPrepare = null;

    const fakeMedia = {
      id: "media-char-placeholder-777",
      project_id: "proj-111",
      step_id: "character_sheet",
      status: "processing",
    };

    const mockDb = {
      media: {
        createMedia: async (payload) => {
          capturedMediaCreate = payload;
          return fakeMedia;
        },
      },
      workflowMedia: {
        linkMedia: async (payload) => {
          capturedWorkflowMediaLink = payload;
          return payload;
        },
      },
    };

    const mockUseCaseService = {
      prepareAndEnqueue: async (params) => {
        capturedPrepare = params;
        return {
          executionId: "char-wf-888",
          workflowRunId: "char-wf-888",
        };
      },
    };

    const service = new CharacterGenerationService({
      db: mockDb,
      useCaseService: mockUseCaseService,
    });

    const res = await service.enqueueSheetGeneration({
      characterId: "char-wf-888",
      prompt: "cyberpunk warrior",
      references: [],
      projectId: "proj-111",
      userId: "user-123",
      name: "Cyber Warrior",
    });

    assert.ok(res);
    assert.ok(capturedMediaCreate, "Placeholder media must be created in DB");
    assert.strictEqual(capturedMediaCreate.workflow_id, undefined, "workflow_id must NOT be written to media");
    assert.strictEqual(capturedWorkflowMediaLink?.workflowId, "char-wf-888", "workflow_media relation must be created");

    assert.ok(capturedPrepare, "prepareAndEnqueue must be called");
    assert.strictEqual(capturedPrepare.input.media_id, "media-char-placeholder-777", "media_id must match placeholder media ID");
    assert.deepStrictEqual(capturedPrepare.input.serverMediaIds, ["media-char-placeholder-777"], "serverMediaIds must include placeholder media ID");
    assert.strictEqual(capturedPrepare.input.serverWorkflowId, "char-wf-888", "serverWorkflowId must be set");
    assert.strictEqual(capturedPrepare.input.serverProjectId, "proj-111", "serverProjectId must be set");
    assert.strictEqual(capturedPrepare.serverContext?.workflowId, "char-wf-888", "serverContext.workflowId must be set");
    assert.deepStrictEqual(capturedPrepare.serverContext?.mediaIds, ["media-char-placeholder-777"], "serverContext.mediaIds must include placeholder media");
  });

  it("TEST 6: imageController.generateImage creates workflow and placeholder and propagates server targets", async () => {
    let capturedPrepare = null;

    useCaseService.prepareAndEnqueue = async (params) => {
      capturedPrepare = params;
      return {
        jobId: "job-img-123",
        executionId: params.executionId,
        cost: { totalCredits: 2 },
      };
    };

    db.projects = {
      findById: async () => ({ id: "proj-123", user_id: "user-test" }),
    };

    const fakeWorkflow = { id: "wf-img-456", project_id: "proj-123" };
    db.workflows = {
      createWorkflow: async () => fakeWorkflow,
      updateFields: async () => {},
    };

    const fakeMedia = { id: "media-img-789", workflow_id: "wf-img-456" };
    db.media = {
      createMedia: async () => fakeMedia,
      updateMedia: async () => fakeMedia,
    };

    const req = {
      user: { id: "user-test" },
      body: {
        prompt: "A beautiful mountain landscape",
        projectId: "proj-123",
        model: "nanobana_2",
      },
    };

    let statusCode = null;
    let jsonResponse = null;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };

    await generateImage(req, res);

    assert.ok(jsonResponse);
    assert.strictEqual(jsonResponse.ok, true);
    assert.ok(jsonResponse.workflowId);
    assert.ok(jsonResponse.mediaId);

    assert.ok(capturedPrepare, "useCaseService.prepareAndEnqueue must be called");
    assert.strictEqual(capturedPrepare.input.workflow_id, jsonResponse.workflowId);
    assert.strictEqual(capturedPrepare.input.media_id, jsonResponse.mediaId);
    assert.strictEqual(capturedPrepare.input.serverWorkflowId, jsonResponse.workflowId, "serverWorkflowId must be set");
    assert.deepStrictEqual(capturedPrepare.input.serverMediaIds, [jsonResponse.mediaId], "serverMediaIds must contain mediaId");
    assert.strictEqual(capturedPrepare.input.serverProjectId, "proj-123", "serverProjectId must be set");
  });

  it("TEST 7: videoController.generateVideo creates workflow and placeholder and propagates server targets", async () => {
    let capturedPrepare = null;

    useCaseService.prepareAndEnqueue = async (params) => {
      capturedPrepare = params;
      return {
        jobId: "job-vid-123",
        executionId: params.executionId,
        cost: { totalCredits: 10 },
      };
    };

    db.projects = {
      findById: async () => ({ id: "proj-vid-1", user_id: "user-vid-test" }),
    };

    const fakeWorkflow = { id: "wf-vid-555", project_id: "proj-vid-1" };
    db.workflows = {
      createWorkflow: async () => fakeWorkflow,
      updateFields: async () => {},
    };

    const fakeMedia = { id: "media-vid-666", workflow_id: "wf-vid-555" };
    db.media = {
      createMedia: async () => fakeMedia,
      updateMedia: async () => fakeMedia,
    };

    const req = {
      user: { id: "user-vid-test" },
      body: {
        prompt: "A drone flying over the ocean at sunset",
        projectId: "proj-vid-1",
        model: "wan_3_0",
      },
    };

    let statusCode = null;
    let jsonResponse = null;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };

    await generateVideo(req, res);

    assert.ok(jsonResponse);
    assert.strictEqual(jsonResponse.ok, true);
    assert.ok(jsonResponse.workflowId);
    assert.ok(jsonResponse.mediaId);

    assert.ok(capturedPrepare, "useCaseService.prepareAndEnqueue must be called");
    assert.strictEqual(capturedPrepare.input.workflow_id, jsonResponse.workflowId);
    assert.strictEqual(capturedPrepare.input.media_id, jsonResponse.mediaId);
    assert.strictEqual(capturedPrepare.input.serverWorkflowId, jsonResponse.workflowId, "serverWorkflowId must be set");
    assert.deepStrictEqual(capturedPrepare.input.serverMediaIds, [jsonResponse.mediaId], "serverMediaIds must contain mediaId");
    assert.strictEqual(capturedPrepare.input.serverProjectId, "proj-vid-1", "serverProjectId must be set");
  });

  it("TEST 8: End-to-end integration: Character generation sheet completes target placeholder media", async () => {
    // Register mock AI generation node executor for character sheet workflow
    registerNodeExecutor("ai/character-sheet", async ({ inputs }) => {
      return {
        url: "https://storage.openart.ai/character-sheets/turnaround-char-999.png",
        width: 1344,
        height: 768,
      };
    });

    let mediaRecord = {
      id: "media-e2e-char-1",
      workflow_id: "char-wf-e2e-999",
      project_id: "proj-e2e",
      step_id: "character_sheet",
      status: "processing",
      url: null,
    };

    db.media = {
      createMedia: async (payload) => {
        mediaRecord = { ...mediaRecord, ...payload, id: "media-e2e-char-1" };
        return mediaRecord;
      },
      findByWorkflow: async (wfId) => {
        return wfId === "char-wf-e2e-999" ? [mediaRecord] : [];
      },
      updateMedia: async (mediaId, patch) => {
        if (mediaId === "media-e2e-char-1") {
          mediaRecord = { ...mediaRecord, ...patch };
        }
        return mediaRecord;
      },
      updateFields: async (mediaId, patch) => {
        if (mediaId === "media-e2e-char-1") {
          mediaRecord = { ...mediaRecord, ...patch };
        }
        return mediaRecord;
      },
    };

    db.characters = {
      upsert: async () => ({ id: "char-wf-e2e-999" }),
      updateCharacter: async () => {},
    };

    let enqueuedJobData = null;
    const mockQueue = {
      addUseCaseJob: async (jobData) => {
        enqueuedJobData = jobData;
        return { id: "job-char-e2e" };
      },
    };

    const mockWallet = {
      reserve: async ({ referenceId }) => ({
        reservationId: referenceId || "hold-test-e2e",
        referenceId: referenceId || "hold-test-e2e",
        status: "held",
      }),
      commitHoldIdempotent: async () => ({ status: "COMPLETED" }),
      rollback: async () => ({ status: "FAILED" }),
      extendHold: async () => ({ status: "extended" }),
    };

    useCaseService.jobQueueService = mockQueue;
    useCaseService.walletService = mockWallet;
    if (useCaseService.billingRuntime) {
      useCaseService.billingRuntime.walletService = mockWallet;
    }

    // Use in-memory fallback for runRepository in this test
    RunRepository.useMemoryFallback = true;

    // 1. CharacterGenerationService creates placeholder & enqueues
    const charGenService = new CharacterGenerationService({
      db,
      useCaseService,
    });

    await charGenService.enqueueSheetGeneration({
      characterId: "char-wf-e2e-999",
      prompt: "A cybernetic samurai warrior",
      references: [],
      projectId: "proj-e2e",
      userId: "11111111-1111-4111-8111-111111111111",
      name: "Cyber Samurai",
    });

    assert.ok(enqueuedJobData, "Job must have been enqueued");
    assert.strictEqual(enqueuedJobData.input.media_id, "media-e2e-char-1");
    assert.deepStrictEqual(enqueuedJobData.input.serverMediaIds, ["media-e2e-char-1"]);

    // 2. Worker executes queued job end-to-end
    const result = await useCaseService.executeQueuedUseCase({
      useCaseId: enqueuedJobData.useCaseId,
      input: enqueuedJobData.input,
      userId: enqueuedJobData.userId,
      billingHoldId: enqueuedJobData.billingHoldId,
    });

    assert.strictEqual(result.status, "completed");
    // Assert target placeholder media is now completed with the generated URL!
    assert.strictEqual(mediaRecord.status, "completed");
    assert.strictEqual(mediaRecord.url, "https://storage.openart.ai/character-sheets/turnaround-char-999.png");
  });
});
