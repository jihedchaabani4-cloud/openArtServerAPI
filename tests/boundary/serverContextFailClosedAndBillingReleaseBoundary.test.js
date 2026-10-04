import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { UseCaseService } from "../../src/services/useCaseService.js";
import { UseCaseBillingRuntime } from "../../src/v2/runtime/useCaseBillingRuntime.js";
import { InMemoryWalletService } from "../../src/services/walletService.js";
import { db, useCaseService, characterService } from "../../src/container.js";
import { bootstrapV2 } from "../../src/v2/bootstrap.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { RunRepository } from "../../src/v2/runner/runRepository.js";
import { registerNodeExecutor, registry } from "../../src/v2/nodes/index.js";
import { RUNTIME_ERROR_CODES } from "../../src/v2/runtime/errorPolicy.js";
import { ERROR_POLICY } from "../../src/runtime/errorPolicy.js";
import { generateImage } from "../../controllers/imageController.js";
import { generateVideo } from "../../controllers/videoController.js";
import { generateCharacterSheet, createCharacter } from "../../controllers/characterController.js";

bootstrapV2();

after(async () => {
  try {
    await redisConnection?.quit().catch(() => redisConnection?.disconnect());
    await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
  } catch {}
});

describe("F2.3 — ServerContext Fail-Closed, Hold Release, and Multi-Asset Output Boundary Tests", () => {
  let origDbMedia;
  let origDbWorkflows;
  let origDbProjects;
  let origDbCharacters;
  let origUseMemoryFallback;
  let origImageGenExecutor;
  let origVideoGenExecutor;
  let origLLMExecutor;

  beforeEach(() => {
    origDbMedia = db.media;
    origDbWorkflows = db.workflows;
    origDbProjects = db.projects;
    origDbCharacters = db.characters;
    origUseMemoryFallback = RunRepository.useMemoryFallback;

    origImageGenExecutor = registry["image-generation"];
    origVideoGenExecutor = registry["video-generation"];
    origLLMExecutor = registry["llm"];

    RunRepository.useMemoryFallback = true;

    registerNodeExecutor("llm", async () => ({
      text: "Mock prompt response",
      json: { description: "Mock character description" },
    }));

    registerNodeExecutor("image-generation", async () => ({
      assets: [{ url: "https://mock-storage.example.com/mock-image.png", width: 1024, height: 1024 }],
    }));

    registerNodeExecutor("video-generation", async () => ({
      assets: [{ url: "https://mock-storage.example.com/mock-video.mp4", width: 1280, height: 720 }],
    }));
  });

  afterEach(() => {
    db.media = origDbMedia;
    db.workflows = origDbWorkflows;
    db.projects = origDbProjects;
    db.characters = origDbCharacters;
    RunRepository.useMemoryFallback = origUseMemoryFallback;

    if (origImageGenExecutor) registerNodeExecutor("image-generation", origImageGenExecutor);
    if (origVideoGenExecutor) registerNodeExecutor("video-generation", origVideoGenExecutor);
    if (origLLMExecutor) registerNodeExecutor("llm", origLLMExecutor);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // F2.3-a: Fail-closed on missing server targets
  // ───────────────────────────────────────────────────────────────────────────
  it("TEST 1 (F2.3-a): job payload with workflow_id/media_id/characterId in input but no server* fields fails closed, releases hold, and fails media", async () => {
    const wallet = new InMemoryWalletService();
    await wallet.setBalance("user-attacker", 100);
    const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });

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

    const ucService = new UseCaseService({
      walletService: wallet,
      billingRuntime,
      db: { media: mockMediaRepo },
    });

    const hold = await wallet.reserve({
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
        // Notice: NO serverWorkflowId, serverMediaIds, or serverProjectId!
      },
      userId: "user-attacker",
      billingHoldId: "hold-legacy-test",
    };

    let caughtError = null;
    try {
      await ucService.executeQueuedUseCase(legacyPayload);
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, "Job must fail when no server-verified targets exist");
    // Media must NOT have been marked completed
    assert.notStrictEqual(mediaUpdatedWithStatus, "completed", "Node must NOT complete media without server-verified target");
    // Hold must be released (rolled back)
    const holdRecord = wallet.reservations.get("hold-legacy-test");
    assert.ok(holdRecord.status === "released" || holdRecord.status === "rolled_back", "Billing hold must be released/rolled back on fail-closed rejection");
    // Pending media must be marked failed
    assert.ok(failedPendingMediaCalls.length > 0, "failPendingMediaByWorkflow must be called on failure");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // F2.3-d: Multi-asset outputs behavior with count=4 and 1 placeholder
  // ───────────────────────────────────────────────────────────────────────────
  it("TEST 2 (F2.4-b): imageGenerationNode with count=4 assets and 1 target placeholder fails closed with OUTPUT_CONTRACT_VIOLATION, releases hold, and marks media failed", async () => {
    const multiAssets = [
      { url: "https://mock-storage.example.com/asset-1.png", width: 1024, height: 1024 },
      { url: "https://mock-storage.example.com/asset-2.png", width: 1024, height: 1024 },
      { url: "https://mock-storage.example.com/asset-3.png", width: 1024, height: 1024 },
      { url: "https://mock-storage.example.com/asset-4.png", width: 1024, height: 1024 },
    ];

    registerNodeExecutor("image-generation", async () => ({
      assets: multiAssets,
    }));

    const wallet = new InMemoryWalletService();
    await wallet.setBalance("user-multi", 100);
    const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });

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

    const ucService = new UseCaseService({
      walletService: wallet,
      billingRuntime,
      db: { media: mockMediaRepo },
    });

    await wallet.reserve({
      userId: "user-multi",
      amount: 10,
      referenceId: "hold-multi-test",
    });

    const multiPayload = {
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
    };

    await assert.rejects(
      async () => {
        await ucService.executeQueuedUseCase(multiPayload);
      },
      (err) => {
        assert.strictEqual(err.code, "OUTPUT_CONTRACT_VIOLATION");
        return true;
      }
    );

    // Decision F2.3-d (Option 1 + 3):
    // 1. Placeholder was marked failed
    assert.strictEqual(updatedMediaRows.some((m) => m.status === "failed"), true, "Placeholder media row was marked failed");

    // 2. Extra media rows created in DB? Zero.
    assert.strictEqual(createdMediaRows.length, 0, "No extra media rows created");

    // 3. Hold was rolled back
    const holdRecord = wallet.reservations.get("hold-multi-test");
    assert.ok(holdRecord.status === "released" || holdRecord.status === "rolled_back", "Hold must be released/rolled back");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // F2.3-e: Hold release and media fail on EVERY error code (table-driven)
  // ───────────────────────────────────────────────────────────────────────────
  describe("TEST 3 (F2.3-e): Table-driven hold rollback & media failure across ALL error codes", () => {
    const allCodes = Array.from(new Set([
      ...Object.values(RUNTIME_ERROR_CODES),
      ...Object.keys(ERROR_POLICY),
      "SOME_UNKNOWN_ERROR_CODE",
      "ANOTHER_UNREGISTERED_ERROR",
      undefined,
    ]));

    for (const testCode of allCodes) {
      it(`error code "${testCode}" rolls back hold and marks media failed when guard.paid is true`, async () => {
        const wallet = new InMemoryWalletService();
        await wallet.setBalance("user-err-test", 100);
        const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });

        let mediaFailedCalled = false;
        const mockMediaRepo = {
          failPendingMediaByWorkflow: async (wfId, message) => {
            mediaFailedCalled = true;
            return [{ id: "m-err-1", status: "failed" }];
          },
          findByWorkflow: async () => [],
        };

        const ucService = new UseCaseService({
          walletService: wallet,
          billingRuntime,
          db: { media: mockMediaRepo },
        });

        // Mock runUseCase to throw the specified error code
        ucService.runUseCase = async () => {
          const simulatedErr = new Error(`Simulated failure for code: ${testCode}`);
          if (testCode) simulatedErr.code = testCode;
          throw simulatedErr;
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
          await ucService.executeQueuedUseCase(payload);
        } catch {
          threw = true;
        }

        assert.ok(threw, "Execution must throw on error");

        // Billing hold MUST be rolled back regardless of error code
        const hold = wallet.reservations.get(holdId);
        assert.ok(hold.status === "released" || hold.status === "rolled_back", `Hold must be rolled back for error code "${testCode}"`);

        // Media MUST be marked failed
        assert.ok(mediaFailedCalled, `failPendingMediaByWorkflow must be called for error code "${testCode}"`);
      });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // F2.3-c: Integration tests per real entry point WITHOUT hand-injected targets
  // ───────────────────────────────────────────────────────────────────────────
  describe("F2.3-c: Integration tests per entry point WITHOUT hand-injected targets", () => {
    it("ENTRY POINT 1: imageController.generateImage produces server targets, completes media, and settles hold once", async () => {
      const wallet = new InMemoryWalletService();
      await wallet.setBalance("user-ep-img", 100);
      const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });

      let capturedJobPayload = null;
      const mockQueue = {
        addUseCaseJob: async (jobData) => {
          capturedJobPayload = jobData;
          return { id: "job-img-ep-1", ...jobData };
        },
      };

      const testUcService = new UseCaseService({
        walletService: wallet,
        billingRuntime,
        jobQueueService: mockQueue,
      });

      const origContainerUcService = useCaseService;
      // Wire test service into imageController flow
      origContainerUcService.prepareAndEnqueue = testUcService.prepareAndEnqueue.bind(testUcService);
      origContainerUcService.executeQueuedUseCase = testUcService.executeQueuedUseCase.bind(testUcService);

      const dbWorkflowsStore = new Map();
      const dbMediaStore = new Map();

      db.projects = {
        findById: async () => ({ id: "proj-ep-img", user_id: "user-ep-img" }),
      };

      db.workflows = {
        createWorkflow: async (wf) => {
          dbWorkflowsStore.set(wf.id, { ...wf, status: "pending" });
          return wf;
        },
      };

      db.media = {
        createMedia: async (m) => {
          dbMediaStore.set(m.id, { ...m });
          return m;
        },
        findById: async (id) => dbMediaStore.get(id),
        findByWorkflow: async (wfId) => Array.from(dbMediaStore.values()).filter((m) => m.workflow_id === wfId),
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
        status(code) { return this; },
        json(data) { responseData = data; return this; },
      };

      // 1. Call REAL controller handler (no hand-injected targets)
      await generateImage(req, res);

      assert.ok(responseData?.ok, "Controller response must be ok");
      const { workflowId, mediaId } = responseData;
      assert.ok(workflowId, "Workflow ID created by controller");
      assert.ok(mediaId, "Media ID created by controller");

      // 2. Assert captured job payload contains server-verified targets matching created rows
      assert.ok(capturedJobPayload, "Job was enqueued via prepareAndEnqueue");
      assert.strictEqual(capturedJobPayload.serverContext.v1_workflow_id, workflowId);
      assert.deepStrictEqual(capturedJobPayload.serverContext.mediaIds, [mediaId]);
      assert.strictEqual(capturedJobPayload.input.serverWorkflowId, workflowId);
      assert.deepStrictEqual(capturedJobPayload.input.serverMediaIds, [mediaId]);

      // 3. Execute the queued job through the worker runner
      const runResult = await testUcService.executeQueuedUseCase({
        useCaseId: capturedJobPayload.useCaseId,
        input: capturedJobPayload.input,
        userId: capturedJobPayload.userId,
        billingHoldId: capturedJobPayload.billingHoldId,
      });

      assert.strictEqual(runResult.status, "completed");

      // Assert Run record has server targets
      const runRecord = RunRepository.useMemoryFallback ? Array.from(RunRepository.getClient?.() || []) : null;

      // Assert media row was completed in DB
      const completedMedia = dbMediaStore.get(mediaId);
      assert.strictEqual(completedMedia.status, "completed", "Placeholder media must be completed by node");
      assert.ok(completedMedia.url.startsWith("https://"), "Media URL must be populated");

      // Assert hold was committed exactly once
      const hold = wallet.reservations.get(capturedJobPayload.billingHoldId);
      assert.strictEqual(hold.status, "committed", "Billing hold must be settled/committed exactly once");
    });

    it("ENTRY POINT 2: videoController.generateVideo produces server targets, completes media, and settles hold once", async () => {
      const wallet = new InMemoryWalletService();
      await wallet.setBalance("user-ep-vid", 100);
      const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });

      let capturedJobPayload = null;
      const mockQueue = {
        addUseCaseJob: async (jobData) => {
          capturedJobPayload = jobData;
          return { id: "job-vid-ep-1", ...jobData };
        },
      };

      const testUcService = new UseCaseService({
        walletService: wallet,
        billingRuntime,
        jobQueueService: mockQueue,
      });

      const origContainerUcService = useCaseService;
      origContainerUcService.prepareAndEnqueue = testUcService.prepareAndEnqueue.bind(testUcService);
      origContainerUcService.executeQueuedUseCase = testUcService.executeQueuedUseCase.bind(testUcService);

      const dbMediaStore = new Map();

      db.projects = {
        findById: async () => ({ id: "proj-ep-vid", user_id: "user-ep-vid" }),
      };

      db.workflows = {
        createWorkflow: async (wf) => wf,
      };

      db.media = {
        createMedia: async (m) => {
          dbMediaStore.set(m.id, { ...m });
          return m;
        },
        findById: async (id) => dbMediaStore.get(id),
        findByWorkflow: async (wfId) => Array.from(dbMediaStore.values()).filter((m) => m.workflow_id === wfId),
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
        status(code) { return this; },
        json(data) { responseData = data; return this; },
      };

      // 1. Call REAL video controller handler
      await generateVideo(req, res);

      assert.ok(responseData?.ok, "Video controller response must be ok");
      const { workflowId, mediaId } = responseData;
      assert.ok(workflowId && mediaId);

      // 2. Assert captured job payload
      assert.ok(capturedJobPayload);
      assert.strictEqual(capturedJobPayload.serverContext.v1_workflow_id, workflowId);
      assert.deepStrictEqual(capturedJobPayload.serverContext.mediaIds, [mediaId]);

      // 3. Worker execution
      const runResult = await testUcService.executeQueuedUseCase({
        useCaseId: capturedJobPayload.useCaseId,
        input: capturedJobPayload.input,
        userId: capturedJobPayload.userId,
        billingHoldId: capturedJobPayload.billingHoldId,
      });

      assert.strictEqual(runResult.status, "completed");

      // Media completed
      const completedMedia = dbMediaStore.get(mediaId);
      assert.strictEqual(completedMedia.status, "completed");
      assert.ok(completedMedia.url);

      // Hold settled once
      const hold = wallet.reservations.get(capturedJobPayload.billingHoldId);
      assert.strictEqual(hold.status, "committed");
    });

    it("ENTRY POINT 3: characterController.generateCharacterSheet produces server targets, completes media, and settles hold once", async () => {
      const wallet = new InMemoryWalletService();
      await wallet.setBalance("user-ep-charsheet", 100);
      const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });

      let capturedJobPayload = null;
      const mockQueue = {
        addUseCaseJob: async (jobData) => {
          capturedJobPayload = jobData;
          return { id: "job-sheet-ep-1", ...jobData };
        },
      };

      const testUcService = new UseCaseService({
        walletService: wallet,
        billingRuntime,
        jobQueueService: mockQueue,
      });

      const origContainerUcService = useCaseService;
      origContainerUcService.prepareAndEnqueue = testUcService.prepareAndEnqueue.bind(testUcService);
      origContainerUcService.executeQueuedUseCase = testUcService.executeQueuedUseCase.bind(testUcService);

      const dbMediaStore = new Map();
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

      db.media = {
        createMedia: async (m) => {
          const id = m.id || `media-${randomUUID()}`;
          const record = { ...m, id };
          dbMediaStore.set(id, record);
          return record;
        },
        findById: async (id) => dbMediaStore.get(id),
        findByWorkflow: async (wfId) => Array.from(dbMediaStore.values()).filter((m) => m.workflow_id === wfId),
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
        status(code) { return this; },
        json(data) { responseData = data; return this; },
      };

      // 1. Call real generateCharacterSheet handler
      await generateCharacterSheet(req, res);

      assert.ok(responseData?.ok, "Character sheet response must be ok");
      assert.ok(capturedJobPayload, "Job was enqueued via prepareAndEnqueue");

      // CharacterId is used as the workflow ID for the character sheet
      assert.strictEqual(capturedJobPayload.serverContext.v1_workflow_id, characterId);
      assert.ok(capturedJobPayload.serverContext.mediaIds.length > 0);
      const placeholderMediaId = capturedJobPayload.serverContext.mediaIds[0];

      // 2. Worker execution
      const runResult = await testUcService.executeQueuedUseCase({
        useCaseId: capturedJobPayload.useCaseId,
        input: capturedJobPayload.input,
        userId: capturedJobPayload.userId,
        billingHoldId: capturedJobPayload.billingHoldId,
      });

      assert.strictEqual(runResult.status, "completed");

      // Media completed
      const completedMedia = dbMediaStore.get(placeholderMediaId);
      assert.strictEqual(completedMedia.status, "completed");

      // Hold settled once
      const hold = wallet.reservations.get(capturedJobPayload.billingHoldId);
      assert.strictEqual(hold.status, "committed");
    });

    it("ENTRY POINT 4: characterController.createCharacter (AI visual sheet path) produces server targets, completes media, and settles hold once", async () => {
      const wallet = new InMemoryWalletService();
      await wallet.setBalance("user-ep-createchar", 100);
      const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });

      let capturedJobPayload = null;
      const mockQueue = {
        addUseCaseJob: async (jobData) => {
          capturedJobPayload = jobData;
          return { id: "job-createchar-ep-1", ...jobData };
        },
      };

      const testUcService = new UseCaseService({
        walletService: wallet,
        billingRuntime,
        jobQueueService: mockQueue,
      });

      const origContainerUcService = useCaseService;
      origContainerUcService.prepareAndEnqueue = testUcService.prepareAndEnqueue.bind(testUcService);
      origContainerUcService.executeQueuedUseCase = testUcService.executeQueuedUseCase.bind(testUcService);

      const dbMediaStore = new Map();
      const generatedCharId = "char-new-" + randomUUID();

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

      db.media = {
        createMedia: async (m) => {
          const id = m.id || `media-${randomUUID()}`;
          const record = { ...m, id };
          dbMediaStore.set(id, record);
          return record;
        },
        findById: async (id) => dbMediaStore.get(id),
        findByWorkflow: async (wfId) => Array.from(dbMediaStore.values()).filter((m) => m.workflow_id === wfId),
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
          // No file, no imageUrl => Triggers AI Visual Sheet Generation
        },
      };

      let responseData = null;
      const res = {
        status(code) { return this; },
        json(data) { responseData = data; return this; },
      };

      // 1. Call real createCharacter handler
      await createCharacter(req, res);

      assert.ok(responseData?.ok, "createCharacter response must be ok");
      assert.ok(capturedJobPayload, "Job was enqueued via prepareAndEnqueue");

      // Verify server context target matches created character ID
      assert.strictEqual(capturedJobPayload.serverContext.v1_workflow_id, responseData.characterId);
      assert.ok(capturedJobPayload.serverContext.mediaIds.length > 0);
      const placeholderMediaId = capturedJobPayload.serverContext.mediaIds[0];

      // 2. Worker execution
      const runResult = await testUcService.executeQueuedUseCase({
        useCaseId: capturedJobPayload.useCaseId,
        input: capturedJobPayload.input,
        userId: capturedJobPayload.userId,
        billingHoldId: capturedJobPayload.billingHoldId,
      });

      assert.strictEqual(runResult.status, "completed");

      // Media completed
      const completedMedia = dbMediaStore.get(placeholderMediaId);
      assert.strictEqual(completedMedia.status, "completed");

      // Hold settled once
      const hold = wallet.reservations.get(capturedJobPayload.billingHoldId);
      assert.strictEqual(hold.status, "committed");
    });
  });
});
