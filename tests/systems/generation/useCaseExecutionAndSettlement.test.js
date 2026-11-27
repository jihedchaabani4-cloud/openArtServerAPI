import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  ExecutionEngine,
  WorkflowExecutor,
  GraphCompiler,
  SaveMediaNode,
  ImageGenerateNode,
  createDefaultV3NodeRegistry,
  imageGenerationV3,
  videoGenerationV3,
  characterSheetV3,
} from "../../../src/systems/generation/internal/v3/index.js";
import { ERROR_CODES } from "../../../src/systems/generation/internal/errors.js";
import { executionEngine, db, assertWalletConfiguredForEnvironment } from "../../../src/container.js";
import { reserveCredits, BillingValidationError } from "#billing/tools";
import { redisConnection, workerRedisConnection } from "#shared";
import { randomUUID } from "node:crypto";
import { InMemoryWalletService } from "../../helpers/inMemoryWalletService.js";
import { generateImage, generateVideo } from "#generation/api";
import { generateCharacterSheet, createCharacter } from "#characters/api";

after(async () => {
  try {
    await redisConnection?.quit().catch(() => redisConnection?.disconnect());
    await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
  } catch {}
});

function createDefaultMockNodeContext(overrides = {}) {
  return {
    executeLLM: async ({ prompt }) => ({
      raw: JSON.stringify({
        is_safe: true,
        safety_reason: null,
        sanitized_prompt: prompt,
        description: "Cyberpunk character with cybernetic arm.",
        character_description: "Cyberpunk character with cybernetic arm.",
      }),
      content: prompt || "Processed prompt text",
      json: {
        is_safe: true,
        safety_reason: null,
        sanitized_prompt: prompt,
        description: "Cyberpunk character with cybernetic arm.",
        character_description: "Cyberpunk character with cybernetic arm.",
      },
      model: "gemini-3.1-flash-lite",
      durationMs: 5,
    }),
    executeProvider: async (modelId) => {
      if (String(modelId).includes("wan") || String(modelId).includes("seedance") || String(modelId).includes("ltx")) {
        return {
          url: "https://mock-storage.example.com/e2e-video.mp4",
          videos: ["https://mock-storage.example.com/e2e-video.mp4"],
          metadata: { model: modelId, provider: "wavespeed" },
        };
      }
      return {
        assets: [{ url: "https://mock-storage.example.com/e2e-image.png", width: 1024, height: 1024 }],
        metadata: { model: modelId, provider: "wavespeed", width: 1024, height: 1024 },
      };
    },
    ...overrides,
  };
}

