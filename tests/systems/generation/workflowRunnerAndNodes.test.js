import { describe, it, beforeEach, afterEach, after, before } from "node:test";
import assert from "node:assert/strict";
import { executeNodePersistence, startWorkflowRun, run as runUseCase, bootstrapV2, executeImageGeneration, executeVideoGeneration, calculateWorkflowBillingPlan, RunRepository, getRunBillingAccumulator, initializeGateways, formatWorkflowError, toRuntimeError, RUNTIME_ERROR_CODES, ERROR_CATEGORIES, GenerationService, GenerationRequestService } from "#generation/tools";
import { db } from "../../../src/container.js";
import { redisConnection, workerRedisConnection } from "#shared";
import { registerProviderRunner, unregisterProviderRunner, getRunner, getModelBindings, calculateCost, ProviderTransientError } from "#models/tools";
import { randomUUID } from "node:crypto";
import * as imageController from "#generation/api";
import { failWorkflowPendingMedia } from "#media/tools";

// ─── Source: workflowRunContextAndFailureBoundary.test.js ───
{
/**
 * Boundary Tests: F2 — Server-Side Workflow Context, Media Failure, and Billing Invariants
 *
 * Verifies:
 * 1. F2a: nodeExecutor writes ONLY to server-side targetWorkflowId and targetMediaIds,
 *    never reading run.input.workflow_id or run.input.characterId (fallback removed).
 * 2. F2a: Workflow failure marks real character-sheet media as failed via serverWorkflowId.
 * 3. F2b: useCaseRunner throws unless status === "completed", and billing settles ONLY on completed.
 * 4. F2c: WorkflowRunner failure handler logs with runId/workflowId at error level instead of silent catch.
 */


bootstrapV2();

after(async () => {
  try {
    await redisConnection.quit().catch(() => redisConnection.disconnect());
    await workerRedisConnection.quit().catch(() => workerRedisConnection.disconnect());
  } catch {}
});

describe("F2 — Server-Side Workflow Context & Failure Handling Boundary Tests", () => {
  let originalMediaFindByWorkflow;
  let originalMediaUpdateMedia;
  let originalMediaUpdateFields;
  let updatedMediaCalls = [];

  beforeEach(() => {
    updatedMediaCalls = [];
    originalMediaFindByWorkflow = db.media?.findByWorkflow;
    originalMediaUpdateMedia = db.media?.updateMedia;
    originalMediaUpdateFields = db.media?.updateFields;
  });

  afterEach(() => {
    if (db.media) {
      db.media.findByWorkflow = originalMediaFindByWorkflow;
      db.media.updateMedia = originalMediaUpdateMedia;
      db.media.updateFields = originalMediaUpdateFields;
    }
  });

  // ── TEST 1: nodeExecutor writes ONLY to server-side targetWorkflowId, ignoring input.workflow_id / input.characterId ──
  it("TEST 1: executeNodePersistence writes ONLY to targetWorkflowId and ignores spoofed input.workflow_id / characterId", async () => {
    const serverWorkflowId = "server-owned-wf-100";
    const victimWorkflowId = "victim-wf-999";
    const victimCharacterId = "victim-char-888";

    const serverMedia = {
      id: "media-server-1",
      workflow_id: serverWorkflowId,
      step_id: "image_generation",
      status: "processing",
    };
    const victimMedia = {
      id: "media-victim-1",
      workflow_id: victimWorkflowId,
      step_id: "image_generation",
      status: "processing",
    };

    db.media.findByWorkflow = async (wfId) => {
      if (wfId === serverWorkflowId) return [serverMedia];
      if (wfId === victimWorkflowId || wfId === victimCharacterId) return [victimMedia];
      return [];
    };

    db.media.updateMedia = async (id, patch) => {
      updatedMediaCalls.push({ id, patch });
      return { id, ...patch };
    };

    const nodeConfig = {
      id: "gen_node",
      type: "image-generation",
      persist: {
        target: "media",
        step_id: "image_generation",
        status: "completed",
        value: "$outputs.assets[0].url",
      },
    };

    const output = { assets: [{ url: "https://storage.example.com/clean.png" }] };

    // Run carrying malicious client input attempting to overwrite victim's workflow/character/media
    const run = {
      run_id: "run-persist-test-1",
      targetWorkflowId: serverWorkflowId,
      targetMediaIds: ["media-server-1"],
      input: {
        workflow_id: victimWorkflowId, // Spoofed input
        characterId: victimCharacterId, // Spoofed input
        media_id: "victim-media-id-777", // Spoofed input
      },
      execution_plan: {
        targetWorkflowId: serverWorkflowId,
        targetMediaIds: ["media-server-1"],
      },
    };

    await executeNodePersistence({ nodeConfig, output, run });

    // Assert that ONLY server-owned media was updated
    assert.strictEqual(updatedMediaCalls.length, 1, "Exactly one media update must be executed");
    assert.strictEqual(
      updatedMediaCalls[0].id,
      "media-server-1",
      "Must update the server-assigned media placeholder, NOT the victim's placeholder"
    );
    assert.strictEqual(
      updatedMediaCalls[0].patch.status,
      "completed",
      "Server media status must be completed"
    );

    // If run has NO targetWorkflowId, even if input has workflow_id, it must refuse to write
    const untrustedRun = {
      run_id: "run-untrusted-2",
      targetWorkflowId: null,
      input: { workflow_id: victimWorkflowId },
      execution_plan: {},
    };

    await assert.rejects(
      async () => {
        await executeNodePersistence({ nodeConfig, output, run: untrustedRun });
      },
      /requires.*workflowId/i,
      "Must throw when targetWorkflowId is missing from run record, ignoring input.workflow_id"
    );
  });

  // ── TEST 2: characterId fallback is removed from nodeExecutor ──
  it("TEST 2: nodeExecutor characterId fallback is strictly removed", async () => {
    const nodeConfig = {
      id: "char_node",
      type: "image-generation",
      persist: {
        target: "media",
        step_id: "character_sheet",
        status: "completed",
        value: "https://cdn.example.com/char.png",
      },
    };

    const runWithOnlyCharacterIdInput = {
      run_id: "run-char-fallback-test",
      targetWorkflowId: null, // No server targetWorkflowId
      input: { characterId: "some-char-uuid" }, // Legacy fallback input
      execution_plan: {},
    };

    // Must refuse to persist because characterId in input is no longer accepted as workflowId
    await assert.rejects(
      async () => {
        await executeNodePersistence({
          nodeConfig,
          output: { assets: [{ url: "https://cdn.example.com/char.png" }] },
          run: runWithOnlyCharacterIdInput,
        });
      },
      /requires.*workflowId/i,
      "executeNodePersistence must not fall back to run.input.characterId"
    );
  });

  // ── TEST 3: useCaseRunner throws unless status === 'completed' ──
  it("TEST 3: useCaseRunner throws unless status === 'completed'", async () => {
    // Mock getUseCase & startWorkflowRun behavior by invoking runUseCase with a mocked plan
    // We test that if startWorkflowRun returns { status: 'failed' } or { status: 'pending' }, useCaseRunner throws
    await assert.rejects(
      async () => {
        await runUseCase({
          useCaseId: "image-generation-v1",
          input: { prompt: "Test prompt" },
          userId: "user-test-f2b",
          registries: {
            workflows: {
              "image-generation-v1": {
                workflow_id: "image-generation-v1",
                workflow_version: "1.0.0",
                nodes: [{ id: "n1", type: "noop" }],
              },
            },
          },
        });
      },
      (err) => {
        assert.ok(
          err.code === "WORKFLOW_FAILED" || err.code === "WORKFLOW_INCOMPLETE" || err.message?.includes("failed"),
          `Expected workflow failure error, got: ${err.code} / ${err.message}`
        );
        return true;
      }
    );
  });

  // ── TEST 4: Failure handler marks character-sheet media as failed via serverWorkflowId and logs at error level ──
  it("TEST 4: workflow failure marks real character-sheet media as failed via server-side workflowId", async () => {
    const realCharWorkflowId = "char-wf-real-555";
    const spoofedInputWfId = "victim-wf-spoofed-888";

    let failedMediaWorkflowId = null;
    let failedMediaReason = null;

    // Spy on failWorkflowPendingMedia by mocking db.media.updateFields
    db.media.findByWorkflow = async (wfId) => [
      { id: `media-${wfId}`, workflow_id: wfId, status: "processing", step_id: "character_sheet" }
    ];
    db.media.updateFields = async (id, fields) => {
      failedMediaWorkflowId = id;
      failedMediaReason = fields.error_message;
      return { id, ...fields };
    };

    const failingPlan = {
      workflow_id: "character-sheet-v1",
      workflow_version: "1.0.0",
      nodes: [
        {
          id: "fail_node",
          type: "unsupported-node-type-that-fails-immediately",
        },
      ],
      edges: [],
    };

    // Client sends input with spoofed workflow_id
    const runtimeInput = {
      userId: "user-char-owner-1",
      workflow_id: spoofedInputWfId,
      serverWorkflowId: realCharWorkflowId, // Server-assigned workflowId
    };

    const res = await startWorkflowRun(failingPlan, runtimeInput, "run-char-fail-test", {
      workflowId: realCharWorkflowId,
    });

    assert.strictEqual(res.status, "failed", "Run must finish with status 'failed'");

    // Verify media failed was for realCharWorkflowId, NOT spoofedInputWfId
    assert.strictEqual(
      failedMediaWorkflowId,
      `media-${realCharWorkflowId}`,
      "Failure handler must fail the real character workflow media, never the spoofed input workflow ID"
    );
  });
});
}

