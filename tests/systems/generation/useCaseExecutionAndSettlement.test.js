import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  V3Dispatcher,
  WorkflowExecutor,
  GraphCompiler,
  SaveMediaNode,
  ImageGenerateNode,
  createDefaultV3NodeRegistry,
  imageGenerationV3,
  videoGenerationV3,
  characterSheetV3,
  WorkflowBillingGateway,
  ERROR_CODES,
} from "#generation/tools";
import { useCaseService, db, assertWalletConfiguredForEnvironment } from "../../../src/container.js";
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

  it("F2.1-c TEST 2: WorkflowExecutor uses serverMediaIds when media_id is absent and never calls createMedia", async () => {
    const executor = new WorkflowExecutor(createDefaultV3NodeRegistry());

    await executor.execute({
      workflow: imageGenerationV3,
      input: {
        prompt: "A futuristic city",
        model: "nanobana_2",
        serverWorkflowId: "attacker-workflow-id",
        serverMediaIds: ["attacker-media-id"],
      },
      context: {
        db,
        ...createDefaultMockNodeContext(),
      },
    });

    assert.equal(mediaCreateCalls.length, 0, "createMedia fallback must NOT be called");
    assert.equal(mediaUpdateCalls.length, 1, "Exactly one media update");
    assert.equal(mediaUpdateCalls[0].id, "attacker-media-id");
    assert.equal(mediaUpdateCalls[0].patch.status, "completed");
  });

  it("F2.1-d TEST 3: Settle hold called exactly 1 time on success and 0 times on failure", async () => {
    let commitCount = 0;
    let rollbackCount = 0;

    const mockWalletService = {
      reserve: async () => ({ status: "held" }),
      commitHoldIdempotent: async () => {
        commitCount++;
        return { status: "committed" };
      },
      rollback: async () => {
        rollbackCount++;
        return { status: "voided" };
      },
    };

    const dispatcher = new V3Dispatcher({
      walletService: mockWalletService,
      db,
      mediaTools: {
        markMediaFailed: async () => {},
      },
    });

    // Case 1: Successful run
    dispatcher.executor = {
      execute: async () => ({
        executionId: "exec-success",
        status: "completed",
        outputs: { test: true },
      }),
    };

    await dispatcher.executeQueuedUseCase({
      useCaseId: "image-generation-v1",
      input: { workflow_id: "wf-1", media_id: "m-1" },
      userId: "00000000-0000-0000-0000-000000000001",
      billingHoldId: "hold-test-success",
    });

    assert.equal(commitCount, 1, "commitHoldIdempotent must be called exactly 1 time on success");
    assert.equal(rollbackCount, 0, "rollback must NOT be called on success");

    // Case 2: Failed run
    dispatcher.executor = {
      execute: async () => {
        const failErr = new Error("Provider timeout");
        failErr.code = "UPSTREAM_TIMEOUT";
        throw failErr;
      },
    };

    await assert.rejects(
      async () => {
        await dispatcher.executeQueuedUseCase({
          useCaseId: "image-generation-v1",
          input: { workflow_id: "wf-2", media_id: "m-2" },
          userId: "00000000-0000-0000-0000-000000000001",
          billingHoldId: "hold-test-fail",
        });
      },
      /Provider timeout/
    );

    assert.equal(commitCount, 1, "commitHoldIdempotent must still be 1 (0 calls on failed run)");
    assert.equal(rollbackCount, 1, "rollback must be called exactly 1 time on failed run");
  });

  it("F2.1-f TEST 4: End-to-end happy path for imageGeneration (image-generation-v3)", async () => {
    let settledRef = null;
    const mockWallet = {
      reserve: async () => ({ status: "held" }),
      commitHoldIdempotent: async (ref) => {
        settledRef = ref;
        return { status: "committed" };
      },
      rollback: async () => {},
    };

    const dispatcher = new V3Dispatcher({
      walletService: mockWallet,
      db,
    });

    const result = await dispatcher.executeQueuedV3Run({
      useCaseId: "image-generation-v1",
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
      billingHoldId: "hold-img-e2e",
      nodeContext: createDefaultMockNodeContext(),
    });

    assert.equal(result.status, "completed");
    assert.equal(settledRef, "hold-img-e2e", "Upfront hold must be settled once");
    assert.equal(mediaUpdateCalls.length, 1, "Placeholder media must be updated to completed");
    assert.equal(mediaUpdateCalls[0].id, "media-img-e2e");
    assert.equal(mediaUpdateCalls[0].patch.status, "completed");
    assert.equal(mediaUpdateCalls[0].patch.url, "https://mock-storage.example.com/e2e-image.png");
  });

  it("F2.1-f TEST 5: End-to-end happy path for videoGeneration (video-generation-v3)", async () => {
    let settledRef = null;
    const mockWallet = {
      reserve: async () => ({ status: "held" }),
      commitHoldIdempotent: async (ref) => {
        settledRef = ref;
        return { status: "committed" };
      },
      rollback: async () => {},
    };

    const dispatcher = new V3Dispatcher({
      walletService: mockWallet,
      db,
    });

    const result = await dispatcher.executeQueuedV3Run({
      useCaseId: "video-generation-v1",
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
      billingHoldId: "hold-vid-e2e",
      nodeContext: createDefaultMockNodeContext(),
    });

    assert.equal(result.status, "completed");
    assert.equal(settledRef, "hold-vid-e2e", "Video hold must be settled once");
    assert.equal(mediaUpdateCalls.length, 1, "Placeholder media must be updated to completed");
    assert.equal(mediaUpdateCalls[0].id, "media-vid-e2e");
    assert.equal(mediaUpdateCalls[0].patch.status, "completed");
    assert.equal(mediaUpdateCalls[0].patch.url, "https://mock-storage.example.com/e2e-video.mp4");
  });

  it("F2.1-f TEST 6: End-to-end happy path for characterSheet (character-sheet-v3)", async () => {
    let settledRef = null;
    const mockWallet = {
      reserve: async () => ({ status: "held" }),
      commitHoldIdempotent: async (ref) => {
        settledRef = ref;
        return { status: "committed" };
      },
      rollback: async () => {},
    };

    const dispatcher = new V3Dispatcher({
      walletService: mockWallet,
      db,
    });

    const result = await dispatcher.executeQueuedV3Run({
      useCaseId: "character-sheet-v1",
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
      billingHoldId: "hold-char-e2e",
      nodeContext: createDefaultMockNodeContext(),
    });

    assert.equal(result.status, "completed");
    assert.equal(settledRef, "hold-char-e2e", "Character sheet hold must be settled once");
    assert.equal(characterUpdateCalls.length, 0, "V3 save_media node must not touch characters table directly");
    assert.equal(mediaUpdateCalls.length, 1, "Placeholder media must be updated to completed");
    assert.equal(mediaUpdateCalls[0].id, "media-char-e2e");
    assert.equal(mediaUpdateCalls[0].patch.status, "completed");
    assert.equal(mediaUpdateCalls[0].patch.url, "https://mock-storage.example.com/e2e-image.png");
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

  it("TEST 1 (F2.3-a): job payload with workflow_id/media_id/characterId in input but no server* fields fails closed, releases hold, and fails media", async () => {
    const wallet = new InMemoryWalletService();
    await wallet.setBalance("user-attacker", 100);

    let mediaUpdatedWithStatus = null;
    let failedPendingMediaCalls = [];

    const mockMediaRepo = {
      findById: async (id) => ({ id, workflow_id: "wf-legacy-target", status: "processing" }),
      findByWorkflow: async (wfId) => [
        { id: "media-legacy-target", workflow_id: wfId, step_id: "image_generation", status: "processing" },
      ],
      updateMedia: async (id, fields) => {
        mediaUpdatedWithStatus = fields.status;
        return { id, ...fields };
      },
      failPendingMediaByWorkflow: async (wfId, message) => {
        failedPendingMediaCalls.push({ wfId, message });
        return [{ id: "media-legacy-target", status: "failed", error_message: message }];
      },
    };

    db.media = mockMediaRepo;

    const dispatcher = new V3Dispatcher({
      walletService: wallet,
      db: { media: mockMediaRepo },
    });

    await wallet.reserve({
      userId: "user-attacker",
      amount: 10,
      referenceId: "hold-legacy-test",
    });

    const legacyPayload = {
      useCaseId: "image-generation-v1",
      input: {
        prompt: "test unverified input targets",
        model: "nanobana_2",
        workflow_id: "wf-legacy-target",
        media_id: "media-legacy-target",
        characterId: "char-legacy-target",
      },
      userId: "user-attacker",
      billingHoldId: "hold-legacy-test",
    };

    let caughtError = null;
    try {
      await dispatcher.executeQueuedUseCase(legacyPayload);
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, "Job must fail when no server-verified targets exist");
    assert.notStrictEqual(mediaUpdatedWithStatus, "completed", "Node must NOT complete media without server-verified target");
    const holdRecord = wallet.reservations.get("hold-legacy-test");
    assert.ok(
      holdRecord.status === "released" || holdRecord.status === "rolled_back",
      "Billing hold must be released/rolled back on fail-closed rejection"
    );
    assert.ok(failedPendingMediaCalls.length > 0, "failPendingMediaByWorkflow must be called on failure");
  });

  it("TEST 2 (F2.4-b1): ImageGenerateNode with 4 surplus assets and 1 target placeholder — maps FIRST asset, run SUCCEEDS, hold settled", async () => {
    const multiAssets = [
      { url: "https://mock-storage.example.com/asset-1.png", width: 1024, height: 1024 },
      { url: "https://mock-storage.example.com/asset-2.png", width: 1024, height: 1024 },
      { url: "https://mock-storage.example.com/asset-3.png", width: 1024, height: 1024 },
      { url: "https://mock-storage.example.com/asset-4.png", width: 1024, height: 1024 },
    ];

    const wallet = new InMemoryWalletService();
    await wallet.setBalance("user-multi", 100);

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

    const dispatcher = new V3Dispatcher({
      walletService: wallet,
      db: { media: mockMediaRepo },
    });

    await wallet.reserve({
      userId: "user-multi",
      amount: 10,
      referenceId: "hold-multi-test",
    });

    await dispatcher.executeQueuedV3Run({
      useCaseId: "image-generation-v1",
      input: {
        prompt: "four variations of cat",
        model: "nanobana_2",
        parameters: {},
        serverWorkflowId: "wf-multi",
        serverMediaIds: ["media-placeholder-1"],
      },
      userId: "user-multi",
      billingHoldId: "hold-multi-test",
      nodeContext: createDefaultMockNodeContext({
        executeProvider: async () => ({
          assets: multiAssets,
        }),
      }),
    });

    const completedUpdate = updatedMediaRows.find((m) => m.status === "completed");
    assert.ok(completedUpdate, "Placeholder must be completed with first asset");
    assert.strictEqual(
      completedUpdate.url,
      "https://mock-storage.example.com/asset-1.png",
      "First asset URL must be used (surplus assets 2-4 are dropped)"
    );
    assert.strictEqual(createdMediaRows.length, 0, "No extra media rows created");

    const holdRecord = wallet.reservations.get("hold-multi-test");
    assert.ok(
      holdRecord.status === "settled" || holdRecord.status === "committed" || holdRecord.status === "released",
      `Hold status after success: "${holdRecord.status}" — expected settled/committed`
    );
  });

  describe("TEST 3 (F2.3-e): Table-driven hold rollback & media failure across ALL error codes", () => {
    const allCodes = Array.from(
      new Set([
        ...Object.values(ERROR_CODES),
        "SOME_UNKNOWN_ERROR_CODE",
        "ANOTHER_UNREGISTERED_ERROR",
        undefined,
      ])
    );

    for (const testCode of allCodes) {
      it(`error code "${testCode}" rolls back hold and marks media failed`, async () => {
        const wallet = new InMemoryWalletService();
        await wallet.setBalance("user-err-test", 100);

        let mediaFailedCalled = false;
        const mockMediaRepo = {
          failPendingMediaByWorkflow: async () => {
            mediaFailedCalled = true;
            return [{ id: "m-err-1", status: "failed" }];
          },
          findByWorkflow: async () => [],
        };

        const dispatcher = new V3Dispatcher({
          walletService: wallet,
          db: { media: mockMediaRepo },
          mediaTools: {
            markMediaFailed: async () => {},
          },
        });

        dispatcher.executor = {
          execute: async () => {
            const simulatedErr = new Error(`Simulated failure for code: ${testCode}`);
            if (testCode) simulatedErr.code = testCode;
            throw simulatedErr;
          },
        };

        const holdId = `hold-err-${randomUUID()}`;
        await wallet.reserve({
          userId: "user-err-test",
          amount: 10,
          referenceId: holdId,
        });

        const payload = {
          useCaseId: "image-generation-v1",
          input: {
            prompt: "error test prompt",
            model: "nanobana_2",
            serverWorkflowId: "wf-err-target",
            serverMediaIds: ["m-err-1"],
          },
          userId: "user-err-test",
          billingHoldId: holdId,
        };

        let threw = false;
        try {
          await dispatcher.executeQueuedUseCase(payload);
        } catch {
          threw = true;
        }

        assert.ok(threw, "Execution must throw on error");

        const hold = wallet.reservations.get(holdId);
        assert.ok(
          hold.status === "released" || hold.status === "rolled_back",
          `Hold must be rolled back for error code "${testCode}"`
        );
        assert.ok(mediaFailedCalled, `failPendingMediaByWorkflow must be called for error code "${testCode}"`);
      });
    }
  });

  describe("F2.3-c: Integration tests per entry point WITHOUT hand-injected targets", () => {
    it("ENTRY POINT 1: imageController.generateImage produces server targets, completes media, and settles hold once", async () => {
      const wallet = new InMemoryWalletService();
      await wallet.setBalance("user-ep-img", 100);

      let capturedJobPayload = null;
      const mockQueue = {
        addUseCaseJob: async (jobData) => {
          capturedJobPayload = jobData;
          return { id: "job-img-ep-1", ...jobData };
        },
      };

      const testDispatcher = new V3Dispatcher({
        walletService: wallet,
        jobQueueService: mockQueue,
        db,
      });

      const origPrepare = useCaseService.prepareAndEnqueue;
      const origExecute = useCaseService.executeQueuedUseCase;
      useCaseService.prepareAndEnqueue = testDispatcher.prepareAndEnqueue.bind(testDispatcher);
      useCaseService.executeQueuedUseCase = testDispatcher.executeQueuedUseCase.bind(testDispatcher);

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

        assert.ok(capturedJobPayload, "Job was enqueued via prepareAndEnqueue");
        assert.strictEqual(capturedJobPayload.serverContext.v1_workflow_id, workflowId);
        assert.deepStrictEqual(capturedJobPayload.serverContext.mediaIds, [mediaId]);
        assert.strictEqual(capturedJobPayload.input.serverWorkflowId, workflowId);
        assert.deepStrictEqual(capturedJobPayload.input.serverMediaIds, [mediaId]);

        const runResult = await testDispatcher.executeQueuedV3Run({
          useCaseId: capturedJobPayload.useCaseId,
          input: capturedJobPayload.input,
          userId: capturedJobPayload.userId,
          billingHoldId: capturedJobPayload.billingHoldId,
          nodeContext: createDefaultMockNodeContext(),
        });

        assert.strictEqual(runResult.status, "completed");

        const completedMedia = dbMediaStore.get(mediaId);
        assert.strictEqual(completedMedia.status, "completed", "Placeholder media must be completed by node");
        assert.ok(completedMedia.url.startsWith("https://"), "Media URL must be populated");

        const hold = wallet.reservations.get(capturedJobPayload.billingHoldId);
        assert.strictEqual(hold.status, "committed", "Billing hold must be settled/committed exactly once");
      } finally {
        useCaseService.prepareAndEnqueue = origPrepare;
        useCaseService.executeQueuedUseCase = origExecute;
      }
    });

    it("ENTRY POINT 2: videoController.generateVideo produces server targets, completes media, and settles hold once", async () => {
      const wallet = new InMemoryWalletService();
      await wallet.setBalance("user-ep-vid", 100);

      let capturedJobPayload = null;
      const mockQueue = {
        addUseCaseJob: async (jobData) => {
          capturedJobPayload = jobData;
          return { id: "job-vid-ep-1", ...jobData };
        },
      };

      const testDispatcher = new V3Dispatcher({
        walletService: wallet,
        jobQueueService: mockQueue,
        db,
      });

      const origPrepare = useCaseService.prepareAndEnqueue;
      const origExecute = useCaseService.executeQueuedUseCase;
      useCaseService.prepareAndEnqueue = testDispatcher.prepareAndEnqueue.bind(testDispatcher);
      useCaseService.executeQueuedUseCase = testDispatcher.executeQueuedUseCase.bind(testDispatcher);

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
        assert.strictEqual(capturedJobPayload.serverContext.v1_workflow_id, workflowId);
        assert.deepStrictEqual(capturedJobPayload.serverContext.mediaIds, [mediaId]);

        const runResult = await testDispatcher.executeQueuedV3Run({
          useCaseId: capturedJobPayload.useCaseId,
          input: capturedJobPayload.input,
          userId: capturedJobPayload.userId,
          billingHoldId: capturedJobPayload.billingHoldId,
          nodeContext: createDefaultMockNodeContext(),
        });

        assert.strictEqual(runResult.status, "completed");

        const completedMedia = dbMediaStore.get(mediaId);
        assert.strictEqual(completedMedia.status, "completed");
        assert.ok(completedMedia.url);

        const hold = wallet.reservations.get(capturedJobPayload.billingHoldId);
        assert.strictEqual(hold.status, "committed");
      } finally {
        useCaseService.prepareAndEnqueue = origPrepare;
        useCaseService.executeQueuedUseCase = origExecute;
      }
    });

    it("ENTRY POINT 3: characterController.generateCharacterSheet produces server targets, completes media, and settles hold once", async () => {
      const wallet = new InMemoryWalletService();
      await wallet.setBalance("user-ep-charsheet", 100);

      let capturedJobPayload = null;
      const mockQueue = {
        addUseCaseJob: async (jobData) => {
          capturedJobPayload = jobData;
          return { id: "job-sheet-ep-1", ...jobData };
        },
      };

      const testDispatcher = new V3Dispatcher({
        walletService: wallet,
        jobQueueService: mockQueue,
        db,
      });

      const origPrepare = useCaseService.prepareAndEnqueue;
      const origExecute = useCaseService.executeQueuedUseCase;
      useCaseService.prepareAndEnqueue = testDispatcher.prepareAndEnqueue.bind(testDispatcher);
      useCaseService.executeQueuedUseCase = testDispatcher.executeQueuedUseCase.bind(testDispatcher);

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
        assert.ok(capturedJobPayload, "Job was enqueued via prepareAndEnqueue");

        assert.strictEqual(capturedJobPayload.serverContext.v1_workflow_id, characterId);
        assert.ok(capturedJobPayload.serverContext.mediaIds.length > 0);
        const placeholderMediaId = capturedJobPayload.serverContext.mediaIds[0];

        const runResult = await testDispatcher.executeQueuedV3Run({
          useCaseId: capturedJobPayload.useCaseId,
          input: capturedJobPayload.input,
          userId: capturedJobPayload.userId,
          billingHoldId: capturedJobPayload.billingHoldId,
          nodeContext: createDefaultMockNodeContext(),
        });

        assert.strictEqual(runResult.status, "completed");

        const completedMedia = dbMediaStore.get(placeholderMediaId);
        assert.strictEqual(completedMedia.status, "completed");

        const hold = wallet.reservations.get(capturedJobPayload.billingHoldId);
        assert.strictEqual(hold.status, "committed");
      } finally {
        useCaseService.prepareAndEnqueue = origPrepare;
        useCaseService.executeQueuedUseCase = origExecute;
      }
    });

    it("ENTRY POINT 4: characterController.createCharacter (AI visual sheet path) produces server targets, completes media, and settles hold once", async () => {
      const wallet = new InMemoryWalletService();
      await wallet.setBalance("user-ep-createchar", 100);

      let capturedJobPayload = null;
      const mockQueue = {
        addUseCaseJob: async (jobData) => {
          capturedJobPayload = jobData;
          return { id: "job-createchar-ep-1", ...jobData };
        },
      };

      const testDispatcher = new V3Dispatcher({
        walletService: wallet,
        jobQueueService: mockQueue,
        db,
      });

      const origPrepare = useCaseService.prepareAndEnqueue;
      const origExecute = useCaseService.executeQueuedUseCase;
      useCaseService.prepareAndEnqueue = testDispatcher.prepareAndEnqueue.bind(testDispatcher);
      useCaseService.executeQueuedUseCase = testDispatcher.executeQueuedUseCase.bind(testDispatcher);

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
        assert.ok(capturedJobPayload, "Job was enqueued via prepareAndEnqueue");

        assert.strictEqual(capturedJobPayload.serverContext.v1_workflow_id, responseData.characterId);
        assert.ok(capturedJobPayload.serverContext.mediaIds.length > 0);
        const placeholderMediaId = capturedJobPayload.serverContext.mediaIds[0];

        const runResult = await testDispatcher.executeQueuedV3Run({
          useCaseId: capturedJobPayload.useCaseId,
          input: capturedJobPayload.input,
          userId: capturedJobPayload.userId,
          billingHoldId: capturedJobPayload.billingHoldId,
          nodeContext: createDefaultMockNodeContext(),
        });

        assert.strictEqual(runResult.status, "completed");

        const completedMedia = dbMediaStore.get(placeholderMediaId);
        assert.strictEqual(completedMedia.status, "completed");

        const hold = wallet.reservations.get(capturedJobPayload.billingHoldId);
        assert.strictEqual(hold.status, "committed");
      } finally {
        useCaseService.prepareAndEnqueue = origPrepare;
        useCaseService.executeQueuedUseCase = origExecute;
      }
    });
  });
});
}