// ─── Source: useCaseWorkflowAndSettlementBoundary.test.js ───
{
describe("F2.1 — Fail-Closed Targets, Exploit Regression & Settlement Invariants (V3)", () => {
  let originalMediaFindByWorkflow;
  let originalMediaUpdateMedia;
  let originalMediaCreateMedia;
  let originalCharacterUpdateCharacter;
  let mediaUpdateCalls = [];
  let mediaCreateCalls = [];
  let characterUpdateCalls = [];
  let mediaFindByWorkflowCalls = [];

  beforeEach(() => {
    mediaUpdateCalls = [];
    mediaCreateCalls = [];
    characterUpdateCalls = [];
    mediaFindByWorkflowCalls = [];

    originalMediaFindByWorkflow = db.media?.findByWorkflow;
    originalMediaUpdateMedia = db.media?.updateMedia;
    originalMediaCreateMedia = db.media?.createMedia;
    originalCharacterUpdateCharacter = db.characters?.updateCharacter;

    if (db.media) {
      db.media.findByWorkflow = async (workflowId) => {
        mediaFindByWorkflowCalls.push(workflowId);
        return [
          {
            id: "placeholder-media-authorized",
            workflow_id: workflowId,
            step_id: "image_generation",
            status: "processing",
          },
        ];
      };
      db.media.updateMedia = async (id, patch) => {
        mediaUpdateCalls.push({ id, patch });
        return { id, ...patch };
      };
      db.media.createMedia = async (data) => {
        mediaCreateCalls.push(data);
        return { id: "new-fallback-media", ...data };
      };
    }

    if (db.characters) {
      db.characters.updateCharacter = async (id, patch) => {
        characterUpdateCalls.push({ id, patch });
        return { id, ...patch };
      };
    }
  });

  afterEach(() => {
    if (db.media) {
      db.media.findByWorkflow = originalMediaFindByWorkflow;
      db.media.updateMedia = originalMediaUpdateMedia;
      db.media.createMedia = originalMediaCreateMedia;
    }
    if (db.characters) {
      db.characters.updateCharacter = originalCharacterUpdateCharacter;
    }
  });

  it("F2.1-b TEST 1: SaveMediaNode fails when media_id is missing (no DB write, no createMedia fallback)", async () => {
    await assert.rejects(
      async () => {
        await SaveMediaNode.execute(
          {
            asset_url: "https://example.com/generated.png",
          },
          { db }
        );
      },
      (err) => {
        assert.match(err.message, /media_id is required/i);
        return true;
      }
    );

    assert.equal(mediaUpdateCalls.length, 0, "No media update must be executed");
    assert.equal(mediaCreateCalls.length, 0, "No media create fallback must be executed");
  });

  it("F2.1-c TEST 2: WorkflowExecutor updates explicit media_id and fails closed when media_id binding is missing", async () => {
    const executor = new WorkflowExecutor(createDefaultV3NodeRegistry());

    await assert.rejects(
      async () => {
        await executor.execute({
          workflow: imageGenerationV3,
          input: {
            prompt: "A futuristic city",
            model: "nanobana_2",
            serverMediaIds: ["unmapped-media-id"],
          },
          context: {
            db,
            useExternalPersistence: false,
            ...createDefaultMockNodeContext(),
          },
        });
      },
      /missing required input "media_id"/i
    );

    await executor.execute({
      workflow: imageGenerationV3,
      input: {
        prompt: "A futuristic city",
        model: "nanobana_2",
        media_id: "explicit-media-id",
      },
      context: {
        db,
        useExternalPersistence: false,
        ...createDefaultMockNodeContext(),
      },
    });

    assert.equal(mediaCreateCalls.length, 0, "createMedia fallback must NOT be called");
    assert.equal(mediaUpdateCalls.length, 1, "Exactly one media update");
    assert.equal(mediaUpdateCalls[0].id, "explicit-media-id");
    assert.equal(mediaUpdateCalls[0].patch.status, "success");
  });

  it("F2.1-d TEST 3: onSuccess hook fires on success; onFailure hook fires on failure (Black-Box)", async () => {
    let successCount = 0;
    let failureCount = 0;

    const engine = new ExecutionEngine({
      onSuccess: async () => { successCount++; },
      onFailure: async () => { failureCount++; },
    });

    // Case 1: Successful run
    engine.executor = {
      execute: async () => ({
        executionId: "exec-success",
        status: "completed",
        outputs: { test: true },
      }),
    };

    await engine.execute({
      useCaseId: "image-generation-v3",
      input: { workflow_id: "wf-1", media_id: "m-1" },
      userId: "00000000-0000-0000-0000-000000000001",
    });

    assert.equal(successCount, 1, "onSuccess must fire exactly 1 time on success");
    assert.equal(failureCount, 0, "onFailure must NOT fire on success");

    // Case 2: Failed run
    engine.executor = {
      execute: async () => {
        const failErr = new Error("Provider timeout");
        failErr.code = "UPSTREAM_TIMEOUT";
        throw failErr;
      },
    };

    await assert.rejects(
      async () => {
        await engine.execute({
          useCaseId: "image-generation-v3",
          input: { workflow_id: "wf-2", media_id: "m-2" },
          userId: "00000000-0000-0000-0000-000000000001",
        });
      },
      /Provider timeout/
    );

    assert.equal(successCount, 1, "onSuccess must still be 1 (0 calls on failed run)");
    assert.equal(failureCount, 1, "onFailure must fire exactly 1 time on failed run");
  });

  it("F2.1-f TEST 4: End-to-end happy path for imageGeneration (image-generation-v3)", async () => {
    let successPayload = null;

    const engine = new ExecutionEngine({
      onSuccess: async (payload) => { successPayload = payload; },
    });

    const result = await engine.execute({
      useCaseId: "image-generation-v3",
      input: {
        prompt: "A beautiful mountain landscape at sunset",
        model: "gpt-image-2",
        parameters: { aspect_ratio: "16:9" },
        workflow_id: "wf-img-e2e",
        media_id: "media-img-e2e",
        serverWorkflowId: "wf-img-e2e",
        serverMediaIds: ["media-img-e2e"],
      },
      userId: "00000000-0000-0000-0000-000000000001",
      nodeContext: { ...createDefaultMockNodeContext({ db }), useExternalPersistence: false },
    });

    assert.equal(result.status, "completed");
    assert.ok(successPayload, "onSuccess hook must fire on completed run");
    assert.equal(mediaUpdateCalls.length, 1, "Placeholder media must be updated to success");
    assert.equal(mediaUpdateCalls[0].id, "media-img-e2e");
    assert.equal(mediaUpdateCalls[0].patch.status, "success");
  });

  it("F2.1-f TEST 5: End-to-end happy path for videoGeneration (video-generation-v3)", async () => {
    let successPayload = null;

    const engine = new ExecutionEngine({
      onSuccess: async (payload) => { successPayload = payload; },
    });

    const result = await engine.execute({
      useCaseId: "video-generation-v3",
      input: {
        prompt: "A drone shot flying over waves crashing on rocks",
        model: "wan_3_0",
        parameters: { duration: 5 },
        workflow_id: "wf-vid-e2e",
        media_id: "media-vid-e2e",
        serverWorkflowId: "wf-vid-e2e",
        serverMediaIds: ["media-vid-e2e"],
      },
      userId: "00000000-0000-0000-0000-000000000001",
      nodeContext: { ...createDefaultMockNodeContext({ db }), useExternalPersistence: false },
    });

    assert.equal(result.status, "completed");
    assert.ok(successPayload, "onSuccess hook must fire on completed run");
    assert.equal(mediaUpdateCalls.length, 1, "Placeholder media must be updated to success");
    assert.equal(mediaUpdateCalls[0].id, "media-vid-e2e");
    assert.equal(mediaUpdateCalls[0].patch.status, "success");
  });

  it("F2.1-f TEST 6: End-to-end happy path for characterSheet (character-sheet-v3)", async () => {
    let successPayload = null;

    const engine = new ExecutionEngine({
      onSuccess: async (payload) => { successPayload = payload; },
    });

    const result = await engine.execute({
      useCaseId: "character-sheet-v3",
      input: {
        prompt: "Futuristic cyberpunk warrior with cybernetic arm",
        name: "CyberHero",
        character_id: "char-e2e-123",
        characterId: "char-e2e-123",
        workflow_id: "wf-char-e2e",
        media_id: "media-char-e2e",
        serverWorkflowId: "wf-char-e2e",
        serverMediaIds: ["media-char-e2e"],
      },
      userId: "00000000-0000-0000-0000-000000000001",
      nodeContext: { ...createDefaultMockNodeContext({ db }), useExternalPersistence: false },
    });

    assert.equal(result.status, "completed");
    assert.ok(successPayload, "onSuccess hook must fire on completed run");
    assert.equal(characterUpdateCalls.length, 0, "V3 save_media node must not touch characters table directly");
    assert.equal(mediaUpdateCalls.length, 1, "Placeholder media must be updated to success");
    assert.equal(mediaUpdateCalls[0].id, "media-char-e2e");
    assert.equal(mediaUpdateCalls[0].patch.status, "success");
    assert.equal(
      mediaUpdateCalls[0].patch.generation_config?.character_description,
      "Cyberpunk character with cybernetic arm."
    );
  });
});
}