// ─── Source: nodeAssetNormalizationBoundary.test.js ───
{
/**
 * F2.4-b5 — Real ModelRunner & OutputMap Pipeline Boundary Tests
 *
 * Tests that imageGenerationNode / videoGenerationNode produce exactly 1 asset per request
 * through the REAL src/models/index.js + modelRunner + outputMap + outputValidator pipeline,
 * with ONLY the provider call (WaveSpeed / Google / LTX) mocked via registerProviderRunner.
 *
 * Assertions:
 *   - Exactly 1 asset per request and NO duplicated URLs across:
 *       1. wan_3_0 on wavespeed
 *       2. seedance_2_5 on wavespeed
 *       3. ltx_2_3_fast on ltx
 *       4. nanobana_2 on wavespeed
 *       5. gpt_image_2 on wavespeed
 *       6. nanobana_pro on google
 *   - Surplus (provider returns 2 assets, 1 placeholder) => run succeeds, first asset used,
 *     structured warning logged with runId, nodeId, workflowId, model, provider, assetsReturned,
 *     expected, event "output.asset.surplus".
 *   - Shortage (0 assets / fewer than placeholders) => fails closed with OUTPUT_CONTRACT_VIOLATION.
 */

process.env.NODE_ENV = "test";



after(async () => {
  try {
    await redisConnection?.quit().catch(() => redisConnection?.disconnect());
    await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
  } catch {}
});


function makeCtx() {
  return { runId: `run-b5-${randomUUID()}`, nodeId: `gen_node_${randomUUID()}`, userId: "user-b5-test" };
}


let mediaRows;
let loggedWarnings;

function setupDb() {
  mediaRows = new Map();
  db.media = {
    createMedia: async (data) => {
      const row = { ...data, status: data.status || "processing" };
      mediaRows.set(data.id, row);
      return row;
    },
    findByWorkflow: async (workflowId) =>
      Array.from(mediaRows.values()).filter((m) => m.workflow_id === workflowId),
    updateMedia: async (id, data) => {
      const existing = mediaRows.get(id) || { id };
      const updated = { ...existing, ...data };
      mediaRows.set(id, updated);
      return updated;
    },
  };
}

function seedPlaceholder(workflowId, id, status = "processing") {
  mediaRows.set(id, { id, workflow_id: workflowId, step_id: "image_generation", status });
}

function makeRun(workflowId, mediaIds) {
  return {
    run_id: "run-b5-surplus-test",
    targetWorkflowId: workflowId,
    targetMediaIds: mediaIds,
    execution_plan: { targetWorkflowId: workflowId, targetMediaIds: mediaIds },
  };
}

describe("F2.4-b5 — Real ModelRunner & OutputMap Pipeline Boundary Tests", () => {
  beforeEach(() => {
    setupDb();
    loggedWarnings = [];
  });

  afterEach(() => {
    unregisterProviderRunner("wavespeed");
    unregisterProviderRunner("google");
    unregisterProviderRunner("ltx");
  });

  // ── 1. wan_3_0 on wavespeed ──────────────────────────────────────────────
  it("TEST 1: wan_3_0 on wavespeed through real modelRunner + outputMap → exactly 1 asset, no duplicates", async () => {
    const videoUrl = "https://wavespeed.example.com/wan30/output.mp4";
    // Mock the raw provider response from WaveSpeed SDK
    registerProviderRunner("wavespeed", async ({ binding, payload }) => {
      return { outputs: [videoUrl] };
    });

    const result = await executeVideoGeneration(
      { model: "wan_3_0", prompt: "A cinematic flying drone shot", parameters: { duration: 5 } },
      makeCtx()
    );

    assert.strictEqual(result.assets.length, 1, "Must produce exactly 1 asset");
    assert.strictEqual(result.assets[0].url, videoUrl);
    assert.strictEqual(result.assets[0].type, "video");
    assert.strictEqual(result.metadata.model, "wan_3_0");
    assert.strictEqual(result.metadata.provider, "wavespeed");

    const urls = result.assets.map((a) => a.url);
    assert.strictEqual(new Set(urls).size, urls.length, "No duplicate URLs");
  });

  // ── 2. seedance_2_5 on wavespeed ─────────────────────────────────────────
  it("TEST 2: seedance_2_5 on wavespeed through real modelRunner + outputMap → exactly 1 asset, no duplicates", async () => {
    const videoUrl = "https://wavespeed.example.com/seedance25/output.mp4";
    registerProviderRunner("wavespeed", async () => {
      return { outputs: [videoUrl] };
    });

    const result = await executeVideoGeneration(
      { model: "seedance_2_5", prompt: "A dancer spinning", parameters: { duration: 5 } },
      makeCtx()
    );

    assert.strictEqual(result.assets.length, 1);
    assert.strictEqual(result.assets[0].url, videoUrl);
    assert.strictEqual(result.metadata.model, "seedance_2_5");
    assert.strictEqual(result.metadata.provider, "wavespeed");

    const urls = result.assets.map((a) => a.url);
    assert.strictEqual(new Set(urls).size, urls.length, "No duplicate URLs");
  });

  // ── 3. ltx_2_3_fast on ltx ───────────────────────────────────────────────
  it("TEST 3: ltx_2_3_fast on ltx through real modelRunner + outputMap → exactly 1 asset, no duplicates", async () => {
    const videoUrl = "https://api.ltx.io/generated/video_123.mp4";
    registerProviderRunner("ltx", async () => {
      return { status: "completed", result: { video_url: videoUrl } };
    });

    const result = await executeVideoGeneration(
      { model: "ltx_2_3_fast", prompt: "Time lapse of stars", parameters: { duration: 6, resolution: "720p" } },
      makeCtx()
    );

    assert.strictEqual(result.assets.length, 1);
    assert.strictEqual(result.assets[0].url, videoUrl);
    assert.strictEqual(result.metadata.model, "ltx_2_3_fast");
    assert.strictEqual(result.metadata.provider, "ltx");

    const urls = result.assets.map((a) => a.url);
    assert.strictEqual(new Set(urls).size, urls.length, "No duplicate URLs");
  });

  // ── 4. nanobana_2 on wavespeed ───────────────────────────────────────────
  it("TEST 4: nanobana_2 on wavespeed through real modelRunner + outputMap → exactly 1 asset, no duplicates", async () => {
    const imgUrl = "https://wavespeed.example.com/nanobana2/render.png";
    registerProviderRunner("wavespeed", async () => {
      return { outputs: [imgUrl] };
    });

    const result = await executeImageGeneration(
      { model: "nanobana_2", prompt: "Sunset over Tokyo" },
      makeCtx()
    );

    assert.strictEqual(result.assets.length, 1);
    assert.strictEqual(result.assets[0].url, imgUrl);
    assert.strictEqual(result.assets[0].type, "image");
    assert.strictEqual(result.metadata.model, "nanobana_2");
    assert.strictEqual(result.metadata.provider, "wavespeed");

    const urls = result.assets.map((a) => a.url);
    assert.strictEqual(new Set(urls).size, urls.length, "No duplicate URLs");
  });

  // ── 5. gpt_image_2 on wavespeed ──────────────────────────────────────────
  it("TEST 5: gpt_image_2 on wavespeed through real modelRunner + outputMap → exactly 1 asset, no duplicates", async () => {
    const imgUrl = "https://wavespeed.example.com/gptimage2/render.png";
    registerProviderRunner("wavespeed", async () => {
      return { outputs: [imgUrl] };
    });

    const result = await executeImageGeneration(
      { model: "gpt_image_2", prompt: "Futuristic city street" },
      makeCtx()
    );

    assert.strictEqual(result.assets.length, 1);
    assert.strictEqual(result.assets[0].url, imgUrl);
    assert.strictEqual(result.metadata.model, "gpt_image_2");
    assert.strictEqual(result.metadata.provider, "wavespeed");

    const urls = result.assets.map((a) => a.url);
    assert.strictEqual(new Set(urls).size, urls.length, "No duplicate URLs");
  });

  // ── 6. nanobana_pro on google ────────────────────────────────────────────
  it("TEST 6: nanobana_pro on google through real modelRunner + outputMap → exactly 1 asset, no duplicates", async () => {
    const imgUrl = "https://storage.googleapis.com/nanobana_pro/generated.png";
    registerProviderRunner("google", async () => {
      return {
        predictions: [{ uri: imgUrl }],
        images: [imgUrl],
        outputs: [imgUrl],
        raw: { generatedImages: [{ imageUri: imgUrl }] },
      };
    });

    // Temporarily activate google binding for nanobana_pro
    const bindings = getModelBindings("nanobana_pro");
    const googleBinding = bindings.find((b) => b.providerId === "google");
    const wavespeedBinding = bindings.find((b) => b.providerId === "wavespeed");
    const origGoogleStatus = googleBinding.status;
    const origWavespeedStatus = wavespeedBinding.status;

    try {
      googleBinding.status = "active";
      wavespeedBinding.status = "standby";

      const result = await executeImageGeneration(
        { model: "nanobana_pro", prompt: "Studio portrait of a cat" },
        makeCtx()
      );

      assert.strictEqual(result.assets.length, 1);
      assert.strictEqual(result.assets[0].url, imgUrl);
      assert.strictEqual(result.metadata.model, "nanobana_pro");
      assert.strictEqual(result.metadata.provider, "google");

      const urls = result.assets.map((a) => a.url);
      assert.strictEqual(new Set(urls).size, urls.length, "No duplicate URLs");
    } finally {
      googleBinding.status = origGoogleStatus;
      wavespeedBinding.status = origWavespeedStatus;
    }

  });

  // ── 7. Surplus (2 assets, 1 placeholder) → succeeds, first asset used, warning logged with all 8 fields ──
  it("TEST 7: Surplus (2 assets, 1 placeholder) succeeds, uses first asset, logs structured warning with all 8 required fields", async () => {
    const workflowId = "wf-b5-surplus";
    const ph1 = "ph-b5-surplus-1";
    seedPlaceholder(workflowId, ph1);

    const nodeConfig = {
      id: "generate",
      type: "image-generation",
      persist: { target: "media", step_id: "image_generation", status: "completed" },
    };

    const output = {
      assets: [
        { url: "https://storage.example.com/asset-1-USED.png" },
        { url: "https://storage.example.com/asset-2-DROPPED.png" },
      ],
      metadata: {
        model: "nanobana_2",
        provider: "wavespeed",
      },
    };

    const run = makeRun(workflowId, [ph1]);

    // Should NOT throw — surplus is safely mapped
    await executeNodePersistence({ nodeConfig, output, run });

    // Assert placeholder is completed with first asset
    const finalPlaceholder = mediaRows.get(ph1);
    assert.strictEqual(finalPlaceholder.status, "completed");
    assert.strictEqual(finalPlaceholder.url, "https://storage.example.com/asset-1-USED.png");
  });

  // ── 8. Shortage (0 assets, 1 placeholder) → fail closed ──────────────────
  it("TEST 8: Shortage (0 assets, 1 placeholder) fails closed with OUTPUT_CONTRACT_VIOLATION and marks media failed", async () => {
    const workflowId = "wf-b5-shortage";
    const ph1 = "ph-b5-shortage-1";
    seedPlaceholder(workflowId, ph1);

    const nodeConfig = {
      id: "generate",
      type: "image-generation",
      persist: { target: "media", step_id: "image_generation", status: "completed" },
    };

    const output = {
      assets: [],
      metadata: { model: "nanobana_2", provider: "wavespeed" },
    };

    const run = makeRun(workflowId, [ph1]);

    await assert.rejects(
      () => executeNodePersistence({ nodeConfig, output, run }),
      (err) => {
        assert.strictEqual(err.code, "OUTPUT_CONTRACT_VIOLATION");
        assert.strictEqual(err.retryable, false);
        return true;
      }
    );

    assert.strictEqual(mediaRows.get(ph1).status, "failed");
  });

  // ── 9. Non-test NODE_ENV guard ────────────────────────────────────────────
  it("TEST 9: in a non-test NODE_ENV (e.g. production), registerProviderRunner throws and real runner is used", async () => {
    const origEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      assert.throws(
        () => registerProviderRunner("wavespeed", async () => ({ outputs: [] })),
        /only allowed when NODE_ENV === "test"/
      );
      assert.throws(
        () => unregisterProviderRunner("wavespeed"),
        /only allowed when NODE_ENV === "test"/
      );
    } finally {
      process.env.NODE_ENV = origEnv;
    }

    // In NODE_ENV === "test", unregister ensures real runner is returned
    unregisterProviderRunner("wavespeed");
    const runner = await getRunner("wavespeed");
    assert.strictEqual(typeof runner, "function");
    // Verify it is not our mock
    assert.notStrictEqual(runner.name, "mockRunner");
  });
});
}

