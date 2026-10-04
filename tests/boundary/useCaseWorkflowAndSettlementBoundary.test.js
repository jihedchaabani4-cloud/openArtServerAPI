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

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { executeNodePersistence } from "../../src/v2/runner/nodeExecutor.js";
import {
  PersistedBillingAccumulator,
  initializeGateways,
} from "../../src/v2/runner/workflowRunner.js";
import { registerNodeExecutor, registry } from "../../src/v2/nodes/index.js";
import { useCaseService, db } from "../../src/container.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { bootstrapV2 } from "../../src/v2/bootstrap.js";

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