// ─── Source: serverContextFailClosedAndBillingReleaseBoundary.test.js ───
{
describe("F2.3 — ServerContext Fail-Closed, Hold Release, and Multi-Asset Output Boundary Tests (V3)", () => {
  let origDbMedia;
  let origDbWorkflowMedia;
  let origDbWorkflows;
  let origDbProjects;
  let origDbCharacters;

  beforeEach(() => {
    origDbMedia = db.media;
    origDbWorkflowMedia = db.workflowMedia;
    origDbWorkflows = db.workflows;
    origDbProjects = db.projects;
    origDbCharacters = db.characters;
  });

  afterEach(() => {
    db.media = origDbMedia;
    db.workflowMedia = origDbWorkflowMedia;
    db.workflows = origDbWorkflows;
    db.projects = origDbProjects;
    db.characters = origDbCharacters;
  });

  it("TEST 1 (F2.3-a): job payload with workflow_id/media_id/characterId in input but no server* fields — onFailure hook receives input targets", async () => {
    const failedPayloads = [];

    const mockMediaRepo = {
      findById: async (id) => ({ id, workflow_id: "wf-legacy-target", status: "processing" }),
      findByWorkflow: async (wfId) => [
        { id: "media-legacy-target", workflow_id: wfId, step_id: "image_generation", status: "processing" },
      ],
      updateMedia: async (id, fields) => ({ id, ...fields }),
    };

    db.media = mockMediaRepo;

    const engine = new ExecutionEngine({
      onFailure: async (payload) => { failedPayloads.push(payload); },
    });

    const legacyPayload = {
      useCaseId: "image-generation-v3",
      input: {
        prompt: "test unverified input targets",
        model: "nanobana_2",
        workflow_id: "wf-legacy-target",
        media_id: "media-legacy-target",
        characterId: "char-legacy-target",
      },
      userId: "user-attacker",
    };

    let caughtError = null;
    try {
      await engine.execute(legacyPayload);
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, "Job must fail when no server-verified targets exist");
    assert.equal(failedPayloads.length, 1, "onFailure hook must fire on fail-closed rejection");
    assert.equal(failedPayloads[0].input.media_id, "media-legacy-target", "onFailure must receive original input targets");
  });

  it("TEST 2 (F2.4-b1): ImageGenerateNode with 4 surplus assets and 1 target placeholder — maps FIRST asset, run SUCCEEDS", async () => {
    const multiAssets = [
      { url: "https://mock-storage.example.com/asset-1.png", width: 1024, height: 1024 },
      { url: "https://mock-storage.example.com/asset-2.png", width: 1024, height: 1024 },
      { url: "https://mock-storage.example.com/asset-3.png", width: 1024, height: 1024 },
      { url: "https://mock-storage.example.com/asset-4.png", width: 1024, height: 1024 },
    ];

    const updatedMediaRows = [];
    const createdMediaRows = [];

    const mockMediaRepo = {
      findById: async (id) => ({ id, workflow_id: "wf-multi", status: "processing" }),
      findByWorkflow: async (wfId) => [
        { id: "media-placeholder-1", workflow_id: wfId, step_id: "image_generation", status: "processing" },
      ],
      updateMedia: async (id, fields) => {
        updatedMediaRows.push({ id, ...fields });
        return { id, ...fields };
      },
      createMedia: async (payload) => {
        createdMediaRows.push(payload);
        return { id: `media-created-${randomUUID()}`, ...payload };
      },
    };

    db.media = mockMediaRepo;

    const engine = new ExecutionEngine();

    const result = await engine.execute({
      useCaseId: "image-generation-v3",
      input: {
        prompt: "four variations of cat",
        model: "nanobana_2",
        parameters: {},
        media_id: "media-placeholder-1",
        serverWorkflowId: "wf-multi",
        serverMediaIds: ["media-placeholder-1"],
      },
      userId: "user-multi",
      nodeContext: {
        ...createDefaultMockNodeContext({
          db,
          executeProvider: async () => ({
            assets: multiAssets,
          }),
        }),
        useExternalPersistence: false,
      },
    });

    assert.equal(result.status, "completed");

    const completedUpdate = updatedMediaRows.find((m) => m.status === "success");
    assert.ok(completedUpdate, "Placeholder must be completed with first asset");
    assert.strictEqual(
      completedUpdate.url,
      "https://mock-storage.example.com/asset-1.png",
      "First asset URL must be used (surplus assets 2-4 are dropped)"
    );
    assert.strictEqual(createdMediaRows.length, 0, "No extra media rows created");
  });

  describe("TEST 3 (F2.3-e): Table-driven onFailure hook fires across ALL error codes", () => {
    const allCodes = Array.from(
      new Set([
        ...Object.values(ERROR_CODES),
        "SOME_UNKNOWN_ERROR_CODE",
        "ANOTHER_UNREGISTERED_ERROR",
        undefined,
      ])
    );

    for (const testCode of allCodes) {
      it(`error code "${testCode}" fires onFailure with correct input targets`, async () => {
        const failurePayloads = [];

        const engine = new ExecutionEngine({
          onFailure: async (payload) => { failurePayloads.push(payload); },
        });

        engine.executor = {
          execute: async () => {
            const simulatedErr = new Error(`Simulated failure for code: ${testCode}`);
            if (testCode) simulatedErr.code = testCode;
            throw simulatedErr;
          },
        };

        const payload = {
          useCaseId: "image-generation-v3",
          input: {
            prompt: "error test prompt",
            model: "nanobana_2",
            serverWorkflowId: "wf-err-target",
            serverMediaIds: ["m-err-1"],
          },
          userId: "user-err-test",
        };

        let threw = false;
        try {
          await engine.execute(payload);
        } catch {
          threw = true;
        }

        assert.ok(threw, "Execution must throw on error");
        assert.equal(failurePayloads.length, 1, `onFailure must fire for error code "${testCode}"`);
        assert.deepStrictEqual(
          failurePayloads[0].input.serverMediaIds,
          ["m-err-1"],
          `onFailure must receive input targets for error code "${testCode}"`
        );
      });
    }
  });

  describe("F2.3-c: Integration tests per entry point WITHOUT hand-injected targets", () => {
    it("ENTRY POINT 1: imageController.generateImage produces server targets and completes media", async () => {
      let capturedJobPayload = null;
      const mockQueue = {
        addUseCaseJob: async (jobData) => {
          capturedJobPayload = jobData;
          return { id: "job-img-ep-1", ...jobData };
        },
      };

      const testEngine = new ExecutionEngine({
        jobQueueService: mockQueue,
      });

      const origLaunch = executionEngine.launch;
      const origExecute = executionEngine.execute;
      executionEngine.launch = testEngine.launch.bind(testEngine);
      executionEngine.execute = testEngine.execute.bind(testEngine);

      try {
        const dbWorkflowsStore = new Map();
        const dbMediaStore = new Map();
        const dbRelationRows = [];

        db.projects = {
          findById: async () => ({ id: "proj-ep-img", user_id: "user-ep-img" }),
        };

        db.workflows = {
          createWorkflow: async (wf) => {
            dbWorkflowsStore.set(wf.id, { ...wf, status: "pending" });
            return wf;
          },
        };

        db.workflowMedia = {
          linkMedia: async ({ workflowId, mediaId, role }) => {
            dbRelationRows.push({ workflow_id: workflowId, media_id: mediaId, role });
          },
        };

        db.media = {
          createMedia: async (m) => {
            dbMediaStore.set(m.id, { ...m });
            return m;
          },
          findById: async (id) => dbMediaStore.get(id),
          findByWorkflow: async (wfId) => {
            const linkedIds = new Set(dbRelationRows.filter((r) => r.workflow_id === wfId).map((r) => r.media_id));
            return Array.from(dbMediaStore.values()).filter((m) => linkedIds.has(m.id));
          },
          updateMedia: async (id, patch) => {
            const existing = dbMediaStore.get(id) || {};
            const updated = { ...existing, ...patch };
            dbMediaStore.set(id, updated);
            return updated;
          },
        };

        const req = {
          user: { id: "user-ep-img" },
          body: {
            prompt: "A neon futuristic metropolis",
            model: "nanobana_2",
            projectId: "proj-ep-img",
          },
        };

        let responseData = null;
        const res = {
          status() {
            return this;
          },
          json(data) {
            responseData = data;
            return this;
          },
        };

        await generateImage(req, res);

        assert.ok(responseData?.ok, "Controller response must be ok");
        const { workflowId, mediaId } = responseData;
        assert.ok(workflowId, "Workflow ID created by controller");
        assert.ok(mediaId, "Media ID created by controller");

        assert.ok(capturedJobPayload, "Job was enqueued via launch");
        assert.strictEqual(capturedJobPayload.serverContext.workflowId, workflowId);
        assert.deepStrictEqual(capturedJobPayload.serverContext.mediaIds, [mediaId]);
        assert.strictEqual(capturedJobPayload.input.serverWorkflowId, workflowId);
        assert.deepStrictEqual(capturedJobPayload.input.serverMediaIds, [mediaId]);

        const runResult = await testEngine.execute({
          useCaseId: capturedJobPayload.useCaseId,
          input: capturedJobPayload.input,
          userId: capturedJobPayload.userId,
          executionId: capturedJobPayload.executionId,
          runId: capturedJobPayload.workflowRunId,
          nodeContext: { ...createDefaultMockNodeContext({ db }), useExternalPersistence: false },
        });

        assert.strictEqual(runResult.status, "completed");

        const completedMedia = dbMediaStore.get(mediaId);
        assert.strictEqual(completedMedia.status, "success", "Placeholder media must be completed by node");
        assert.ok(completedMedia.url.startsWith("https://"), "Media URL must be populated");
      } finally {
        executionEngine.launch = origLaunch;
        executionEngine.execute = origExecute;
      }
    });

    it("ENTRY POINT 2: videoController.generateVideo produces server targets and completes media", async () => {
      let capturedJobPayload = null;
      const mockQueue = {
        addUseCaseJob: async (jobData) => {
          capturedJobPayload = jobData;
          return { id: "job-vid-ep-1", ...jobData };
        },
      };

      const testEngine = new ExecutionEngine({
        jobQueueService: mockQueue,
      });

      const origLaunch = executionEngine.launch;
      const origExecute = executionEngine.execute;
      executionEngine.launch = testEngine.launch.bind(testEngine);
      executionEngine.execute = testEngine.execute.bind(testEngine);

      try {
        const dbMediaStore = new Map();
        const dbRelationRows = [];

        db.projects = {
          findById: async () => ({ id: "proj-ep-vid", user_id: "user-ep-vid" }),
        };

        db.workflows = {
          createWorkflow: async (wf) => wf,
        };

        db.workflowMedia = {
          linkMedia: async ({ workflowId, mediaId, role }) => {
            dbRelationRows.push({ workflow_id: workflowId, media_id: mediaId, role });
          },
        };

        db.media = {
          createMedia: async (m) => {
            dbMediaStore.set(m.id, { ...m });
            return m;
          },
          findById: async (id) => dbMediaStore.get(id),
          findByWorkflow: async (wfId) => {
            const linkedIds = new Set(dbRelationRows.filter((r) => r.workflow_id === wfId).map((r) => r.media_id));
            return Array.from(dbMediaStore.values()).filter((m) => linkedIds.has(m.id));
          },
          updateMedia: async (id, patch) => {
            const existing = dbMediaStore.get(id) || {};
            const updated = { ...existing, ...patch };
            dbMediaStore.set(id, updated);
            return updated;
          },
        };

        const req = {
          user: { id: "user-ep-vid" },
          body: {
            prompt: "A river flowing through autumnal forest",
            model: "wan_3_0",
            projectId: "proj-ep-vid",
          },
        };

        let responseData = null;
        const res = {
          status() {
            return this;
          },
          json(data) {
            responseData = data;
            return this;
          },
        };

        await generateVideo(req, res);

        assert.ok(responseData?.ok, "Video controller response must be ok");
        const { workflowId, mediaId } = responseData;
        assert.ok(workflowId && mediaId);

        assert.ok(capturedJobPayload);
        assert.strictEqual(capturedJobPayload.serverContext.workflowId, workflowId);
        assert.deepStrictEqual(capturedJobPayload.serverContext.mediaIds, [mediaId]);

        const runResult = await testEngine.execute({
          useCaseId: capturedJobPayload.useCaseId,
          input: capturedJobPayload.input,
          userId: capturedJobPayload.userId,
          executionId: capturedJobPayload.executionId,
          runId: capturedJobPayload.workflowRunId,
          nodeContext: { ...createDefaultMockNodeContext({ db }), useExternalPersistence: false },
        });

        assert.strictEqual(runResult.status, "completed");

        const completedMedia = dbMediaStore.get(mediaId);
        assert.strictEqual(completedMedia.status, "success");
        assert.ok(completedMedia.url);
      } finally {
        executionEngine.launch = origLaunch;
        executionEngine.execute = origExecute;
      }
    });

    it("ENTRY POINT 3: characterController.generateCharacterSheet produces server targets and completes media", async () => {
      let capturedJobPayload = null;
      const mockQueue = {
        addUseCaseJob: async (jobData) => {
          capturedJobPayload = jobData;
          return { id: "job-sheet-ep-1", ...jobData };
        },
      };

      const testEngine = new ExecutionEngine({
        jobQueueService: mockQueue,
      });

      const origLaunch = executionEngine.launch;
      const origExecute = executionEngine.execute;
      executionEngine.launch = testEngine.launch.bind(testEngine);
      executionEngine.execute = testEngine.execute.bind(testEngine);

      try {
        const dbMediaStore = new Map();
        const dbRelationRows = [];
        const characterId = "char-sheet-target-123";

        db.projects = {
          findById: async () => ({ id: "proj-ep-charsheet", user_id: "user-ep-charsheet" }),
        };

        db.workflows = {
          createWorkflow: async (wf) => wf,
          getWorkflow: async (id) => ({ id, project_id: "proj-ep-charsheet" }),
        };

        db.characters = {
          findById: async (id) => ({ id, user_id: "user-ep-charsheet", project_id: "proj-ep-charsheet", name: "Kaelen" }),
          findByCharacterId: async (id) => ({ id, user_id: "user-ep-charsheet", project_id: "proj-ep-charsheet", name: "Kaelen" }),
          updateCharacter: async (id, patch) => ({ id, ...patch }),
        };

        db.workflowMedia = {
          linkMedia: async ({ workflowId, mediaId, role }) => {
            const row = { workflow_id: workflowId, media_id: mediaId, role };
            dbRelationRows.push(row);
            return row;
          },
        };

        db.media = {
          createMedia: async (m) => {
            const id = m.id || `media-${randomUUID()}`;
            const record = { ...m, id };
            dbMediaStore.set(id, record);
            return record;
          },
          findById: async (id) => dbMediaStore.get(id),
          findByWorkflow: async (wfId) => {
            const linkedIds = new Set(dbRelationRows.filter((r) => r.workflow_id === wfId).map((r) => r.media_id));
            return Array.from(dbMediaStore.values()).filter((m) => linkedIds.has(m.id));
          },
          updateMedia: async (id, patch) => {
            const existing = dbMediaStore.get(id) || {};
            const updated = { ...existing, ...patch };
            dbMediaStore.set(id, updated);
            return updated;
          },
        };

        const req = {
          user: { id: "user-ep-charsheet" },
          params: { characterId },
          body: {
            prompt: "elven rogue in shadow leather armor",
            projectId: "proj-ep-charsheet",
          },
        };

        let responseData = null;
        const res = {
          status() {
            return this;
          },
          json(data) {
            responseData = data;
            return this;
          },
        };

        await generateCharacterSheet(req, res);

        assert.ok(responseData?.ok, "Character sheet response must be ok");
        assert.ok(capturedJobPayload, "Job was enqueued via launch");

        assert.strictEqual(capturedJobPayload.serverContext.workflowId, characterId);
        assert.ok(capturedJobPayload.serverContext.mediaIds.length > 0);
        const placeholderMediaId = capturedJobPayload.serverContext.mediaIds[0];

        const runResult = await testEngine.execute({
          useCaseId: capturedJobPayload.useCaseId,
          input: capturedJobPayload.input,
          userId: capturedJobPayload.userId,
          executionId: capturedJobPayload.executionId,
          runId: capturedJobPayload.workflowRunId,
          nodeContext: { ...createDefaultMockNodeContext({ db }), useExternalPersistence: false },
        });

        assert.strictEqual(runResult.status, "completed");

        const completedMedia = dbMediaStore.get(placeholderMediaId);
        assert.strictEqual(completedMedia.status, "success");
      } finally {
        executionEngine.launch = origLaunch;
        executionEngine.execute = origExecute;
      }
    });

    it("ENTRY POINT 4: characterController.createCharacter (AI visual sheet path) produces server targets and completes media", async () => {
      let capturedJobPayload = null;
      const mockQueue = {
        addUseCaseJob: async (jobData) => {
          capturedJobPayload = jobData;
          return { id: "job-createchar-ep-1", ...jobData };
        },
      };

      const testEngine = new ExecutionEngine({
        jobQueueService: mockQueue,
      });

      const origLaunch = executionEngine.launch;
      const origExecute = executionEngine.execute;
      executionEngine.launch = testEngine.launch.bind(testEngine);
      executionEngine.execute = testEngine.execute.bind(testEngine);

      try {
        const dbMediaStore = new Map();
        const dbRelationRows = [];

        db.projects = {
          findById: async () => ({ id: "proj-ep-createchar", user_id: "user-ep-createchar" }),
        };

        db.workflows = {
          createWorkflow: async (wf) => wf,
        };

        db.characters = {
          createCharacter: async (payload) => ({
            id: payload.id || randomUUID(),
            ...payload,
          }),
          upsert: async (payload) => ({
            id: payload.id || randomUUID(),
            ...payload,
          }),
          findById: async (id) => ({ id, user_id: "user-ep-createchar", project_id: "proj-ep-createchar" }),
          findByCharacterId: async (id) => ({ id, user_id: "user-ep-createchar", project_id: "proj-ep-createchar" }),
          updateCharacter: async (id, patch) => ({ id, ...patch }),
        };

        db.workflowMedia = {
          linkMedia: async ({ workflowId, mediaId, role }) => {
            const row = { workflow_id: workflowId, media_id: mediaId, role };
            dbRelationRows.push(row);
            return row;
          },
        };

        db.media = {
          createMedia: async (m) => {
            const id = m.id || `media-${randomUUID()}`;
            const record = { ...m, id };
            dbMediaStore.set(id, record);
            return record;
          },
          findById: async (id) => dbMediaStore.get(id),
          findByWorkflow: async (wfId) => {
            const linkedIds = new Set(dbRelationRows.filter((r) => r.workflow_id === wfId).map((r) => r.media_id));
            return Array.from(dbMediaStore.values()).filter((m) => linkedIds.has(m.id));
          },
          updateMedia: async (id, patch) => {
            const existing = dbMediaStore.get(id) || {};
            const updated = { ...existing, ...patch };
            dbMediaStore.set(id, updated);
            return updated;
          },
        };

        const req = {
          user: { id: "user-ep-createchar" },
          body: {
            name: "Valkyrie",
            prompt: "armored warrior with glowing spear",
            projectId: "proj-ep-createchar",
          },
        };

        let responseData = null;
        const res = {
          status() {
            return this;
          },
          json(data) {
            responseData = data;
            return this;
          },
        };

        await createCharacter(req, res);

        assert.ok(responseData?.ok, "createCharacter response must be ok");
        assert.ok(capturedJobPayload, "Job was enqueued via launch");

        assert.strictEqual(capturedJobPayload.serverContext.workflowId, responseData.characterId);
        assert.ok(capturedJobPayload.serverContext.mediaIds.length > 0);
        const placeholderMediaId = capturedJobPayload.serverContext.mediaIds[0];

        const runResult = await testEngine.execute({
          useCaseId: capturedJobPayload.useCaseId,
          input: capturedJobPayload.input,
          userId: capturedJobPayload.userId,
          executionId: capturedJobPayload.executionId,
          runId: capturedJobPayload.workflowRunId,
          nodeContext: { ...createDefaultMockNodeContext({ db }), useExternalPersistence: false },
        });

        assert.strictEqual(runResult.status, "completed");

        const completedMedia = dbMediaStore.get(placeholderMediaId);
        assert.strictEqual(completedMedia.status, "success");
      } finally {
        executionEngine.launch = origLaunch;
        executionEngine.execute = origExecute;
      }
    });
  });
});
}

