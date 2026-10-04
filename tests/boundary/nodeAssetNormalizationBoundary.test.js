/**
 * F2.4-b4 — Node Asset Normalization & Surplus Handling Boundary Tests
 *
 * Tests that imageGenerationNode / videoGenerationNode produce exactly 1 asset per request
 * when using REALISTIC runner result shapes (as produced by the real runner + outputMap),
 * with no duplicated URLs.
 *
 * Mock injection: ctx._runFn replaces models.run() at the node level.
 * ESM modules are read-only, so we cannot patch the imported `run` binding directly.
 * Instead, both nodes accept ctx._runFn as a test seam.
 *
 * Also tests the surplus-mapping decision (F2.4-b1 APPROVED):
 *   - surplus (provider returns N+k assets, N placeholders): map first N, log warning, succeed
 *   - shortage (fewer assets than placeholders): fail closed as before
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { executeImageGeneration } from "../../src/v2/nodes/imageGenerationNode.js";
import { executeVideoGeneration } from "../../src/v2/nodes/videoGenerationNode.js";
import { executeNodePersistence } from "../../src/v2/runner/nodeExecutor.js";
import { db } from "../../src/container.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";

after(async () => {
  try {
    await redisConnection?.quit().catch(() => redisConnection?.disconnect());
    await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
  } catch {}
});

// ─────────────────────────────────────────────────────────────────────────────
// Realistic runner result shapes
// These mirror modelRunner.js:219-243 output for each binding/domain combination.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wavespeed image models (nanobana_2, gpt_image_2, seedream_v5, wavespeed_upscale, nanobana_pro wavespeed)
 * outputMap: { "images": "outputs" }
 * rawResponse from WaveSpeed SDK: { outputs: ["https://url/img.png"] }
 * After parameterMapper: normalizedOutput = { images: [{ url }], raw: ... }
 * modelRunner result: { images: [{ url }], videos: [], data: normalizedOutput }
 *   (isVideo=false → videoList=[] → videos:[])
 */
function makeWavespeedImageResult(url) {
  return {
    status: "success",
    data: { images: [{ url }], text: null, content: null, raw: { outputs: [url] } },
    content: "", text: "",
    images: [{ url }],
    videos: [],
    metadata: { modelId: "nanobana_2", creditsCharged: 8, durationMs: 100 },
    _internal: { providerId: "wavespeed" },
  };
}

/**
 * Google image model (nanobana_pro/google)
 * outputMap: { "images": "images" }
 * After parameterMapper: normalizedOutput = { images: [{ url }], ... }
 * modelRunner result: same shape as wavespeed image (domain=image, videos=[])
 */
function makeGoogleImageResult(url) {
  return {
    status: "success",
    data: { images: [{ url }], text: null, content: null },
    content: "", text: "",
    images: [{ url }],
    videos: [],
    metadata: { modelId: "nanobana_pro", creditsCharged: 60, durationMs: 200 },
    _internal: { providerId: "google" },
  };
}

/**
 * Wavespeed VIDEO models (wan_3_0, seedance_2_5, seedance_2_5_extend)
 * outputMap: { "images": "outputs", "videoUrl": "outputs.0" }
 * rawResponse: { outputs: ["https://url/video.mp4"] }
 * After parameterMapper:
 *   normalizedOutput.images = [{ url }]   (from "images": "outputs")
 *   normalizedOutput.videoUrl = url        (from "videoUrl": "outputs.0")
 *   normalizedOutput.videos = undefined    (no "videos" key in outputMap)
 * modelRunner.js:214-217 (isVideo=true):
 *   videoList = normalizedOutput.videos      → undefined, falsy
 *              || (isVideo && images.length → true)
 *              → videoList = normalizedOutput.images = [{ url }]
 * Result: { images: [{ url }], videos: [{ url }] }
 *   ← Same array in both fields, but videoGenerationNode reads runResult.videos first
 *   → rawVideos = runResult.videos = [{ url }] → exactly 1 asset ✅
 */
function makeWavespeedVideoResult(url) {
  const images = [{ url }];
  return {
    status: "success",
    data: { images, videoUrl: url, text: null, content: null, raw: { outputs: [url] } },
    content: "", text: "",
    images,
    videos: images,  // same reference — modelRunner assigns videoList = images when videos is undefined
    metadata: { modelId: "wan_3_0", creditsCharged: 15, durationMs: 8000 },
    _internal: { providerId: "wavespeed" },
  };
}

/**
 * LTX video models (ltx_2_3_fast, ltx_2_5_fast, etc.)
 * outputMap: { "videos.0.url": "result.video_url", "url": "result.video_url", "images.0.url": "result.video_url" }
 * rawResponse: { status: "completed", result: { video_url: "https://ltx/v.mp4" } }
 * After parameterMapper:
 *   normalizedOutput.videos = [{ url }]   (from "videos.0.url": "result.video_url")
 *   normalizedOutput.url = url             (from "url": "result.video_url")
 *   normalizedOutput.images = [{ url }]   (from "images.0.url": "result.video_url")
 * modelRunner.js:214-217 (isVideo=true):
 *   videoList = normalizedOutput.videos → [{ url }]  (non-empty, takes priority)
 * Result: { images: [{ url }], videos: [{ url }] }
 *   videoGenerationNode reads runResult.videos first → rawVideos = [{ url }] → 1 asset ✅
 */
