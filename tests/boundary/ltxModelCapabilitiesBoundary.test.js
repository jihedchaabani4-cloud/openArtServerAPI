import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as models from "../../src/models/index.js";
import { executeVideoGeneration } from "../../src/v2/nodes/videoGenerationNode.js";
import { registerProviderRunner, unregisterProviderRunner } from "../../src/models/runtime/providerRuntimeRegistry.js";
import { resolveMediaMetadata } from "../../src/platform/media/mediaMetadataResolver.js";

describe("LTX Video Models Capability and Aspect Ratio Boundary", () => {
  before(() => {
    models.initRegistry({ forceReload: true });
  });

  it("TEST 1: calculateCost supports aspect_ratio for ltx_2_3_pro (16:9)", () => {
    const cost = models.calculateCost("ltx_2_3_pro", {
      prompt: "A cinematic fly-through over neon city",
      duration: 8,
      resolution: "1080p",
      aspect_ratio: "16:9",
    });
    assert.strictEqual(typeof cost, "number");
    assert.ok(cost > 0, "Cost must be a positive credit amount");
  });

  it("TEST 2: calculateCost supports aspect_ratio for ltx_2_3_fast (9:16)", () => {
    const cost = models.calculateCost("ltx_2_3_fast", {
      prompt: "Fast vertical video of a waterfall",
      duration: 8,
      resolution: "720p",
      aspect_ratio: "9:16",
    });
    assert.strictEqual(typeof cost, "number");
    assert.ok(cost > 0, "Cost must be a positive credit amount");
  });

  it("TEST 3: calculateCost supports aspect_ratio for ltx_2_5_pro (16:9)", () => {
    const cost = models.calculateCost("ltx_2_5_pro", {
      prompt: "Cinematic shot of ocean waves",
      duration: 8,
      resolution: "1080p",
      aspect_ratio: "16:9",
    });
    assert.strictEqual(typeof cost, "number");
    assert.ok(cost > 0, "Cost must be a positive credit amount");
  });

  it("TEST 4: calculateCost supports aspect_ratio for ltx_2_5_fast (9:16)", () => {
    const cost = models.calculateCost("ltx_2_5_fast", {
      prompt: "Vertical dance clip",
      duration: 8,
      resolution: "720p",
      aspect_ratio: "9:16",
    });
    assert.strictEqual(typeof cost, "number");
    assert.ok(cost > 0, "Cost must be a positive credit amount");
  });

  it("TEST 5: manifests declare aspect_ratio capability and canonical input", () => {
    const ltxModels = ["ltx_2_3_pro", "ltx_2_3_fast", "ltx_2_5_pro", "ltx_2_5_fast"];
    for (const mId of ltxModels) {
      const schema = models.getModelSchema(mId);
      assert.ok(schema.parameters.aspect_ratio, `Model ${mId} schema must declare aspect_ratio`);
      assert.deepStrictEqual(schema.parameters.aspect_ratio.values, ["16:9", "9:16"]);
      assert.strictEqual(schema.parameters.aspect_ratio.default, "16:9");
    }
  });

  it("TEST 6: executeVideoGeneration with ltx_2_3_pro and aspect_ratio: 16:9 succeeds", async () => {
    const videoUrl = "https://api.ltx.io/generated/ltx_pro_123.mp4";
    registerProviderRunner("ltx", async () => {
      return { status: "completed", result: { video_url: videoUrl } };
    });

    try {
      const result = await executeVideoGeneration(
        {
          model: "ltx_2_3_pro",
          prompt: "Cinematic mountain sunset",
          parameters: { duration: 8, resolution: "1080p", aspect_ratio: "16:9" },
        },
        { runId: "run-ltx-test", nodeId: "gen_node_ltx", userId: "user-ltx" }
      );

      assert.strictEqual(result.assets.length, 1);
      assert.strictEqual(result.assets[0].url, videoUrl);
      assert.strictEqual(result.metadata.model, "ltx_2_3_pro");
      assert.strictEqual(result.metadata.provider, "ltx");
    } finally {
      unregisterProviderRunner("ltx");
    }
  });

  it("TEST 7: executeVideoGeneration with ltx_2_3_fast and aspect_ratio: 9:16 succeeds", async () => {
    const videoUrl = "https://api.ltx.io/generated/ltx_fast_456.mp4";
    registerProviderRunner("ltx", async () => {
      return { status: "completed", result: { video_url: videoUrl } };
    });

    try {
      const result = await executeVideoGeneration(
        {
          model: "ltx_2_3_fast",
          prompt: "Vertical skateboard trick",
          parameters: { duration: 6, resolution: "720p", aspect_ratio: "9:16" },
        },
        { runId: "run-ltx-fast-test", nodeId: "gen_node_ltx_fast", userId: "user-ltx" }
      );

      assert.strictEqual(result.assets.length, 1);
      assert.strictEqual(result.assets[0].url, videoUrl);
      assert.strictEqual(result.metadata.model, "ltx_2_3_fast");
      assert.strictEqual(result.metadata.provider, "ltx");
    } finally {
      unregisterProviderRunner("ltx");
    }
  });

  it("TEST 8: resolveMediaMetadata defaults to 16:9 when video default is passed", () => {
    const meta = resolveMediaMetadata({ prompt: "Drone shot" }, "16:9");
    assert.strictEqual(meta.aspect_ratio, "16:9");
    assert.strictEqual(meta.width, 1344);
    assert.strictEqual(meta.height, 768);

    const squareMeta = resolveMediaMetadata({ prompt: "Profile picture" });
    assert.strictEqual(squareMeta.aspect_ratio, "1:1");
  });
});