// ─── Source: orchestrationFailureBillingBoundary.test.js ───
{
describe("Execution Error & Billing Settlement Boundary Tests (BUG-01 / V3)", () => {
  let settledCalls = [];
  let rollbackCalls = [];
  let mediaUpdates = [];
  let mockMediaDb;
  let dispatcher;

  beforeEach(() => {
    settledCalls = [];
    rollbackCalls = [];
    mediaUpdates = [];

    mockMediaDb = {
      findByWorkflow: async (wfId) => [
        { id: "media-placeholder-1", status: "processing", workflow_id: wfId },
      ],
      updateMedia: async (id, patch) => {
        mediaUpdates.push({ id, ...patch });
        return { id, ...patch };
      },
    };

    dispatcher = new V3Dispatcher({
      billingTools: {
        settleHold: async ({ referenceId, metadata }) => {
          settledCalls.push({ referenceId, metadata });
          return { settled: true };
        },
        releaseHold: async ({ referenceId, metadata }) => {
          rollbackCalls.push({ referenceId, metadata });
          return { rolledBack: true };
        },
      },
      mediaTools: {
        markMediaFailed: async () => {},
      },
      db: { media: mockMediaDb },
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

  it("TEST 2: V3Dispatcher throws when workflow run ends in non-completed status (e.g. running)", async () => {
    dispatcher.executor = {
      execute: async () => ({
        executionId: "run-failed-swallowed",
        status: "running",
        outputs: null,
        billingBreakdown: [],
        totalCost: 10,
      }),
    };

    await assert.rejects(
      async () => {
        await dispatcher.executeQueuedUseCase({
          useCaseId: "image-generation-v1",
          input: {
            workflow_id: "wf-bug01-media",
            billing_hold_id: "hold-bug01-123",
            billing_status: "reserved",
            reserved_credits: 10,
          },
          userId: "user-victim-123",
          billingHoldId: "hold-bug01-123",
        });
      },
      /(did not complete|WORKFLOW_INCOMPLETE|failed)/i
    );

    assert.strictEqual(settledCalls.length, 0, "settleHold must NEVER be called when run did not complete!");
    assert.strictEqual(rollbackCalls.length, 1, "releaseHold MUST be called to release held credits!");
    assert.strictEqual(
      mediaUpdates.some((m) => m.status === "failed"),
      true,
      "Stuck placeholder media must be marked as failed!"
    );
  });

  it("TEST 3: End-to-end execution failure: hold released, media marked failed, NO settle", async () => {
    dispatcher.executor = {
      execute: async () => {
        const err = new TypeError("Cannot read properties of undefined (reading 'filter')");
        err.code = "ORCHESTRATION_ERROR";
        throw err;
      },
    };

    await assert.rejects(
      async () => {
        await dispatcher.executeQueuedUseCase({
          useCaseId: "image-generation-v1",
          input: {
            workflow_id: "wf-bug01-e2e",
            billing_hold_id: "hold-bug01-e2e",
            billing_status: "reserved",
            reserved_credits: 10,
          },
          userId: "user-audit-123",
          billingHoldId: "hold-bug01-e2e",
        });
      },
      /Cannot read properties|filter|ORCHESTRATION_ERROR/i
    );

    assert.strictEqual(settledCalls.length, 0, "No settleHold must be executed");
    assert.strictEqual(rollbackCalls.length, 1, "Hold must be released via releaseHold");
    assert.strictEqual(mediaUpdates.some((m) => m.status === "failed"), true, "Media must be marked failed");
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

  it("TEST 2: Missing wallet on paid workflow MUST fail with clear error and NEVER run for free", async () => {
    const unconfiguredGateway = new WorkflowBillingGateway({ walletService: null });

    await assert.rejects(
      async () => {
        await unconfiguredGateway.reserve({
          userId: "user-test",
          amount: 8,
          referenceId: "ref-test-unconfigured",
        });
      },
      (err) => {
        assert.strictEqual(err.code, "WALLET_NOT_CONFIGURED");
        return true;
      }
    );
  });

  it("TEST 3: NO_CHARGE is allowed ONLY for explicit finite zero (amount === 0)", async () => {
    const unconfiguredGateway = new WorkflowBillingGateway({ walletService: null });

    const zeroResult = await unconfiguredGateway.reserve({
      userId: "user-free",
      amount: 0,
      referenceId: "ref-free-explicit",
    });

    assert.strictEqual(zeroResult.kind, "NO_CHARGE", "Explicit zero amount must yield NO_CHARGE");
    assert.strictEqual(zeroResult.amount, 0);
  });

  it("TEST 4: workflowBillingGateway throws PRICING_CONFIG_ERROR for invalid amounts (undefined, null, NaN, -1, 'abc')", async () => {
    const gateway = new WorkflowBillingGateway({ walletService: null });
    const invalidAmounts = [undefined, null, NaN, -1, -5, "abc", "0", {}, []];

    for (const invalidAmount of invalidAmounts) {
      await assert.rejects(
        async () => {
          await gateway.reserve({
            userId: "user-test",
            amount: invalidAmount,
            referenceId: `ref-invalid-${String(invalidAmount)}`,
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

  it("TEST 5: WalletService.reserve throws PRICING_CONFIG_ERROR for invalid amounts (undefined, null, NaN, -1, 'abc')", async () => {
    const { WalletService } = await import("#billing/tools");
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

  it("TEST 7: pricing failure at prepare time through real controller -> placeholders failed, no hold, clean 500 with INTERNAL_ERROR + traceId", async () => {
    const wallet = new InMemoryWalletService();
    await wallet.setBalance("user-pricing-fail", 100);
    useCaseService.walletService = wallet;

    const mediaRows = new Map();
    const origDbMedia = db.media;
    const origDbProjects = db.projects;
    const origDbWorkflows = db.workflows;
    const origPrepareAndEnqueue = useCaseService.prepareAndEnqueue;

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

    useCaseService.prepareAndEnqueue = async () => {
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

      assert.strictEqual(wallet.reservations.size, 0, "No hold must be reserved in wallet on pricing failure");
    } finally {
      db.media = origDbMedia;
      db.projects = origDbProjects;
      db.workflows = origDbWorkflows;
      useCaseService.prepareAndEnqueue = origPrepareAndEnqueue;
    }
  });
});
}

// ─── Source: useCasePendingMediaZombieCleanup.test.js ───
{
describe("Sprint R2: V3Dispatcher Pending Media Zombie Cleanup", () => {
  it("when queue.addUseCaseJob throws, both the credit hold is released AND pending media rows are marked failed", async () => {
    let rollbackCalledWith = null;
    const updatedMedia = [];

    const mockQueue = {
      addUseCaseJob: async () => {
        throw new Error("Redis cluster connection lost during dispatch");
      },
    };

    const mockDb = {
      media: {
        updateMedia: async (mediaId, fields) => {
          updatedMedia.push({ mediaId, fields });
          return { id: mediaId, ...fields };
        },
      },
    };

    const service = new V3Dispatcher({
      billingTools: {
        reserveHold: async () => ({
          billingHoldId: "hold-test-123",
          billingStatus: "reserved",
          reservedCredits: 50,
        }),
        releaseHold: async ({ referenceId, metadata }) => {
          rollbackCalledWith = { holdId: referenceId, meta: metadata };
        },
      },
      mediaTools: {
        markMediaFailed: async () => {},
      },
      jobQueueService: mockQueue,
      db: mockDb,
    });

    const serverMediaIds = ["media-pending-1", "media-pending-2"];
    let caughtError = null;

    try {
      await service.prepareAndEnqueue({
        useCaseId: "image-generation-v1",
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

    assert.ok(caughtError, "prepareAndEnqueue should throw when queue dispatch fails");
    assert.equal(caughtError.code, "QUEUE_DISPATCH_FAILED");
    assert.equal(caughtError.statusCode, 503);

    assert.ok(rollbackCalledWith, "Credit hold must be released on queue dispatch failure");
    assert.equal(rollbackCalledWith.holdId, "hold-test-123");
    assert.equal(rollbackCalledWith.meta.errorCategory, "QUEUE_DISPATCH_FAILED");

    assert.equal(updatedMedia.length, 2, "All pending media rows must be marked failed");
    assert.equal(updatedMedia[0].mediaId, "media-pending-1");
    assert.equal(updatedMedia[0].fields.status, "failed");
    assert.match(updatedMedia[0].fields.error_message, /Queue dispatch failed/);
    assert.equal(updatedMedia[1].mediaId, "media-pending-2");
    assert.equal(updatedMedia[1].fields.status, "failed");
  });

  it("when standalone generation fails with workflowId = null, pending serverMediaIds are marked failed", async () => {
    let rollbackCalled = false;
    const updatedMedia = [];

    const mockDb = {
      media: {
        updateMedia: async (mediaId, fields) => {
          updatedMedia.push({ mediaId, fields });
          return { id: mediaId, ...fields };
        },
      },
    };

    const service = new V3Dispatcher({
      billingTools: {
        releaseHold: async () => {
          rollbackCalled = true;
        },
      },
      mediaTools: {
        markMediaFailed: async () => {},
      },
      db: mockDb,
    });

    service.executor = {
      execute: async () => {
        throw new Error("Provider GPU timeout during rendering");
      },
    };

    let caughtError = null;
    try {
      await service.executeQueuedUseCase({
        useCaseId: "image-generation-v1",
        input: {
          serverMediaIds: ["media-standalone-1", "media-standalone-2"],
          billing_hold_id: "hold-standalone-99",
          reserved_credits: 20,
        },
        userId: "user-2",
        billingHoldId: "hold-standalone-99",
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, "executeQueuedUseCase should re-throw execution error");
    assert.ok(rollbackCalled, "Hold must be rolled back on standalone failure");

    assert.equal(updatedMedia.length, 2, "Both standalone media rows must be marked failed");
    assert.equal(updatedMedia[0].mediaId, "media-standalone-1");
    assert.equal(updatedMedia[0].fields.status, "failed");
    assert.equal(updatedMedia[1].mediaId, "media-standalone-2");
    assert.equal(updatedMedia[1].fields.status, "failed");
  });
});
}

after(() => {
  setTimeout(() => process.exit(0), 100);
});
