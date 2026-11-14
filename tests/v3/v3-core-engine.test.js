import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NodeRegistry } from "../../src/systems/generation/internal/v3/core/NodeRegistry.js";
import { GraphCompiler } from "../../src/systems/generation/internal/v3/core/GraphCompiler.js";
import {
  WorkflowExecutor,
  computeNodeSignature,
} from "../../src/systems/generation/internal/v3/core/WorkflowExecutor.js";

function createTestRegistry() {
  const registry = new NodeRegistry();

  registry.register({
    type: "base.prompt_assemble",
    category: "prompt",
    OUTPUT_NODE: false,
    INPUT_TYPES: {
      required: {
        prompt: { type: "STRING" },
      },
      optional: {
        style: { type: "STRING", default: "cinematic" },
      },
    },
    RETURN_TYPES: {
      final_prompt: "STRING",
    },
    estimateCost: () => 0,
    async execute(inputs) {
      return {
        final_prompt: `${inputs.prompt} [${inputs.style}]`,
      };
    },
  });

  registry.register({
    type: "base.image_generate",
    category: "image",
    OUTPUT_NODE: false,
    INPUT_TYPES: {
      required: {
        model: { type: "STRING" },
        prompt: { type: "STRING" },
      },
      optional: {
        count: { type: "INT", default: 1 },
      },
    },
    RETURN_TYPES: {
      image_url: "IMAGE_URL",
      metadata: "JSON",
    },
    retryPolicy: {
      maxAttempts: 3,
      backoffMs: 1,
      retryableCategories: ["UPSTREAM_FAULT", "RATE_LIMIT"],
    },
    estimateCost(plannedInputs) {
      return (plannedInputs.count ?? 1) * 10;
    },
    async execute(inputs) {
      return {
        image_url: `https://cdn.example.com/${inputs.model}.png`,
        metadata: { prompt: inputs.prompt },
      };
    },
  });

  registry.register({
    type: "base.save_media",
    category: "output",
    OUTPUT_NODE: true,
    INPUT_TYPES: {
      required: {
        media_id: { type: "STRING" },
        asset_url: { type: "STRING" },
      },
      optional: {
        final_prompt: { type: "STRING" },
      },
    },
    RETURN_TYPES: {
      saved_media: "JSON",
    },
    estimateCost: () => 0,
    async execute(inputs) {
      return {
        saved_media: {
          id: inputs.media_id,
          url: inputs.asset_url,
          prompt: inputs.final_prompt,
          status: "completed",
        },
      };
    },
  });

  return registry;
}