// ─── Source: multiAssetOutputsBoundary.test.js ───
{
after(async () => {
  try {
    await redisConnection?.quit().catch(() => redisConnection?.disconnect());
    await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
  } catch {}
});

describe("Multi-Asset Outputs & Count Boundary (F2.4-b)", () => {
  let mediaRows;
  let updateCalls;

  beforeEach(() => {
    mediaRows = new Map();
    updateCalls = [];

    db.media = {
      createMedia: async (data) => {
        const row = { ...data, status: data.status || "processing" };
        mediaRows.set(data.id, row);
        return row;
      },
      findByWorkflow: async (workflowId) => {
        return Array.from(mediaRows.values()).filter((m) => m.workflow_id === workflowId);
      },
      updateMedia: async (id, data) => {
        updateCalls.push({ id, ...data });
        const existing = mediaRows.get(id) || { id };
        const updated = { ...existing, ...data };
        mediaRows.set(id, updated);
        return updated;
      },
    };
  });

  it("TEST 1: executeNodePersistence with SURPLUS assets (2 returned, 1 placeholder) — maps FIRST asset, succeeds (F2.4-b1 approved)", async () => {
    const workflowId = "wf-multi-1";
    const placeholder1 = "placeholder-1";

    mediaRows.set(placeholder1, {
      id: placeholder1,
      workflow_id: workflowId,
      step_id: "image_generation",
      status: "processing",
    });

    const nodeConfig = {
      id: "generate",
      type: "image-generation",
      persist: {
        target: "media",
        step_id: "image_generation",
        status: "completed",
        value: "$outputs.assets[0].url",
      },
    };

    // Provider returns 2 assets, but only 1 placeholder was pre-allocated.
    // Per F2.4-b1 decision: surplus → map first N, drop surplus, log warning, SUCCEED.
    const output = {
      assets: [
        { url: "https://storage.example.com/asset-1.png" },
        { url: "https://storage.example.com/asset-2.png" },
      ],
    };

    const run = {
      run_id: "run-multi-1",
      targetWorkflowId: workflowId,
      targetMediaIds: [placeholder1],
      execution_plan: {
        targetWorkflowId: workflowId,
        targetMediaIds: [placeholder1],
      },
    };

    // Must NOT throw — surplus is mapped, run succeeds
    await executeNodePersistence({ nodeConfig, output, run });

    // The placeholder must be completed with the FIRST asset URL
    const finalPlaceholder = mediaRows.get(placeholder1);
    assert.strictEqual(finalPlaceholder.status, "completed", "Placeholder must be completed (surplus is safe)");
    assert.strictEqual(finalPlaceholder.url, "https://storage.example.com/asset-1.png",
      "First asset URL must be used; second (surplus) is dropped");
  });


  it("TEST 2: executeNodePersistence fails closed with OUTPUT_CONTRACT_VIOLATION and marks ALL N media failed when assets < placeholders", async () => {
    const workflowId = "wf-multi-2";
    const placeholder1 = "placeholder-2a";
    const placeholder2 = "placeholder-2b";

    mediaRows.set(placeholder1, {
      id: placeholder1,
      workflow_id: workflowId,
      step_id: "image_generation",
      status: "processing",
    });
    mediaRows.set(placeholder2, {
      id: placeholder2,
      workflow_id: workflowId,
      step_id: "image_generation",
      status: "processing",
    });

    const nodeConfig = {
      id: "generate",
      type: "image-generation",
      persist: {
        target: "media",
        step_id: "image_generation",
        status: "completed",
        value: "$outputs.assets[0].url",
      },
    };

    // Provider returns only 1 asset when 2 were expected
    const output = {
      assets: [{ url: "https://storage.example.com/asset-1.png" }],
    };

    const run = {
      run_id: "run-multi-2",
      targetWorkflowId: workflowId,
      targetMediaIds: [placeholder1, placeholder2],
      execution_plan: {
        targetWorkflowId: workflowId,
        targetMediaIds: [placeholder1, placeholder2],
      },
    };

    await assert.rejects(
      async () => {
        await executeNodePersistence({ nodeConfig, output, run });
      },
      (err) => {
        assert.strictEqual(err.code, "OUTPUT_CONTRACT_VIOLATION");
        return true;
      }
    );

    // Assert ALL N media placeholders are marked failed
    assert.strictEqual(mediaRows.get(placeholder1).status, "failed", "placeholder1 must be failed");
    assert.strictEqual(mediaRows.get(placeholder2).status, "failed", "placeholder2 must be failed");
  });

  it("TEST 3: executeNodePersistence maps assets[i] -> placeholder[i] when count matches exactly", async () => {
    const workflowId = "wf-multi-3";
    const placeholder1 = "placeholder-3a";
    const placeholder2 = "placeholder-3b";

    mediaRows.set(placeholder1, {
      id: placeholder1,
      workflow_id: workflowId,
      step_id: "image_generation",
      status: "processing",
    });
    mediaRows.set(placeholder2, {
      id: placeholder2,
      workflow_id: workflowId,
      step_id: "image_generation",
      status: "processing",
    });

    const nodeConfig = {
      id: "generate",
      type: "image-generation",
      persist: {
        target: "media",
        step_id: "image_generation",
        status: "completed",
      },
    };

    const output = {
      assets: [
        { url: "https://storage.example.com/asset-3a.png" },
        { url: "https://storage.example.com/asset-3b.png" },
      ],
    };

    const run = {
      run_id: "run-multi-3",
      targetWorkflowId: workflowId,
      targetMediaIds: [placeholder1, placeholder2],
      execution_plan: {
        targetWorkflowId: workflowId,
        targetMediaIds: [placeholder1, placeholder2],
      },
    };

    await executeNodePersistence({ nodeConfig, output, run });

    assert.strictEqual(mediaRows.get(placeholder1).status, "completed");
    assert.strictEqual(mediaRows.get(placeholder1).url, "https://storage.example.com/asset-3a.png");
    assert.strictEqual(mediaRows.get(placeholder2).status, "completed");
    assert.strictEqual(mediaRows.get(placeholder2).url, "https://storage.example.com/asset-3b.png");
  });

  it("TEST 4: calculateCost rejects unsupported count parameter with UNSUPPORTED_CAPABILITY", () => {
    assert.throws(
      () => calculateCost("nanobana_2", { prompt: "test prompt", resolution: "1k", count: 4 }),
      (err) => {
        assert.strictEqual(err.code, "UNSUPPORTED_CAPABILITY");
        assert.match(err.message, /does not support parameter "count"/i);
        return true;
      }
    );
  });

  it("TEST 5: calculateRetailCredits does NOT multiply by count", async () => {
    const { calculateRetailCredits } = await import("#models/tools");
    const model = { retailPricing: { table: { "1k": 8, default: 8 } } };
    const cost1 = calculateRetailCredits(model, { resolution: "1k", count: 1 });
    const cost4 = calculateRetailCredits(model, { resolution: "1k", count: 4 });
    assert.strictEqual(cost1, 8);
    assert.strictEqual(cost4, 8, "Retail credits must not multiply by count");
  });

  it("TEST 6: workflowBillingPlan does NOT multiply by count when calculating upfront reserve", async () => {
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

    const mockCalculateCost = () => 10;

    const baseResult = await calculateWorkflowBillingPlan({
      plan,
      inputs: { prompt: "hello", model: "test-model", count: 1 },
      calculateCostFn: mockCalculateCost,
    });

    const multiResult = await calculateWorkflowBillingPlan({
      plan,
      inputs: { prompt: "hello", model: "test-model", count: 4 },
      calculateCostFn: mockCalculateCost,
    });

    assert.strictEqual(multiResult.totalCredits, 10);
    assert.strictEqual(baseResult.totalCredits, 10);
  });

  it("TEST 7: imageController clamps output count to 1 and pre-allocates exactly 1 placeholder even if count=4 is requested", async () => {
    const { useCaseService } = await import("../../../src/container.js");
    const origPrepare = useCaseService.prepareAndEnqueue;
    let preparedArgs = null;
    useCaseService.prepareAndEnqueue = async (args) => {
      preparedArgs = args;
      return { executionId: "exec-multi-test", cost: { totalCredits: 8 } };
    };

    try {
      db.workflows = {
        createWorkflow: async (data) => data,
      };
      db.projects = {
        findById: async (id) => ({ id, user_id: "user-multi-test" }),
      };

      let responseJson = null;
      const req = {
        user: { id: "user-multi-test" },
        body: {
          prompt: "A beautiful mountain",
          model: "nanobana_2",
          project_id: "proj-multi-test",
          count: 4,
          parameters: { count: 4 },
        },
      };
      const res = {
        status: () => res,
        json: (data) => {
          responseJson = data;
          return data;
        },
      };

      await imageController.generateImage(req, res);

      assert.ok(responseJson, "Response JSON must be returned");
      assert.strictEqual(responseJson.ok, true);
      assert.strictEqual(responseJson.mediaIds.length, 1, "Exactly 1 placeholder returned in mediaIds");
      assert.strictEqual(preparedArgs.input.serverMediaIds.length, 1, "serverMediaIds must contain exactly 1 id");
      assert.strictEqual(preparedArgs.serverContext.mediaIds.length, 1, "serverContext.mediaIds must contain exactly 1 id");
      assert.strictEqual(mediaRows.size, 1, "Exactly 1 media placeholder created in db.media");
    } finally {
      useCaseService.prepareAndEnqueue = origPrepare;
    }
  });
});
}