function makeLtxVideoResult(url) {
  return {
    status: "success",
    data: {
      videos: [{ url }],
      images: [{ url }],  // also populated by outputMap
      url,
      text: null, content: null,
      raw: { status: "completed", result: { video_url: url } },
    },
    content: "", text: "",
    images: [{ url }],
    videos: [{ url }],
    metadata: { modelId: "ltx_2_3_fast", creditsCharged: 16, durationMs: 45000 },
    _internal: { providerId: "ltx" },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test db setup helpers
// ─────────────────────────────────────────────────────────────────────────────

let mediaRows;

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
    run_id: "run-norm-test",
    targetWorkflowId: workflowId,
    targetMediaIds: mediaIds,
    execution_plan: { targetWorkflowId: workflowId, targetMediaIds: mediaIds },
  };
}

const CTX = { runId: "run-norm-test", nodeId: "gen_node", userId: "user-norm-test" };

// ─────────────────────────────────────────────────────────────────────────────
// PART A — Exactly 1 asset, no duplicated URL for every realistic runner shape
// Tests use ctx._runFn to inject mock runner results (ESM-safe seam)
// ─────────────────────────────────────────────────────────────────────────────

describe("F2.4-b4 — Node Asset Normalization & Surplus Handling Boundary Tests", () => {

  it("TEST 1: wavespeed image (nanobana_2) → exactly 1 asset, no duplicate URL", async () => {
    const url = "https://wavespeed.example.com/nanobana2/img.png";
    const mockRun = async () => makeWavespeedImageResult(url);
    const ctx = { ...CTX, _runFn: mockRun };

    const result = await executeImageGeneration({ model: "nanobana_2", prompt: "a mountain" }, ctx);

    assert.strictEqual(result.assets.length, 1, "Must produce exactly 1 asset");
    assert.strictEqual(result.assets[0].url, url, "Asset URL must match");
    assert.strictEqual(result.assets[0].type, "image");
    const urls = result.assets.map((a) => a.url);
    assert.strictEqual(new Set(urls).size, urls.length, "No duplicate asset URLs");
  });

  it("TEST 2: google image (nanobana_pro) → exactly 1 asset, no duplicate URL", async () => {
    const url = "https://storage.googleapis.com/nanobana_pro/img.png";
    const mockRun = async () => makeGoogleImageResult(url);
    const ctx = { ...CTX, _runFn: mockRun };

    const result = await executeImageGeneration({ model: "nanobana_pro", prompt: "portrait" }, ctx);

    assert.strictEqual(result.assets.length, 1);
    assert.strictEqual(result.assets[0].url, url);
    assert.strictEqual(new Set(result.assets.map((a) => a.url)).size, 1, "No duplicate URLs");
  });

  it("TEST 3: wavespeed video (wan_3_0) — images AND videos both contain same URL — exactly 1 asset, no duplicate", async () => {
    const url = "https://wavespeed.example.com/wan_3_0/video.mp4";
    const mockRun = async () => makeWavespeedVideoResult(url);
    const ctx = { ...CTX, _runFn: mockRun };

    const result = await executeVideoGeneration({ model: "wan_3_0", prompt: "flowing river" }, ctx);

    assert.strictEqual(result.assets.length, 1,
      `Expected 1 asset, got ${result.assets.length} (double-count from images+videos would be 2)`);
    assert.strictEqual(result.assets[0].url, url);
    assert.strictEqual(new Set(result.assets.map((a) => a.url)).size, 1, "No duplicate URLs");
  });

  it("TEST 4: wavespeed video (seedance_2_5) — same shape as wan_3_0 — exactly 1 asset", async () => {
    const url = "https://wavespeed.example.com/seedance/video.mp4";
    const mockRun = async () => makeWavespeedVideoResult(url);
    const ctx = { ...CTX, _runFn: mockRun };

    const result = await executeVideoGeneration({ model: "seedance_2_5", prompt: "wave crashing" }, ctx);

    assert.strictEqual(result.assets.length, 1,
      `Expected 1 asset, got ${result.assets.length}`);
    assert.strictEqual(new Set(result.assets.map((a) => a.url)).size, 1, "No duplicate URLs");
  });

  it("TEST 5: LTX video — videos, images, url all contain same URL — exactly 1 asset, no duplicate", async () => {
    const url = "https://api.ltx.io/output/v.mp4";
    const mockRun = async () => makeLtxVideoResult(url);
    const ctx = { ...CTX, _runFn: mockRun };

    const result = await executeVideoGeneration({ model: "ltx_2_3_fast", prompt: "time lapse" }, ctx);

    assert.strictEqual(result.assets.length, 1,
      `Expected 1 asset, got ${result.assets.length} (triple-count from videos+images+url would be 3)`);
    assert.strictEqual(new Set(result.assets.map((a) => a.url)).size, 1, "No duplicate URLs");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PART B — Surplus & shortage decision (F2.4-b1 APPROVED)
  // ─────────────────────────────────────────────────────────────────────────

  it("TEST 6: executeNodePersistence with SURPLUS (2 assets, 1 placeholder) — maps FIRST asset, succeeds, does NOT throw", async () => {
    setupDb();
    const workflowId = "wf-surplus-1";
    const ph1 = "ph-surplus-1";
    seedPlaceholder(workflowId, ph1);

    const nodeConfig = {
      id: "generate",
      type: "image-generation",
      persist: { target: "media", step_id: "image_generation", status: "completed" },
    };
    const output = {
      assets: [
        { url: "https://storage.example.com/img-FIRST.png" },
        { url: "https://storage.example.com/img-SECOND.png" },
      ],
    };
    const run = makeRun(workflowId, [ph1]);

    // Must NOT throw — surplus is safely handled
    await executeNodePersistence({ nodeConfig, output, run });

    const final = mediaRows.get(ph1);
    assert.strictEqual(final.status, "completed", "Placeholder must be completed");
    assert.strictEqual(final.url, "https://storage.example.com/img-FIRST.png",
      "First (index 0) asset URL must be used — second is dropped");
  });

  it("TEST 7: executeNodePersistence with SHORTAGE (0 assets, 1 placeholder) — fails closed OUTPUT_CONTRACT_VIOLATION", async () => {
    setupDb();
    const workflowId = "wf-shortage-1";
    const ph1 = "ph-shortage-1";
    seedPlaceholder(workflowId, ph1);

    const nodeConfig = {
      id: "generate",
      type: "image-generation",
      persist: { target: "media", step_id: "image_generation", status: "completed" },
    };
    const output = { assets: [] };
    const run = makeRun(workflowId, [ph1]);

    await assert.rejects(
      () => executeNodePersistence({ nodeConfig, output, run }),
      (err) => {
        assert.strictEqual(err.code, "OUTPUT_CONTRACT_VIOLATION", "Error code must be OUTPUT_CONTRACT_VIOLATION");
        assert.strictEqual(err.retryable, false, "Must not be retryable");
        return true;
      },
      "Shortage must fail closed"
    );

    assert.strictEqual(mediaRows.get(ph1).status, "failed", "Placeholder must be marked failed");
  });

  it("TEST 8: executeNodePersistence with SURPLUS (3 assets, 2 placeholders) — maps first 2, third dropped, both placeholders completed", async () => {
    setupDb();
    const workflowId = "wf-surplus-2";
    const ph1 = "ph-surplus-2a";
    const ph2 = "ph-surplus-2b";
    seedPlaceholder(workflowId, ph1);
    seedPlaceholder(workflowId, ph2);

    const nodeConfig = {
      id: "generate",
      type: "image-generation",
      persist: { target: "media", step_id: "image_generation", status: "completed" },
    };
    const output = {
      assets: [
        { url: "https://storage.example.com/img-A.png" },
        { url: "https://storage.example.com/img-B.png" },
        { url: "https://storage.example.com/img-C-DROPPED.png" },
      ],
    };
    const run = makeRun(workflowId, [ph1, ph2]);

    await executeNodePersistence({ nodeConfig, output, run });

    assert.strictEqual(mediaRows.get(ph1).url, "https://storage.example.com/img-A.png");
    assert.strictEqual(mediaRows.get(ph2).url, "https://storage.example.com/img-B.png");
    assert.strictEqual(mediaRows.get(ph1).status, "completed");
    assert.strictEqual(mediaRows.get(ph2).status, "completed");
    // The third asset URL must not appear anywhere in the updated rows
    for (const [, row] of mediaRows) {
      assert.notEqual(row.url, "https://storage.example.com/img-C-DROPPED.png",
        "Dropped surplus asset URL must not be persisted");
    }
  });

  it("TEST 9: executeNodePersistence with EXACT match (2 assets, 2 placeholders) — maps 1:1, both completed", async () => {
    setupDb();
    const workflowId = "wf-exact-2";
    const ph1 = "ph-exact-2a";
    const ph2 = "ph-exact-2b";
    seedPlaceholder(workflowId, ph1);
    seedPlaceholder(workflowId, ph2);

    const nodeConfig = {
      id: "generate",
      type: "image-generation",
      persist: { target: "media", step_id: "image_generation", status: "completed" },
    };
    const output = {
      assets: [
        { url: "https://storage.example.com/img-A.png" },
        { url: "https://storage.example.com/img-B.png" },
      ],
    };
    const run = makeRun(workflowId, [ph1, ph2]);

    await executeNodePersistence({ nodeConfig, output, run });

    assert.strictEqual(mediaRows.get(ph1).url, "https://storage.example.com/img-A.png");
    assert.strictEqual(mediaRows.get(ph2).url, "https://storage.example.com/img-B.png");
    assert.strictEqual(mediaRows.get(ph1).status, "completed");
    assert.strictEqual(mediaRows.get(ph2).status, "completed");
  });
});
