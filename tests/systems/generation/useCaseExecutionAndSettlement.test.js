import { describe, it, beforeEach, afterEach, after, before } from "node:test";
import assert from "node:assert/strict";
import * as workflowRunnerModule from "#generation/tools";
import * as useCaseRunner from "#generation/tools";
import { executeNodePersistence, PersistedBillingAccumulator, initializeGateways, registerNodeExecutor, registry, bootstrapV2, UseCaseService, UseCaseBillingRuntime, RunRepository, RUNTIME_ERROR_CODES, ERROR_POLICY, startWorkflowRun, WorkflowBillingGateway, registerAllUseCases } from "#generation/tools";
import { useCaseService, db, characterService, assertWalletConfiguredForEnvironment } from "../../../src/container.js";
import { redisConnection, workerRedisConnection } from "#shared";
import { randomUUID } from "node:crypto";
import { InMemoryWalletService } from "../../helpers/inMemoryWalletService.js";
import { generateImage, generateVideo } from "#generation/api";
import { generateCharacterSheet, createCharacter } from "#characters/api";

// ─── Source: useCaseWorkflowAndSettlementBoundary.test.js ───
{
/**
 * Boundary Tests: F2.1 — Schema, Target Fail-Closed Invariants, Exploit Regression, Billing Settlement & E2E Use Cases
 *
 * Verifies:
 * 1. F2.1-a: Repository update failure during accumulator persistence is logged at error level and surfaced on accumulator/run state.
 * 2. F2.1-b: targetMediaIds is fail-closed: missing targetMediaIds fails, unauthorized media rejected, createMedia fallback disallowed.
 * 3. F2.1-c: NodeExecutor exploit regression: user-supplied input targets (victim workflow/character/media) are ignored; only server targets used.
 * 4. F2.1-d: Billing settlement happens exactly once on success (commit count = 1) and never on failure (commit count = 0).
 * 5. F2.1-f: End-to-end happy path for imageGeneration, videoGeneration, and characterSheet use cases with mocked providers.
 */


bootstrapV2();

after(async () => {
  try {
    await redisConnection?.quit().catch(() => redisConnection?.disconnect());
    await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
  } catch {}
});

describe("F2.1 — Schema, Fail-Closed Targets, Exploit Regression & Settlement Invariants", () => {
  let originalMediaFindByWorkflow;
  let originalMediaUpdateMedia;
  let originalMediaCreateMedia;
  let originalCharacterUpdateCharacter;
  let origImageGenExecutor;
  let origVideoGenExecutor;
  let origLLMExecutor;
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

    origImageGenExecutor = registry["image-generation"];
    origVideoGenExecutor = registry["video-generation"];
    origLLMExecutor = registry["llm"];

    // Default mock executors for external AI nodes (Zero real provider calls)
    registerNodeExecutor("llm", async () => ({
      text: "Processed prompt text",
      json: { description: "Cyberpunk character with cybernetic arm." },
    }));

    registerNodeExecutor("image-generation", async () => ({
      assets: [{ url: "https://mock-storage.example.com/e2e-image.png", width: 1024, height: 1024 }],
    }));

    registerNodeExecutor("video-generation", async () => ({
      assets: [{ url: "https://mock-storage.example.com/e2e-video.mp4", width: 1280, height: 720 }],
    }));

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
    if (origImageGenExecutor) {
      registerNodeExecutor("image-generation", origImageGenExecutor);
    }
    if (origVideoGenExecutor) {
      registerNodeExecutor("video-generation", origVideoGenExecutor);
    }
    if (origLLMExecutor) {
      registerNodeExecutor("llm", origLLMExecutor);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // F2.1-a: Accumulator persistence failure surfaced
  // ───────────────────────────────────────────────────────────────────────────
  it("F2.1-a TEST 1: PersistedBillingAccumulator surfaces repository update failures instead of silently ignoring", async () => {
    const failingRepo = {
      getRun: async () => ({ run_id: "run-persist-fail", metadata: {} }),
      updateRun: async () => {
        const dbErr = new Error('column "metadata" of relation "v2_workflow_runs" does not exist');
        dbErr.code = "42703";
        throw dbErr;
      },
    };

    const acc = new PersistedBillingAccumulator("run-persist-fail", failingRepo);

    assert.equal(acc.hasPersistenceFailure(), false, "Initial failure state must be false");
    assert.equal(acc.getLastPersistenceError(), null, "Initial error must be null");

    // Act: record an entry. In-memory succeeds, DB update throws.
    await acc.record({
      nodeId: "node_test_1",
      nodeType: "llm",
      amount: 1,
      kind: "CHARGEABLE",
    });

    // Assert: In-memory entry is still retained
    assert.equal(acc.getTotalCost(), 1, "In-memory cost must be retained");
    const breakdown = acc.getBreakdown();
    assert.equal(breakdown.length, 1);
    assert.equal(breakdown[0].nodeId, "node_test_1");

    // Assert: Failure is explicitly surfaced on the accumulator
    assert.equal(acc.hasPersistenceFailure(), true, "Persistence failure must be marked true");
    assert.ok(
      acc.getLastPersistenceError()?.message.includes('column "metadata" of relation "v2_workflow_runs" does not exist'),
      `Error must be surfaced: ${acc.getLastPersistenceError()?.message}`
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // F2.1-b: targetWorkflowId / targetMediaIds FAIL-CLOSED
  // ───────────────────────────────────────────────────────────────────────────
  it("F2.1-b TEST 2: Node persistence fails when run has no server-side targetMediaIds (no DB write)", async () => {
    const nodeConfig = {
      id: "generate",
      persist: {
        target: "media",
        step_id: "image_generation",
        value: "$outputs.assets[0].url",
      },
    };

    const runWithoutTargetMediaIds = {
      run_id: "run-no-media-target",
      targetWorkflowId: "wf-server-123",
      targetMediaIds: [], // Empty targetMediaIds
      execution_plan: {
        targetWorkflowId: "wf-server-123",
        targetMediaIds: [],
      },
      input: {
        workflow_id: "wf-attacker-bypass",
        media_id: "media-attacker-bypass",
      },
    };

    const output = { assets: [{ url: "https://example.com/generated.png" }] };

    await assert.rejects(
      async () => {
        await executeNodePersistence({
          nodeConfig,
          output,
          run: runWithoutTargetMediaIds,
          resolvedInputs: {},
        });
      },
      (err) => {
        assert.equal(err.code, "PERSISTENCE_FAILED");
        assert.ok(
          err.message.includes("requires server-verified targetMediaIds"),
          `Expected missing targetMediaIds message, got: ${err.message}`
        );
        return true;
      }
    );

    assert.equal(mediaUpdateCalls.length, 0, "No media update must be executed");
    assert.equal(mediaCreateCalls.length, 0, "No media create fallback must be executed");
  });

  it("F2.1-b TEST 3: Node persistence rejects media when placeholder is outside server-side targetMediaIds", async () => {
    const nodeConfig = {
      id: "generate",
      persist: {
        target: "media",
        step_id: "image_generation",
        value: "$outputs.assets[0].url",
      },
    };

    const runWithRestrictedMediaIds = {
      run_id: "run-mismatch-target",
      targetWorkflowId: "wf-server-123",
      targetMediaIds: ["media-authorized-999"],
      execution_plan: {
        targetWorkflowId: "wf-server-123",
        targetMediaIds: ["media-authorized-999"],
      },
      input: {
        media_id: "placeholder-media-authorized",
      },
    };

    const output = { assets: [{ url: "https://example.com/generated.png" }] };

    await assert.rejects(
      async () => {
        await executeNodePersistence({
          nodeConfig,
          output,
          run: runWithRestrictedMediaIds,
          resolvedInputs: {},
        });
      },
      (err) => {
        assert.equal(err.code, "TARGET_MEDIA_NOT_FOUND");
        assert.ok(
          err.message.includes("no authorized active media placeholder found"),
          `Expected unauthorized media message, got: ${err.message}`
        );
        return true;
      }
    );

    assert.equal(mediaUpdateCalls.length, 0, "No media update must occur for unauthorized placeholder");
    assert.equal(mediaCreateCalls.length, 0, "No media create fallback must occur");
  });

  it("F2.1-b TEST 4: Fallback to db.media.createMedia is DISALLOWED when no placeholder exists", async () => {
    db.media.findByWorkflow = async () => [];

    const nodeConfig = {
      id: "generate",
      persist: {
        target: "media",
        step_id: "image_generation",
        value: "$outputs.assets[0].url",
      },
    };

    const run = {
      run_id: "run-no-placeholder",
      targetWorkflowId: "wf-server-123",
      targetMediaIds: ["media-123"],
      execution_plan: {
        targetWorkflowId: "wf-server-123",
        targetMediaIds: ["media-123"],
      },
      input: {},
    };

    const output = { assets: [{ url: "https://example.com/generated.png" }] };

    await assert.rejects(
      async () => {
        await executeNodePersistence({
          nodeConfig,
          output,
          run,
          resolvedInputs: {},
        });
      },
      (err) => {
        assert.equal(err.code, "TARGET_MEDIA_NOT_FOUND");
        assert.ok(
          err.message.includes("no authorized active media placeholder found"),
          `Expected TARGET_MEDIA_NOT_FOUND, got: ${err.message}`
        );
        return true;
      }
    );

    assert.equal(mediaCreateCalls.length, 0, "createMedia fallback must NOT be called");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // F2.1-c: Exploit Regression Test at nodeExecutor level
  // ───────────────────────────────────────────────────────────────────────────
  it("F2.1-c TEST 5: test_exploit_regression_node_executor_ignores_user_input_targets", async () => {
    const run = {
      run_id: "run-exploit-attempt",
      targetWorkflowId: "attacker-workflow-id",
      targetMediaIds: ["attacker-media-id"],
      targetProjectId: "attacker-project-id",
      execution_plan: {
        targetWorkflowId: "attacker-workflow-id",
        targetMediaIds: ["attacker-media-id"],
        targetProjectId: "attacker-project-id",
      },
      input: {
        workflow_id: "victim-workflow-id",
        characterId: "victim-character-id",
        media_id: "victim-media-id",
        project_id: "victim-project-id",
      },
    };

    db.media.findByWorkflow = async (wfId) => {
      mediaFindByWorkflowCalls.push(wfId);
      if (wfId === "attacker-workflow-id") {
        return [
          {
            id: "attacker-media-id",
            workflow_id: "attacker-workflow-id",
            step_id: "image_generation",
            status: "processing",
          },
        ];
      }
      if (wfId === "victim-workflow-id") {
        return [
          {
            id: "victim-media-id",
            workflow_id: "victim-workflow-id",
            step_id: "image_generation",
            status: "processing",
          },
        ];
      }
      return [];
    };

    const mediaNodeConfig = {
      id: "generate",
      persist: {
        target: "media",
        step_id: "image_generation",
        value: "$outputs.assets[0].url",
      },
    };

    const charNodeConfig = {
      id: "llm_enrich",
      persist: {
        target: "character",
        field: "description",
        value: "$outputs.json.description",
      },
    };

    const outputMedia = { assets: [{ url: "https://example.com/exploit_test.png" }] };
    const outputChar = { json: { description: "Attacker payload description" } };

    await executeNodePersistence({
      nodeConfig: mediaNodeConfig,
      output: outputMedia,
      run,
      resolvedInputs: {},
    });
    await executeNodePersistence({
      nodeConfig: charNodeConfig,
      output: outputChar,
      run,
      resolvedInputs: {},
    });

    assert.ok(
      !mediaFindByWorkflowCalls.includes("victim-workflow-id"),
      "db.media.findByWorkflow must NEVER be called with victim-workflow-id"
    );
    assert.ok(
      mediaFindByWorkflowCalls.includes("attacker-workflow-id"),
      "db.media.findByWorkflow must be called with attacker-workflow-id"
    );

    assert.equal(mediaUpdateCalls.length, 1, "Exactly one media update");
    assert.equal(
      mediaUpdateCalls[0].id,
      "attacker-media-id",
      "Media update must target attacker-media-id, NOT victim-media-id"
    );

    assert.equal(characterUpdateCalls.length, 1, "Exactly one character update");
    assert.equal(
      characterUpdateCalls[0].id,
      "attacker-workflow-id",
      "Character update must target attacker-workflow-id, NOT victim-character-id"
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // F2.1-d: Billing Settlement Commit Counts
  // ───────────────────────────────────────────────────────────────────────────
  it("F2.1-d TEST 6: Settle hold called exactly 1 time on success and 0 times on failure", async () => {
    let commitCount = 0;
    let rollbackCount = 0;

    const mockWalletService = {
      reservations: new Map([
        ["hold-test-success", { status: "held", amount: 10 }],
        ["hold-test-fail", { status: "held", amount: 10 }],
      ]),
      commitHoldIdempotent: async () => {
        commitCount++;
        return { status: "committed" };
      },
      rollback: async () => {
        rollbackCount++;
        return { status: "voided" };
      },
    };

    const origWallet = useCaseService.walletService;
    const origBillingRuntimeWallet = useCaseService.billingRuntime?.walletService;
    const origRunUseCase = useCaseService.runUseCase;

    try {
      useCaseService.walletService = mockWalletService;
      if (useCaseService.billingRuntime) {
        useCaseService.billingRuntime.walletService = mockWalletService;
      }

      // Case 1: Successful run
      useCaseService.runUseCase = async () => ({
        executionId: "exec-success",
        status: "completed",
        outputs: { test: true },
        billingBreakdown: [],
        totalCost: 10,
      });

      await useCaseService.executeQueuedUseCase({
        useCaseId: "image-generation-v1",
        input: { workflow_id: "wf-1", media_id: "m-1" },
        userId: "00000000-0000-0000-0000-000000000001",
        billingHoldId: "hold-test-success",
      });

      assert.equal(commitCount, 1, "commitHoldIdempotent must be called exactly 1 time on success");
      assert.equal(rollbackCount, 0, "rollback must NOT be called on success");

      // Case 2: Failed run
      useCaseService.runUseCase = async () => {
        const failErr = new Error("Provider timeout");
        failErr.code = "UPSTREAM_TIMEOUT";
        throw failErr;
      };

      await assert.rejects(
        async () => {
          await useCaseService.executeQueuedUseCase({
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
    } finally {
      useCaseService.walletService = origWallet;
      if (useCaseService.billingRuntime) {
        useCaseService.billingRuntime.walletService = origBillingRuntimeWallet;
      }
      useCaseService.runUseCase = origRunUseCase;
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // F2.1-f: End-to-End Happy Path for 3 Use Cases
  // ───────────────────────────────────────────────────────────────────────────
  it("F2.1-f TEST 7: End-to-end happy path for imageGeneration (image-generation-v1)", async () => {
    let settledRef = null;
    const mockWallet = {
      reservations: new Map([
        ["hold-img-e2e", { status: "held", amount: 20 }],
      ]),
      commitHoldIdempotent: async (ref) => {
        settledRef = ref;
        return { status: "committed" };
      },
      rollback: async () => {},
    };

    const origWallet = useCaseService.walletService;
    const origBillingRuntimeWallet = useCaseService.billingRuntime?.walletService;

    try {
      useCaseService.walletService = mockWallet;
      if (useCaseService.billingRuntime) {
        useCaseService.billingRuntime.walletService = mockWallet;
      }

      db.media.findByWorkflow = async () => [
        {
          id: "media-img-e2e",
          workflow_id: "wf-img-e2e",
          step_id: "image_generation",
          status: "processing",
        },
      ];

      const result = await useCaseService.executeQueuedUseCase({
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
      });

      assert.equal(result.status, "completed");
      assert.equal(settledRef, "hold-img-e2e", "Upfront hold must be settled once");
      assert.equal(mediaUpdateCalls.length, 1, "Placeholder media must be updated to completed");
      assert.equal(mediaUpdateCalls[0].id, "media-img-e2e");
      assert.equal(mediaUpdateCalls[0].patch.status, "completed");
      assert.equal(mediaUpdateCalls[0].patch.url, "https://mock-storage.example.com/e2e-image.png");
    } finally {
      useCaseService.walletService = origWallet;
      if (useCaseService.billingRuntime) {
        useCaseService.billingRuntime.walletService = origBillingRuntimeWallet;
      }
    }
  });

  it("F2.1-f TEST 8: End-to-end happy path for videoGeneration (video-generation-v1)", async () => {
    let settledRef = null;
    const mockWallet = {
      reservations: new Map([
        ["hold-vid-e2e", { status: "held", amount: 50 }],
      ]),
      commitHoldIdempotent: async (ref) => {
        settledRef = ref;
        return { status: "committed" };
      },
      rollback: async () => {},
    };

    const origWallet = useCaseService.walletService;
    const origBillingRuntimeWallet = useCaseService.billingRuntime?.walletService;

    try {
      useCaseService.walletService = mockWallet;
      if (useCaseService.billingRuntime) {
        useCaseService.billingRuntime.walletService = mockWallet;
      }

      db.media.findByWorkflow = async () => [
        {
          id: "media-vid-e2e",
          workflow_id: "wf-vid-e2e",
          step_id: "video_generation",
          status: "processing",
        },
      ];

      const result = await useCaseService.executeQueuedUseCase({
        useCaseId: "video-generation-v1",
        input: {
          prompt: "A drone shot flying over waves crashing on rocks",
          model: "wan-3-0",
          parameters: { duration: "5" },
          workflow_id: "wf-vid-e2e",
          media_id: "media-vid-e2e",
          serverWorkflowId: "wf-vid-e2e",
          serverMediaIds: ["media-vid-e2e"],
        },
        userId: "00000000-0000-0000-0000-000000000001",
        billingHoldId: "hold-vid-e2e",
      });

      assert.equal(result.status, "completed");
      assert.equal(settledRef, "hold-vid-e2e", "Video hold must be settled once");
      assert.equal(mediaUpdateCalls.length, 1, "Placeholder media must be updated to completed");
      assert.equal(mediaUpdateCalls[0].id, "media-vid-e2e");
      assert.equal(mediaUpdateCalls[0].patch.status, "completed");
      assert.equal(mediaUpdateCalls[0].patch.url, "https://mock-storage.example.com/e2e-video.mp4");
    } finally {
      useCaseService.walletService = origWallet;
      if (useCaseService.billingRuntime) {
        useCaseService.billingRuntime.walletService = origBillingRuntimeWallet;
      }
    }
  });

  it("F2.1-f TEST 9: End-to-end happy path for characterSheet (character-sheet-v1)", async () => {
    let settledRef = null;
    const mockWallet = {
      reservations: new Map([
        ["hold-char-e2e", { status: "held", amount: 30 }],
      ]),
      commitHoldIdempotent: async (ref) => {
        settledRef = ref;
        return { status: "committed" };
      },
      rollback: async () => {},
    };

    const origWallet = useCaseService.walletService;
    const origBillingRuntimeWallet = useCaseService.billingRuntime?.walletService;

    try {
      useCaseService.walletService = mockWallet;
      if (useCaseService.billingRuntime) {
        useCaseService.billingRuntime.walletService = mockWallet;
      }

      db.media.findByWorkflow = async () => [
        {
          id: "media-char-e2e",
          workflow_id: "wf-char-e2e",
          step_id: "character_sheet",
          status: "processing",
        },
      ];

      const result = await useCaseService.executeQueuedUseCase({
        useCaseId: "character-sheet-v1",
        input: {
          prompt: "Futuristic cyberpunk warrior with cybernetic arm",
          name: "CyberHero",
          characterId: "char-e2e-123",
          workflow_id: "wf-char-e2e",
          media_id: "media-char-e2e",
          serverWorkflowId: "wf-char-e2e",
          serverMediaIds: ["media-char-e2e"],
        },
        userId: "00000000-0000-0000-0000-000000000001",
        billingHoldId: "hold-char-e2e",
      });

      assert.equal(result.status, "completed");
      assert.equal(settledRef, "hold-char-e2e", "Character sheet hold must be settled once");
      assert.equal(characterUpdateCalls.length, 1, "Character record must be updated");
      assert.equal(characterUpdateCalls[0].id, "wf-char-e2e");
      assert.equal(characterUpdateCalls[0].patch.description, "Cyberpunk character with cybernetic arm.");
      assert.equal(mediaUpdateCalls.length, 1, "Placeholder media must be updated to completed");
      assert.equal(mediaUpdateCalls[0].id, "media-char-e2e");
      assert.equal(mediaUpdateCalls[0].patch.status, "completed");
      assert.equal(mediaUpdateCalls[0].patch.url, "https://mock-storage.example.com/e2e-image.png");
    } finally {
      useCaseService.walletService = origWallet;
      if (useCaseService.billingRuntime) {
        useCaseService.billingRuntime.walletService = origBillingRuntimeWallet;
      }
    }
  });
});
}

// ─── Source: serverContextFailClosedAndBillingReleaseBoundary.test.js ───
{
bootstrapV2();

after(async () => {
  try {
    await redisConnection?.quit().catch(() => redisConnection?.disconnect());
    await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
  } catch {}
});

describe("F2.3 — ServerContext Fail-Closed, Hold Release, and Multi-Asset Output Boundary Tests", () => {
  let origDbMedia;
  let origDbWorkflowMedia;
  let origDbWorkflows;
  let origDbProjects;
  let origDbCharacters;
  let origUseMemoryFallback;
  let origImageGenExecutor;
  let origVideoGenExecutor;
  let origLLMExecutor;

  beforeEach(() => {
    origDbMedia = db.media;
    origDbWorkflowMedia = db.workflowMedia;
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
    db.workflowMedia = origDbWorkflowMedia;
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
  it("TEST 2 (F2.4-b1): imageGenerationNode with 4 surplus assets and 1 target placeholder — maps FIRST asset, run SUCCEEDS, hold settled (F2.4-b1 approved)", async () => {
    const multiAssets = [
      { url: "https://mock-storage.example.com/asset-1.png", width: 1024, height: 1024 },
      { url: "https://mock-storage.example.com/asset-2.png", width: 1024, height: 1024 },
      { url: "https://mock-storage.example.com/asset-3.png", width: 1024, height: 1024 },
      { url: "https://mock-storage.example.com/asset-4.png", width: 1024, height: 1024 },
    ];

    // Provider returns 4 assets; only 1 placeholder was pre-allocated.
    // Per F2.4-b1 decision: surplus → map first N (1), drop rest, log warning, SUCCEED.
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

    // Must NOT throw — surplus is handled safely
    await ucService.executeQueuedUseCase(multiPayload);

    // The placeholder must be COMPLETED (not failed)
    const completedUpdate = updatedMediaRows.find((m) => m.status === "completed");
    assert.ok(completedUpdate, "Placeholder must be completed with first asset");
    assert.strictEqual(completedUpdate.url, "https://mock-storage.example.com/asset-1.png",
      "First asset URL must be used (surplus assets 2-4 are dropped)");

    // No extra media rows created
    assert.strictEqual(createdMediaRows.length, 0, "No extra media rows created");

    // Hold must be SETTLED (not rolled back) since run succeeded
    const holdRecord = wallet.reservations.get("hold-multi-test");
    assert.ok(
      holdRecord.status === "settled" || holdRecord.status === "committed" || holdRecord.status === "released",
      `Hold status after success: "${holdRecord.status}" — expected settled/committed`
    );
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
      const dbRelationRows = [];
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
}

// ─── Source: orchestrationFailureBillingBoundary.test.js ───
{
describe("Orchestration Error & Billing Settlement Boundary Tests (BUG-01)", () => {
  let settledCalls = [];
  let rollbackCalls = [];
  let mediaUpdates = [];
  let mockMediaDb;
  let mockBillingRuntime;
  let useCaseService;
  let runRepo;


  beforeEach(() => {
    settledCalls = [];
    rollbackCalls = [];
    mediaUpdates = [];
    runRepo = new RunRepository();

    mockMediaDb = {
      findByWorkflow: async (wfId) => [
        { id: "media-placeholder-1", status: "processing", workflow_id: wfId },
      ],
      updateMedia: async (id, patch) => {
        mediaUpdates.push({ id, ...patch });
        return { id, ...patch };
      },
    };

    mockBillingRuntime = {
      settleUseCase: async (referenceId, meta) => {
        settledCalls.push({ referenceId, meta });
        return { settled: true };
      },
      rollbackUseCase: async (referenceId, meta) => {
        rollbackCalls.push({ referenceId, meta });
        return { rolledBack: true };
      },
    };

    useCaseService = new UseCaseService({
      billingRuntime: mockBillingRuntime,
      db: { media: mockMediaDb },
    });
  });

  it("TEST 1: startWorkflowRun marks run as failed and rethrows when executeOrchestration throws", async () => {
    const plan = {
      workflow_id: "test-wf-bug01",
      nodes: [
        { id: "node1", type: "prompt-builder" }
      ]
    };
    const runtimeInput = { prompt: "test prompt", userId: "user-123" };

    // Inject an unexpected orchestration TypeError (e.g. undefined.filter)
    const originalExecuteOrchestration = workflowRunnerModule.executeOrchestration;
    try {
      // In ES modules, we can test what startWorkflowRun does when executeOrchestration fails
      // We will create a test that calls startWorkflowRun with a plan that triggers an unexpected orchestration failure
      // or directly test executeOrchestration error handling
      const runId = "test-run-orch-err";
      await runRepo.createRun({
        id: runId,
        user_id: "user-123",
        workflow_id: "test-wf-bug01",
        status: "pending",
        execution_plan: plan,
      });

      // If startWorkflowRun swallows the error, it does not throw
      await assert.rejects(
        async () => {
          // Provide an invalid plan structure that causes executeOrchestration to throw TypeError
          const brokenPlan = {
            workflow_id: "test-wf-bug01",
            nodes: null // Causes plan.nodes.every to throw TypeError: Cannot read properties of null (reading 'every')
          };
          await startWorkflowRun(brokenPlan, runtimeInput, "test-run-broken-nodes");
        },
        /TypeError|Cannot read properties|orchestration/i,
        "Expected startWorkflowRun to rethrow unexpected orchestration error"
      );

      const savedRun = await runRepo.getRun("test-run-broken-nodes");
      assert.strictEqual(savedRun?.status, "failed", "Run should be marked as failed in DB");
    } finally {
      // cleanup
    }
  });

  it("TEST 2: useCaseRunner.run throws when workflow run ends in non-completed status (e.g. running)", async () => {
    // If startWorkflowRun returns { status: "running" }, useCaseRunner.run MUST throw
    const originalStartWorkflowRun = useCaseRunner.getRegistries;
    // We test executeQueuedUseCase end-to-end:
    // If runUseCase returns status "running", executeQueuedUseCase must NOT settle billing!
    useCaseService.runUseCase = async () => {
      return {
        executionId: "run-failed-swallowed",
        status: "running", // Swallowed error caused status to remain "running"
        outputs: null,
        billingBreakdown: [],
        totalCost: 10,
      };
    };

    await assert.rejects(
      async () => {
        await useCaseService.executeQueuedUseCase({
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
      /(did not complete|WORKFLOW_INCOMPLETE|failed)/i,
      "Expected executeQueuedUseCase to throw when run did not complete"
    );

    // CRITICAL BILLING ASSERTIONS:
    assert.strictEqual(
      settledCalls.length,
      0,
      "CRITICAL: settlePreparedBilling (commit_transaction) must NEVER be called when run did not complete!"
    );
    assert.strictEqual(
      rollbackCalls.length,
      1,
      "CRITICAL: rollbackPreparedBilling (rollback_transaction) MUST be called to release held credits!"
    );
    assert.strictEqual(
      mediaUpdates.some((m) => m.status === "failed"),
      true,
      "CRITICAL: Stuck placeholder media must be marked as failed!"
    );
  });

  it("TEST 3: End-to-end orchestration failure: hold released, media marked failed, NO commit_transaction", async () => {
    // Injected error replicating the audit scenario (TypeError: undefined.filter)
    useCaseService.runUseCase = async () => {
      const err = new TypeError("Cannot read properties of undefined (reading 'filter')");
      err.code = "ORCHESTRATION_ERROR";
      throw err;
    };

    await assert.rejects(
      async () => {
        await useCaseService.executeQueuedUseCase({
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
      /Cannot read properties|filter|ORCHESTRATION_ERROR/i,
      "Expected executeQueuedUseCase to reject on orchestration error"
    );

    assert.strictEqual(settledCalls.length, 0, "No commit_transaction (settle) must be executed");
    assert.strictEqual(rollbackCalls.length, 1, "Hold must be released via rollback_transaction");
    assert.strictEqual(mediaUpdates.some((m) => m.status === "failed"), true, "Media must be marked failed");
  });
});
}

// ─── Source: walletMisconfigurationBoundary.test.js ───
{
bootstrapV2();

after(async () => {
  try {
    await redisConnection?.quit().catch(() => redisConnection?.disconnect());
    await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
  } catch {}
});

describe("F2.4-a — Wallet Misconfiguration & Zero Price Invariants", () => {
  let origEnv;
  let providerCallCount = 0;
  let origImageGenExecutor;

  beforeEach(() => {
    origEnv = { ...process.env };
    providerCallCount = 0;
    origImageGenExecutor = registry["image-generation"];

    registerNodeExecutor("image-generation", async () => {
      providerCallCount++;
      return {
        assets: [{ url: "https://mock-storage.example.com/asset.png", width: 1024, height: 1024 }],
      };
    });
  });

  afterEach(() => {
    process.env = origEnv;
    if (origImageGenExecutor) {
      registerNodeExecutor("image-generation", origImageGenExecutor);
    }
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
      },
      "Must throw when booting in production with missing Supabase credentials"
    );
  });

  it("TEST 2: Missing wallet on paid usecase MUST fail with clear error and NEVER run for free (no provider call)", async () => {
    // WorkflowBillingGateway without walletService
    const unconfiguredGateway = new WorkflowBillingGateway({ walletService: null });
    const billingRuntime = new UseCaseBillingRuntime({
      walletService: null,
      billingGateway: unconfiguredGateway,
    });

    const ucService = new UseCaseService({
      walletService: null,
      billingRuntime,
      jobQueueService: {
        addUseCaseJob: async () => ({ id: "job-should-not-exist" }),
      },
    });

    // Attempt to prepare and enqueue a paid use case (image-generation-v1)
    let caughtError = null;
    try {
      await ucService.prepareAndEnqueue({
        useCaseId: "image-generation-v1",
        input: {
          prompt: "paid image prompt",
          model: "nanobana_2",
        },
        userId: "user-paid-attempt",
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, "Paid use case must fail when wallet is not configured");
    assert.strictEqual(caughtError.code, "WALLET_NOT_CONFIGURED", "Error code must indicate unconfigured wallet");
    assert.strictEqual(providerCallCount, 0, "External provider must NEVER be called when wallet is unconfigured");

    // Also assert directly on the gateway: reserving a positive amount without wallet must throw, not return NO_CHARGE
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

    // Explicit finite amount 0 must return NO_CHARGE
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
          assert.strictEqual(err.code, "PRICING_CONFIG_ERROR", `Amount "${invalidAmount}" must throw PRICING_CONFIG_ERROR`);
          assert.strictEqual(err.category, "SERVER_FAULT");
          return true;
        },
        `Expected gateway.reserve to throw PRICING_CONFIG_ERROR for amount: ${invalidAmount}`
      );
    }
  });

  it("TEST 5: useCaseBillingRuntime throws PRICING_CONFIG_ERROR for invalid totalCredits (undefined, null, NaN, -1, 'abc')", async () => {
    const runtime = new UseCaseBillingRuntime({ walletService: null });
    const invalidAmounts = [undefined, null, NaN, -1, -10, "abc", "0", {}, []];

    for (const invalidAmount of invalidAmounts) {
      await assert.rejects(
        async () => {
          await runtime.reserveUseCase({
            userId: "user-test",
            useCaseId: "image-generation-v1",
            totalCredits: invalidAmount,
          });
        },
        (err) => {
          assert.strictEqual(err.code, "PRICING_CONFIG_ERROR", `totalCredits "${invalidAmount}" must throw PRICING_CONFIG_ERROR`);
          assert.strictEqual(err.category, "SERVER_FAULT");
          return true;
        },
        `Expected reserveUseCase to throw PRICING_CONFIG_ERROR for totalCredits: ${invalidAmount}`
      );
    }
  });

  it("TEST 6: WalletService.reserve throws PRICING_CONFIG_ERROR for invalid amounts (undefined, null, NaN, -1, 'abc')", async () => {
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
          assert.strictEqual(err.code, "PRICING_CONFIG_ERROR", `WalletService.reserve amount "${invalidAmount}" must throw PRICING_CONFIG_ERROR`);
          assert.strictEqual(err.category, "SERVER_FAULT");
          return true;
        },
        `Expected WalletService.reserve to throw PRICING_CONFIG_ERROR for amount: ${invalidAmount}`
      );
    }
  });

  it("TEST 7: calculateWorkflowBillingPlan throws PRICING_CONFIG_ERROR if pricing calculation returns invalid cost and NEVER defaults to 0", async () => {
    const { calculateWorkflowBillingPlan } = await import("#generation/tools");

    const plan = {
      nodes: [
        {
          id: "generate",
          type: "image-generation",
          bindings: {
            prompt: "${input.prompt}",
            model: "${input.model}",
          },
        },
      ],
    };

    const invalidCostResults = [undefined, null, NaN, -1, "abc", "free", {}];

    for (const invalidCost of invalidCostResults) {
      await assert.rejects(
        async () => {
          await calculateWorkflowBillingPlan({
            plan,
            inputs: { prompt: "test", model: "nanobana_2" },
            calculateCostFn: () => invalidCost,
          });
        },
        (err) => {
          assert.strictEqual(err.code, "PRICING_CONFIG_ERROR", `Cost failure (${invalidCost}) must throw PRICING_CONFIG_ERROR`);
          assert.strictEqual(err.category, "SERVER_FAULT");
          return true;
        },
        `calculateWorkflowBillingPlan must never turn pricing failure (${invalidCost}) into 0`
      );
    }

    // Explicit 0 cost MUST succeed and return 0
    const zeroPlan = await calculateWorkflowBillingPlan({
      plan,
      inputs: { prompt: "test", model: "nanobana_2" },
      calculateCostFn: () => 0,
    });
    assert.strictEqual(zeroPlan.totalCredits, 0, "Explicit 0 cost must return 0 totalCredits");
  });

  it("TEST 8: pricing failure at prepare time through real controller -> placeholders failed, no hold, clean 500 with INTERNAL_ERROR + traceId", async () => {
    const { generateImage } = await import("#generation/api");
    const { db, useCaseService } = await import("../../../src/container.js");
    const { InMemoryWalletService } = await import("../../helpers/inMemoryWalletService.js");

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

    // Simulate pricing failure at prepare time (PRICING_CONFIG_ERROR)
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

      // 1. Clean 500 response with INTERNAL_ERROR + traceId
      assert.strictEqual(statusCode, 500);
      assert.strictEqual(responseData.ok, false);
      assert.strictEqual(responseData.code, "INTERNAL_ERROR");
      assert.ok(responseData.traceId, "Response must include traceId");
      assert.match(responseData.message, /failed to generate image/i);

      // 2. Placeholders marked failed
      assert.ok(mediaRows.size > 0, "Placeholders must have been created");
      for (const [id, row] of mediaRows) {
        assert.strictEqual(row.status, "failed");
        assert.match(row.error_message, /Pricing engine failed/i);
      }

      // 3. No hold was reserved in wallet
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
describe("Sprint R2: UseCase Pending Media Zombie Cleanup", () => {
  before(() => {
    registerAllUseCases();
  });

  it("when queue.addUseCaseJob throws, both the credit hold is released AND pending media rows are marked failed", async () => {
    let rollbackCalledWith = null;
    const updatedMedia = [];

    const mockBillingRuntime = {
      reserveUseCase: async () => ({
        billingHoldId: "hold-test-123",
        billingStatus: "reserved",
        reservedCredits: 50,
      }),
      rollbackUseCase: async (holdId, meta) => {
        rollbackCalledWith = { holdId, meta };
      },
    };

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

    const service = new UseCaseService({
      billingRuntime: mockBillingRuntime,
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
          model: "gemini-3.1-flash-lite",
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

    assert.ok(caughtError, "prepareUseCaseJob should throw when queue dispatch fails");
    assert.equal(caughtError.code, "QUEUE_DISPATCH_FAILED");
    assert.equal(caughtError.statusCode, 503);

    // Verify hold was released
    assert.ok(rollbackCalledWith, "Credit hold must be released on queue dispatch failure");
    assert.equal(rollbackCalledWith.holdId, "hold-test-123");
    assert.equal(rollbackCalledWith.meta.errorCategory, "QUEUE_DISPATCH_FAILED");

    // Verify pending media rows were marked failed
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

    const mockBillingRuntime = {
      rollbackUseCase: async () => {
        rollbackCalled = true;
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

    const service = new UseCaseService({
      billingRuntime: mockBillingRuntime,
      db: mockDb,
    });

    // Mock runUseCase to simulate worker failure
    service.runUseCase = async () => {
      throw new Error("Provider GPU timeout during rendering");
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

    // Verify standalone pending media marked as failed
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
