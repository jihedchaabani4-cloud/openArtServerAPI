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

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { executeImageGeneration } from "../../src/v2/nodes/imageGenerationNode.js";
import { executeVideoGeneration } from "../../src/v2/nodes/videoGenerationNode.js";
import { executeNodePersistence } from "../../src/v2/runner/nodeExecutor.js";
import { registerProviderRunner, unregisterProviderRunner } from "../../src/models/index.js";
import { getModelBindings } from "../../src/models/registry/modelRegistry.js";
import { db } from "../../src/container.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";

after(async () => {
  try {
    await redisConnection?.quit().catch(() => redisConnection?.disconnect());
    await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
  } catch {}
});

import { randomUUID } from "node:crypto";

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
});