// ─── Source: orchestrationFailureBillingBoundary.test.js ───
{
describe("Execution Error & Hook Propagation Boundary Tests (BUG-01 / V3)", () => {
  let failurePayloads = [];
  let engine;

  beforeEach(() => {
    failurePayloads = [];

    engine = new ExecutionEngine({
      onFailure: async (payload) => { failurePayloads.push(payload); },
    });
  });

  it("TEST 1: WorkflowExecutor throws when given invalid workflow structure", async () => {
    const executor = new WorkflowExecutor(createDefaultV3NodeRegistry());
    await assert.rejects(
      async () => {
        await executor.execute({
          workflow: { id: "test-wf-bug01", nodes: null },
          input: { prompt: "test prompt" },
        });
      },
      /must include a nodes array/i
    );
  });

  it("TEST 2: ExecutionEngine throws and fires onFailure when workflow run ends in non-completed status (e.g. running)", async () => {
    engine.executor = {
      execute: async () => ({
        executionId: "run-failed-swallowed",
        status: "running",
        outputs: null,
      }),
    };

    await assert.rejects(
      async () => {
        await engine.execute({
          useCaseId: "image-generation-v3",
          input: {
            workflow_id: "wf-bug01-media",
            media_id: "media-placeholder-1",
          },
          userId: "user-victim-123",
        });
      },
      /(did not complete|WORKFLOW_INCOMPLETE|failed)/i
    );

    assert.strictEqual(failurePayloads.length, 1, "onFailure must fire when run did not complete");
    assert.strictEqual(failurePayloads[0].stage, "execute");
    assert.strictEqual(failurePayloads[0].input.media_id, "media-placeholder-1");
  });

  it("TEST 3: End-to-end execution failure: onFailure fires with input targets, NO onSuccess", async () => {
    engine.executor = {
      execute: async () => {
        const err = new TypeError("Cannot read properties of undefined (reading 'filter')");
        err.code = "ORCHESTRATION_ERROR";
        throw err;
      },
    };

    await assert.rejects(
      async () => {
        await engine.execute({
          useCaseId: "image-generation-v3",
          input: {
            workflow_id: "wf-bug01-e2e",
            media_id: "media-placeholder-e2e",
          },
          userId: "user-audit-123",
        });
      },
      /Cannot read properties|filter|ORCHESTRATION_ERROR/i
    );

    assert.strictEqual(failurePayloads.length, 1, "onFailure must fire on execution failure");
    assert.strictEqual(failurePayloads[0].input.media_id, "media-placeholder-e2e");
  });
});
}