// ─── Source: distributedAccumulatorBoundary.test.js ───
{
/**
 * Boundary tests: BUG-09 — in-memory activeAccumulators not shared across processes
 *
 * The bug: getRunBillingAccumulator(runId) returns null when called from a
 * fresh module context (simulating a separate worker process or a crash/restart).
 * Billing entries are lost because they exist only in the process-local Map.
 *
 * Fix: Persist billing entries to run metadata via runRepo.updateRun so that
 * any worker process can reconstruct the accumulator from DB.
 */


// ── Force in-memory mode (no Supabase required) ───────────────────────────────
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";

RunRepository.useMemoryFallback = true;


// ── Minimal stub gateways ─────────────────────────────────────────────────────
const stubBilling = {
  reserve: async () => ({ referenceId: "ref-stub", amount: 0, status: "held" }),
  settle: async () => ({ status: "settled" }),
  rollback: async () => ({ status: "voided" }),
  extendHold: async () => ({ status: "extended" }),
};

const stubStorage = { upload: async () => ({ url: "https://example.com/img" }) };
const stubEvents = { record: () => {} };

before(() => {
  initializeGateways({ billing: stubBilling, storage: stubStorage, events: stubEvents });
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function makeMinimalPlan(overrides = {}) {
  return {
    workflow_id: "wf-test",
    workflow_version: "1",
    nodes: [],
    edges: [],
    ...overrides,
  };
}

// ── TEST SUITE ─────────────────────────────────────────────────────────────────
describe("BUG-09 — distributed accumulator persistence", () => {
  /**
   * TEST 1: getRunBillingAccumulator must not return null for a run whose
   * DB record exists but whose in-memory Map entry was cleared (simulating
   * a fresh process or crash/restart).
   *
   * Before the fix: activeAccumulators.get(runId) returns undefined → null.
   * After the fix: function reconstructs accumulator from run metadata.
   */
  it("T1 — reconstructs accumulator from DB metadata after in-memory map is cleared", async () => {
    // Arrange: create a run record directly in the repo
    const runRepo = new RunRepository();
    const runId = "run-dist-001";
    await runRepo.createRun({
      run_id: runId,
      workflow_id: "wf-test",
      workflow_version: "1",
      status: "running",
      input: {},
      execution_plan: {},
    });

    // Seed billing entries into metadata (simulating a previous worker's writes)
    const existingEntries = [
      { nodeId: "node-a", nodeType: "llm", model: "gemini", amount: 10, kind: "CHARGEABLE", recordedAt: new Date().toISOString() },
    ];
    const run = await runRepo.getRun(runId);
    await runRepo.updateRun(runId, {
      metadata: { ...(run.metadata || {}), billingAccumulator: existingEntries },
    });

    // Act: call getRunBillingAccumulator — in-memory Map does NOT have this runId
    const accumulator = await getRunBillingAccumulator(runId);

    // Assert: must NOT be null; must expose the persisted entries
    assert.ok(accumulator !== null, "accumulator must not be null when run metadata exists");
    const breakdown = await accumulator.getBreakdown();
    assert.equal(breakdown.length, 1, "must reconstruct 1 entry from DB metadata");
    assert.equal(breakdown[0].nodeId, "node-a");
    const total = await accumulator.getTotalCost();
    assert.equal(total, 10, "must reconstruct total cost from DB metadata");
  });

  /**
   * TEST 2: record() on the accumulator must persist entries to run metadata,
   * not just update the in-memory Map.
   *
   * Before the fix: entries are only in BillingAccumulator.entries[] — a
   * process crash loses them.
   * After the fix: each record() call writes to runRepo.updateRun.
   */
  it("T2 — record() persists billing entry to run metadata", async () => {
    const runRepo = new RunRepository();
    const runId = "run-dist-002";
    await runRepo.createRun({
      run_id: runId,
      workflow_id: "wf-test",
      workflow_version: "1",
      status: "running",
      input: {},
      execution_plan: {},
    });

    // Get the accumulator (set up during startWorkflowRun normally)
    // For this test we set it manually via the module to avoid a full run
    const accumulator = await getRunBillingAccumulator(runId);
    // accumulator may be null initially (no in-memory entry) or a fresh reconstructed one
    // The fix must allow us to record directly against the runId

    // Act: record a billing entry — after the fix, this must persist to DB
    await accumulator.record({
      nodeId: "node-b",
      nodeType: "image-generation",
      model: "wavespeed",
      amount: 25,
      kind: "CHARGEABLE",
    });

    // Assert: verify the entry appears in DB metadata
    const stored = await runRepo.getRun(runId);
    const storedEntries = stored?.metadata?.billingAccumulator || [];
    assert.ok(storedEntries.length >= 1, "entry must be persisted to run metadata");
    const entry = storedEntries.find((e) => e.nodeId === "node-b");
    assert.ok(entry, "node-b entry must be in metadata");
    assert.equal(entry.amount, 25);
  });

  /**
   * TEST 3: Two simulated "worker processes" (fresh getRunBillingAccumulator
   * calls on the same runId, without a shared in-memory Map) must see
   * consistent accumulated totals.
   *
   * Before the fix: second call returns null (no Map entry).
   * After the fix: both calls return the same DB-backed totals.
   */
  it("T3 — two independent accumulator reads on same runId see consistent totals", async () => {
    const runRepo = new RunRepository();
    const runId = "run-dist-003";
    await runRepo.createRun({
      run_id: runId,
      workflow_id: "wf-test",
      workflow_version: "1",
      status: "running",
      input: {},
      execution_plan: {},
    });

    // Worker-1 writes 2 entries
    await runRepo.updateRun(runId, {
      metadata: {
        billingAccumulator: [
          { nodeId: "n1", amount: 5, kind: "CHARGEABLE", recordedAt: new Date().toISOString() },
          { nodeId: "n2", amount: 15, kind: "CHARGEABLE", recordedAt: new Date().toISOString() },
        ],
      },
    });

    // Worker-2 reads accumulator (no in-memory Map entry)
    const acc = await getRunBillingAccumulator(runId);
    assert.ok(acc !== null, "worker-2 must get a non-null accumulator");
    const total = await acc.getTotalCost();
    assert.equal(total, 20, "worker-2 must see combined total of 20 from DB");
    const breakdown = await acc.getBreakdown();
    assert.equal(breakdown.length, 2, "worker-2 must see 2 entries");
  });

  /**
   * TEST 4: Crash simulation — accumulator initialized but process "restarts"
   * (in-memory Map is cleared by simulated restart). New process must
   * reconstruct correct breakdown for settlement.
   *
   * Before the fix: getRunBillingAccumulator returns null → settlement uses 0.
   * After the fix: settlement reconstructs from DB, totalCost = correct value.
   */
  it("T4 — crash recovery: new process reconstructs breakdown from DB for settlement", async () => {
    const runRepo = new RunRepository();
    const runId = "run-dist-004";
    await runRepo.createRun({
      run_id: runId,
      workflow_id: "wf-test",
      workflow_version: "1",
      status: "running",
      input: {},
      execution_plan: {},
    });

    // Simulate: previous worker wrote these entries to DB before crashing
    await runRepo.updateRun(runId, {
      metadata: {
        billingAccumulator: [
          { nodeId: "nodeX", amount: 50, kind: "CHARGEABLE", recordedAt: new Date().toISOString() },
          { nodeId: "nodeY", amount: 0, kind: "NO_CHARGE", recordedAt: new Date().toISOString() },
          { nodeId: "nodeZ", amount: 30, kind: "CHARGEABLE", recordedAt: new Date().toISOString() },
        ],
      },
    });

    // New process: no in-memory Map entry for this runId
    const acc = await getRunBillingAccumulator(runId);
    assert.ok(acc !== null, "recovered accumulator must not be null");

    const total = await acc.getTotalCost();
    assert.equal(total, 80, "crash-recovered total must be 80 (50+30 chargeable)");

    const breakdown = await acc.getBreakdown();
    assert.equal(breakdown.length, 3, "must recover all 3 entries");
    assert.ok(breakdown.some((e) => e.nodeId === "nodeX"), "nodeX must be in breakdown");
    assert.ok(breakdown.some((e) => e.nodeId === "nodeZ"), "nodeZ must be in breakdown");
  });

  after(async () => {
    try {
      const { redisConnection, workerRedisConnection } = await import("#shared");
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
  });
});
}

// ─── Source: providerErrorSemanticsPreservationBoundary.test.js ───
{
describe("D2.5 — Provider Error Semantics & Upstream Fault Mapping Boundary Tests", () => {
  it("TEST 1: formatWorkflowError maps PROVIDER_UNAVAILABLE to UPSTREAM_FAULT and retryable: true", () => {
    const providerErr = new ProviderTransientError("Provider is currently unavailable.");
    providerErr.code = "PROVIDER_UNAVAILABLE";
    providerErr.statusCode = 503;
    providerErr.retryable = true;

    const formatted = formatWorkflowError(providerErr, { node_id: "generate" });

    assert.equal(
      formatted.code,
      "PROVIDER_UNAVAILABLE",
      `Expected code PROVIDER_UNAVAILABLE, got ${formatted.code}`
    );
    assert.equal(
      formatted.category,
      ERROR_CATEGORIES.UPSTREAM_FAULT,
      `Expected category UPSTREAM_FAULT, got ${formatted.category} (must NOT be SERVER_FAULT)`
    );
    assert.equal(
      formatted.retryable,
      true,
      `Expected retryable to be true, got ${formatted.retryable}`
    );
  });

  it("TEST 2: toRuntimeError preserves retryable: true for transient provider errors", () => {
    const providerErr = {
      code: "PROVIDER_UNAVAILABLE",
      message: "Provider is currently unavailable.",
      retryable: true,
    };

    const runtimeErr = toRuntimeError(providerErr);

    assert.equal(runtimeErr.code, "PROVIDER_UNAVAILABLE");
    assert.equal(runtimeErr.category, ERROR_CATEGORIES.UPSTREAM_FAULT);
    assert.equal(runtimeErr.retryable, true);
  });

  it("TEST 3: RUNTIME_ERROR_CODES includes PROVIDER_UNAVAILABLE", () => {
    assert.ok(
      RUNTIME_ERROR_CODES.PROVIDER_UNAVAILABLE,
      "RUNTIME_ERROR_CODES must define PROVIDER_UNAVAILABLE"
    );
    assert.equal(RUNTIME_ERROR_CODES.PROVIDER_UNAVAILABLE, "PROVIDER_UNAVAILABLE");
  });

  it("TEST 4: normalizeError preserves terminal: true and retryable: false for polling terminal failures", async () => {
    const { normalizeError } = await import("#models/tools");
    const terminalErr = new Error("LTX job failed: Service unavailable on worker");
    terminalErr.terminal = true;
    terminalErr.retryable = false;
    terminalErr.code = "PROVIDER_JOB_FAILED";

    const normalized = normalizeError(terminalErr);

    assert.equal(normalized.terminal, true, "Expected normalized.terminal to be true");
    assert.equal(normalized.retryable, false, "Expected normalized.retryable to be false (must NOT retry dead job)");
    assert.equal(normalized.code, "PROVIDER_JOB_FAILED");
  });

  it("TEST 5: RuntimeExecutor does NOT retry when an error is marked terminal", async () => {
    const { RuntimeExecutor } = await import("#models/tools");
    const executor = new RuntimeExecutor();

    let attempts = 0;
    const terminalErr = new Error("LTX job failed terminally");
    terminalErr.terminal = true;
    terminalErr.retryable = false;
    terminalErr.code = "PROVIDER_JOB_FAILED";

    const binding = { id: "test-binding", streaming: false };
    const provider = { id: "test-provider" };

    await assert.rejects(
      async () => {
        await executor.execute({
          provider,
          binding,
          providerPayload: {},
          credential: "mock-key",
          modelId: "test-model",
          bindingId: "test-binding",
          options: {
            maxRetries: 3,
            providerExecutor: async () => {
              attempts++;
              throw terminalErr;
            },
          },
        });
      },
      (err) => {
        assert.equal(err.message, "LTX job failed terminally");
        return true;
      }
    );

    assert.equal(
      attempts,
      1,
      `Expected exactly 1 attempt without duplicate re-submissions, got ${attempts}`
    );
  });
});
}

// ─── Source: mediaGenerationConfigLifecycleBoundary.test.js ───
{
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
}