describe("V3 Core Engine — NodeRegistry, GraphCompiler & WorkflowExecutor", () => {
  describe("NodeRegistry", () => {
    it("registers valid base.* and custom.* nodes and freezes the registry", () => {
      const reg = createTestRegistry();
      assert.equal(reg.has("base.prompt_assemble"), true);
      assert.equal(reg.get("base.save_media").OUTPUT_NODE, true);
      assert.equal(reg.list().length, 3);

      reg.freeze();
      assert.equal(reg.isFrozen(), true);
      assert.throws(() => {
        reg.register({
          type: "custom.extra_node",
          INPUT_TYPES: {},
          RETURN_TYPES: {},
          async execute() {},
        });
      }, /frozen/i);
    });

    it("rejects invalid node names or duplicate registrations", () => {
      const reg = new NodeRegistry();
      assert.throws(() => {
        reg.register({
          type: "invalid_prefix.node",
          INPUT_TYPES: {},
          RETURN_TYPES: {},
          async execute() {},
        });
      }, /Invalid node type/);

      reg.register({
        type: "base.valid_node",
        INPUT_TYPES: {},
        RETURN_TYPES: {},
        async execute() {},
      });

      assert.throws(() => {
        reg.register({
          type: "base.valid_node",
          INPUT_TYPES: {},
          RETURN_TYPES: {},
          async execute() {},
        });
      }, /already registered/);
    });
  });

  describe("GraphCompiler", () => {
    it("prunes dead/disconnected nodes backward from OUTPUT_NODE: true and estimates cost", () => {
      const reg = createTestRegistry();
      const compiler = new GraphCompiler(reg);

      const workflow = {
        id: "test-pruning-v3",
        nodes: [
          {
            id: "prompt_node",
            type: "base.prompt_assemble",
            inputs: {
              prompt: { fromInput: "prompt" },
            },
          },
          {
            id: "active_gen",
            type: "base.image_generate",
            inputs: {
              model: { fromInput: "model" },
              prompt: { fromNode: "prompt_node", output: "final_prompt" },
              count: 2,
            },
          },
          {
            id: "dead_expensive_gen",
            type: "base.image_generate",
            inputs: {
              model: "flux-pro",
              prompt: "unused branch",
              count: 5,
            },
          },
          {
            id: "save_out",
            type: "base.save_media",
            inputs: {
              media_id: { fromInput: "media_id" },
              asset_url: { fromNode: "active_gen", output: "image_url" },
              final_prompt: { fromNode: "prompt_node", output: "final_prompt" },
            },
          },
        ],
      };

      const plan = compiler.compile(workflow, {
        prompt: "cyberpunk samurai",
        model: "flux-schnell",
        media_id: "media-1",
      });

      assert.deepEqual(plan.activeNodeIds, ["prompt_node", "active_gen", "save_out"]);
      assert.equal(plan.activeNodeIds.includes("dead_expensive_gen"), false);
      // Only active_gen (count: 2 -> 20 credits) should be billed, NOT dead_expensive_gen (50 credits)
      assert.equal(plan.totalEstimatedCredits, 20);
      assert.deepEqual(plan.costBreakdown, [
        { nodeId: "active_gen", type: "base.image_generate", credits: 20 },
      ]);
    });

    it("detects circular dependencies and throws GenerationCompilationError", () => {
      const reg = createTestRegistry();
      const compiler = new GraphCompiler(reg);

      const cyclicWorkflow = {
        id: "cyclic-v3",
        nodes: [
          {
            id: "node_a",
            type: "base.prompt_assemble",
            inputs: {
              prompt: { fromNode: "node_b", output: "final_prompt" },
            },
          },
          {
            id: "node_b",
            type: "base.prompt_assemble",
            inputs: {
              prompt: { fromNode: "node_a", output: "final_prompt" },
            },
          },
          {
            id: "save",
            type: "base.save_media",
            inputs: {
              media_id: "m1",
              asset_url: { fromNode: "node_a", output: "final_prompt" },
            },
          },
        ],
      };

      assert.throws(() => compiler.compile(cyclicWorkflow), /Circular dependency detected/);
    });

    it("rejects workflows without any OUTPUT_NODE or with invalid output ports", () => {
      const reg = createTestRegistry();
      const compiler = new GraphCompiler(reg);

      assert.throws(
        () =>
          compiler.compile({
            id: "no-output-v3",
            nodes: [
              {
                id: "p1",
                type: "base.prompt_assemble",
                inputs: { prompt: "hello" },
              },
            ],
          }),
        /has no OUTPUT_NODE/
      );

      assert.throws(
        () =>
          compiler.compile({
            id: "bad-port-v3",
            nodes: [
              {
                id: "p1",
                type: "base.prompt_assemble",
                inputs: { prompt: "hello" },
              },
              {
                id: "save",
                type: "base.save_media",
                inputs: {
                  media_id: "m1",
                  asset_url: { fromNode: "p1", output: "non_existent_port" },
                },
              },
            ],
          }),
        /does not produce output "non_existent_port"/
      );
    });

    it("resolves nested dot-paths (e.g. parameters.count) via getValueByPath in estimateCost", () => {
      const reg = createTestRegistry();
      const compiler = new GraphCompiler(reg);

      const workflow = {
        id: "nested-path-v3",
        nodes: [
          {
            id: "gen",
            type: "base.image_generate",
            inputs: {
              model: { fromInput: "parameters.model" },
              prompt: { fromInput: "prompt" },
              count: { fromInput: "parameters.count", default: 1 },
            },
          },
          {
            id: "save",
            type: "base.save_media",
            inputs: {
              media_id: { fromInput: "media_id" },
              asset_url: { fromNode: "gen", output: "image_url" },
            },
          },
        ],
      };

      const plan = compiler.compile(workflow, {
        prompt: "nested test",
        media_id: "m-nested",
        parameters: {
          model: "flux-pro",
          count: 4,
        },
      });

      assert.equal(plan.totalEstimatedCredits, 40);
    });
  });

  describe("WorkflowExecutor", () => {
    it("executes parallel waves, caches non-output nodes by SHA-256 signature, and always runs OUTPUT_NODEs", async () => {
      const reg = new NodeRegistry();
      let genCalls = 0;
      let saveCalls = 0;

      reg.register({
        type: "base.prompt_assemble",
        OUTPUT_NODE: false,
        INPUT_TYPES: { required: { prompt: { type: "STRING" } } },
        RETURN_TYPES: { final_prompt: "STRING" },
        async execute(inputs) {
          return { final_prompt: inputs.prompt.toUpperCase() };
        },
      });

      reg.register({
        type: "base.image_generate",
        OUTPUT_NODE: false,
        INPUT_TYPES: {
          required: {
            model: { type: "STRING" },
            prompt: { type: "STRING" },
          },
        },
        RETURN_TYPES: { image_url: "IMAGE_URL" },
        async execute(inputs) {
          genCalls++;
          return { image_url: `https://cdn.test/${inputs.model}/${genCalls}.png` };
        },
      });

      reg.register({
        type: "base.save_media",
        OUTPUT_NODE: true,
        INPUT_TYPES: {
          required: {
            media_id: { type: "STRING" },
            asset_url: { type: "STRING" },
          },
        },
        RETURN_TYPES: { saved_media: "JSON" },
        async execute(inputs) {
          saveCalls++;
          return { saved_media: { id: inputs.media_id, url: inputs.asset_url } };
        },
      });

      const executor = new WorkflowExecutor(reg);
      const workflow = {
        id: "cache-test-v3",
        nodes: [
          {
            id: "branch_a",
            type: "base.prompt_assemble",
            inputs: { prompt: { fromInput: "prompt" } },
          },
          {
            id: "branch_b",
            type: "base.prompt_assemble",
            inputs: { prompt: { fromInput: "prompt" } },
          },
          {
            id: "gen",
            type: "base.image_generate",
            inputs: {
              model: "flux",
              prompt: { fromNode: "branch_a", output: "final_prompt" },
            },
          },
          {
            id: "save",
            type: "base.save_media",
            inputs: {
              media_id: { fromInput: "media_id" },
              asset_url: { fromNode: "gen", output: "image_url" },
            },
          },
        ],
      };

      const run1 = await executor.execute({
        workflow,
        input: { prompt: "sunset beach", media_id: "m-1" },
      });
      assert.equal(run1.status, "completed");
      assert.equal(genCalls, 1);
      assert.equal(saveCalls, 1);
      assert.equal(run1.terminalOutputs.save.saved_media.url, "https://cdn.test/flux/1.png");

      // Second execution with identical prompt/model inputs hits SHA-256 cache for prompt & gen,
      // but still executes OUTPUT_NODE (`save`)
      const run2 = await executor.execute({
        workflow,
        input: { prompt: "sunset beach", media_id: "m-2" },
      });
      assert.equal(genCalls, 1, "image_generate should be served from SHA-256 cache");
      assert.equal(saveCalls, 2, "OUTPUT_NODE must never be skipped by cache");
      assert.deepEqual(run2.cacheHits.sort(), ["branch_a", "gen"]);
      assert.equal(run2.terminalOutputs.save.saved_media.id, "m-2");
    });

    it("retries transient upstream errors according to node retryPolicy and fails immediately on USER_FAULT", async () => {
      const reg = new NodeRegistry();
      let attempts = 0;

      reg.register({
        type: "base.video_generate",
        OUTPUT_NODE: false,
        INPUT_TYPES: {
          required: { prompt: { type: "STRING" } },
        },
        RETURN_TYPES: { video_url: "VIDEO_URL" },
        retryPolicy: {
          maxAttempts: 3,
          backoffMs: 1,
          retryableCategories: ["UPSTREAM_FAULT", "RATE_LIMIT"],
        },
        async execute() {
          attempts++;
          if (attempts < 3) {
            const err = new Error("Provider rate limit");
            err.category = "RATE_LIMIT";
            throw err;
          }
          return { video_url: "https://cdn.test/video.mp4" };
        },
      });

      reg.register({
        type: "base.save_media",
        OUTPUT_NODE: true,
        INPUT_TYPES: {
          required: {
            media_id: { type: "STRING" },
            asset_url: { type: "STRING" },
          },
        },
        RETURN_TYPES: { saved_media: "JSON" },
        async execute(inputs) {
          return { saved_media: inputs };
        },
      });

      const executor = new WorkflowExecutor(reg, { sleepFn: async () => {} });
      const res = await executor.execute({
        workflow: {
          id: "retry-v3",
          nodes: [
            { id: "vid", type: "base.video_generate", inputs: { prompt: "ocean waves" } },
            {
              id: "save",
              type: "base.save_media",
              inputs: {
                media_id: "m-vid",
                asset_url: { fromNode: "vid", output: "video_url" },
              },
            },
          ],
        },
      });

      assert.equal(attempts, 3);
      assert.equal(res.terminalOutputs.save.saved_media.asset_url, "https://cdn.test/video.mp4");

      // Deterministic signature check
      const sig1 = computeNodeSignature("base.video_generate", { b: 2, a: 1 });
      const sig2 = computeNodeSignature("base.video_generate", { a: 1, b: 2 });
      assert.equal(sig1, sig2);
    });
  });
});