// ─── Source: walletMisconfigurationBoundary.test.js ───
{
describe("F2.4-a — Wallet Misconfiguration & Zero Price Invariants (V3)", () => {
  let origEnv;

  beforeEach(() => {
    origEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("TEST 1: In production (NODE_ENV=production), server refuses to boot if wallet credentials are missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_KEY;

    assert.throws(
      () => {
        assertWalletConfiguredForEnvironment();
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Fatal: WalletService is required in production/i);
        return true;
      }
    );
  });

  it("TEST 2: #billing/tools reserveCredits throws BillingValidationError for invalid amounts (undefined, null, NaN, -1, 'abc')", async () => {
    const invalidAmounts = [undefined, null, NaN, -1, -5, "abc", "0", {}, []];

    for (const invalidAmount of invalidAmounts) {
      await assert.rejects(
        async () => {
          await reserveCredits(
            {
              userId: "user-test",
              amount: invalidAmount,
              referenceId: `ref-invalid-${String(invalidAmount)}`,
            },
            { walletService: new InMemoryWalletService() }
          );
        },
        (err) => {
          assert.ok(err instanceof BillingValidationError);
          return true;
        }
      );
    }
  });

  it("TEST 5: WalletService.reserve throws PRICING_CONFIG_ERROR for invalid amounts (undefined, null, NaN, -1, 'abc')", async () => {
    const { WalletService } = await import("../../../src/systems/billing/internal/services/WalletService.js");
    const wallet = new WalletService("https://mock.supabase.co", "mock-key");
    const invalidAmounts = [undefined, null, NaN, -1, -5, "abc", "0", {}, []];

    for (const invalidAmount of invalidAmounts) {
      await assert.rejects(
        async () => {
          await wallet.reserve({
            userId: "user-test",
            amount: invalidAmount,
            referenceId: `ref-ws-${String(invalidAmount)}`,
          });
        },
        (err) => {
          assert.strictEqual(err.code, "PRICING_CONFIG_ERROR");
          assert.strictEqual(err.category, "SERVER_FAULT");
          return true;
        }
      );
    }
  });

  it("TEST 6: ImageGenerateNode.estimateCost throws on missing or invalid model", () => {
    assert.throws(
      () => ImageGenerateNode.estimateCost({ prompt: "test" }),
      /Missing required model/i
    );
  });

  it("TEST 7: pricing failure at prepare time through real controller -> placeholders failed, clean 500 with INTERNAL_ERROR + traceId", async () => {
    const mediaRows = new Map();
    const origDbMedia = db.media;
    const origDbProjects = db.projects;
    const origDbWorkflows = db.workflows;
    const origLaunch = executionEngine.launch;

    db.media = {
      createMedia: async (data) => {
        const row = { ...data, status: data.status || "processing" };
        mediaRows.set(data.id, row);
        return row;
      },
      findByWorkflow: async (wfId) => Array.from(mediaRows.values()).filter((m) => m.workflow_id === wfId),
      updateMedia: async (id, data) => {
        const existing = mediaRows.get(id) || { id };
        const updated = { ...existing, ...data };
        mediaRows.set(id, updated);
        return updated;
      },
    };

    db.projects = {
      findById: async (id) => ({ id, user_id: "user-pricing-fail" }),
    };

    db.workflows = {
      createWorkflow: async (data) => data,
    };

    executionEngine.launch = async () => {
      const pricingErr = new Error("Pricing engine failed to resolve valid cost: NaN");
      pricingErr.code = "PRICING_CONFIG_ERROR";
      pricingErr.category = "SERVER_FAULT";
      pricingErr.statusCode = 500;
      throw pricingErr;
    };

    try {
      let statusCode = 200;
      let responseData = null;
      const req = {
        user: { id: "user-pricing-fail" },
        body: { prompt: "Test prompt", model: "nanobana_2", project_id: "proj-pricing-fail" },
      };
      const res = {
        status: (code) => {
          statusCode = code;
          return res;
        },
        json: (data) => {
          responseData = data;
          return res;
        },
      };

      await generateImage(req, res);

      assert.strictEqual(statusCode, 500);
      assert.strictEqual(responseData.ok, false);
      assert.strictEqual(responseData.code, "INTERNAL_ERROR");
      assert.ok(responseData.traceId, "Response must include traceId");
      assert.match(responseData.message, /failed to generate image/i);

      assert.ok(mediaRows.size > 0, "Placeholders must have been created");
      for (const [, row] of mediaRows) {
        assert.strictEqual(row.status, "failed");
        assert.match(row.error_message, /Pricing engine failed/i);
      }
    } finally {
      db.media = origDbMedia;
      db.projects = origDbProjects;
      db.workflows = origDbWorkflows;
      executionEngine.launch = origLaunch;
    }
  });
});
}

