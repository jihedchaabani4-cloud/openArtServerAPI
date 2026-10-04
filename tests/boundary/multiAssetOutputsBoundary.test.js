import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { executeNodePersistence } from "../../src/v2/runner/nodeExecutor.js";
import { db } from "../../src/container.js";
import { calculateCost } from "../../src/models/index.js";
import { calculateWorkflowBillingPlan } from "../../src/use-cases/workflowBillingPlan.js";
import * as imageController from "../../controllers/imageController.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";

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
    const { calculateRetailCredits } = await import("../../src/models/pricing/pricingEngine.js");
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
    const { useCaseService } = await import("../../src/container.js");
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