// ─── Source: useCasePendingMediaZombieCleanup.test.js ───
{
describe("Sprint R2: ExecutionEngine Failure Hook Propagation", () => {
  it("when queue.addUseCaseJob throws, external onFailure hook is invoked with serverContext", async () => {
    const failures = [];

    const mockQueue = {
      addUseCaseJob: async () => {
        throw new Error("Redis cluster connection lost during dispatch");
      },
    };

    const service = new ExecutionEngine({
      jobQueueService: mockQueue,
      onFailure: async (payload) => {
        failures.push(payload);
      },
    });

    const serverMediaIds = ["media-pending-1", "media-pending-2"];
    let caughtError = null;

    try {
      await service.launch({
        useCaseId: "image-generation-v3",
        input: {
          prompt: "A neon cyborg cat",
          model: "nanobana_2",
          serverMediaIds,
          serverWorkflowId: "wf-test-1",
        },
        userId: "user-1",
        serverContext: {
          workflowId: "wf-test-1",
          mediaIds: serverMediaIds,
        },
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, "launch should throw when queue dispatch fails");
    assert.equal(caughtError.code, "QUEUE_DISPATCH_FAILED");
    assert.equal(caughtError.statusCode, 503);

    assert.equal(failures.length, 1, "onFailure must fire once on dispatch failure");
    assert.equal(failures[0].stage, "launch");
    assert.equal(failures[0].errorCode, "QUEUE_DISPATCH_FAILED");
    assert.deepEqual(failures[0].serverContext.mediaIds, serverMediaIds);
  });

  it("when standalone execution fails with workflowId = null, onFailure hook receives input targets", async () => {
    const failures = [];

    const service = new ExecutionEngine({
      onFailure: async (payload) => {
        failures.push(payload);
      },
    });

    service.executor = {
      execute: async () => {
        throw new Error("Provider GPU timeout during rendering");
      },
    };

    let caughtError = null;
    try {
      await service.execute({
        useCaseId: "image-generation-v3",
        input: {
          serverMediaIds: ["media-standalone-1", "media-standalone-2"],
        },
        userId: "user-2",
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, "execute should re-throw execution error");
    assert.equal(failures.length, 1, "onFailure hook must be notified once");
    assert.equal(failures[0].stage, "execute");
    assert.deepEqual(failures[0].input.serverMediaIds, ["media-standalone-1", "media-standalone-2"]);
  });
});
}

after(() => {
  setTimeout(() => process.exit(0), 100);
});
