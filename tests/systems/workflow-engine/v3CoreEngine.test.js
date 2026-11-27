import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NodeRegistry } from "../../../src/systems/workflow-engine/internal/core/NodeRegistry.js";
import { GraphCompiler } from "../../../src/systems/workflow-engine/internal/core/GraphCompiler.js";
import {
  WorkflowExecutor,
  computeNodeSignature,
} from "../../../src/systems/workflow-engine/internal/core/WorkflowExecutor.js";
import {
  JobExecutionContext,
  createJobExecutionContext,
} from "../../../src/systems/workflow-engine/internal/core/JobExecutionContext.js";
import { createDefaultV3NodeRegistry } from "../../../src/systems/workflow-engine/internal/nodes/index.js";

function createTestRegistry() {
  const registry = new NodeRegistry();

  registry.register({
    type: "base.resolve_references",
    category: "context",
    OUTPUT_NODE: false,
    INPUT_TYPES: {
      required: {
        prompt: { type: "STRING" },
      },
      optional: {},
    },
    RETURN_TYPES: {
      prepared_prompt: "STRING",
    },
    estimateCost: () => 0,
    async execute(inputs) {
      return {
        prepared_prompt: inputs.prompt,
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
      assert.equal(reg.has("base.resolve_references"), true);
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
    it("prunes dead/disconnected nodes backward from OUTPUT_NODE: true and builds waves", () => {
      const reg = createTestRegistry();
      const compiler = new GraphCompiler(reg);

      const workflow = {
        id: "test-pruning-v3",
        nodes: [
          {
            id: "prompt_node",
            type: "base.resolve_references",
            inputs: {
              prompt: { fromInput: "prompt" },
            },
          },
          {
            id: "active_gen",
            type: "base.image_generate",
            inputs: {
              model: { fromInput: "model" },
              prompt: { fromNode: "prompt_node", output: "prepared_prompt" },
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
              final_prompt: { fromNode: "prompt_node", output: "prepared_prompt" },
            },
          },
        ],
      };

      const plan = compiler.compile(workflow);

      assert.deepEqual(plan.activeNodeIds, ["prompt_node", "active_gen", "save_out"]);
      assert.equal(plan.activeNodeIds.includes("dead_expensive_gen"), false);
      assert.deepEqual(plan.waves, [["prompt_node"], ["active_gen"], ["save_out"]]);
    });

    it("detects circular dependencies and throws GenerationCompilationError", () => {
      const reg = createTestRegistry();
      const compiler = new GraphCompiler(reg);

      const cyclicWorkflow = {
        id: "cyclic-v3",
        nodes: [
          {
            id: "node_a",
            type: "base.resolve_references",
            inputs: {
              prompt: { fromNode: "node_b", output: "prepared_prompt" },
            },
          },
          {
            id: "node_b",
            type: "base.resolve_references",
            inputs: {
              prompt: { fromNode: "node_a", output: "prepared_prompt" },
            },
          },
          {
            id: "save",
            type: "base.save_media",
            inputs: {
              media_id: "m1",
              asset_url: { fromNode: "node_a", output: "prepared_prompt" },
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
                type: "base.resolve_references",
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
                type: "base.resolve_references",
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
  });

  describe("JobExecutionContext & NodeRegistry CACHEABLE contracts", () => {
    it("creates isolated frozen identity, tracks lifecycle state, and clears cache on dispose()", () => {
      const ctx = createJobExecutionContext({
        jobId: "job-100",
        userId: "user-100",
        blueprintId: "image-generation-v3",
        workflowId: "wf-100",
      });

      assert.ok(ctx instanceof JobExecutionContext);
      assert.ok(ctx.identity.executionId);
      assert.equal(ctx.identity.runId, ctx.identity.executionId);
      assert.equal(ctx.identity.jobId, "job-100");
      assert.equal(ctx.identity.userId, "user-100");
      assert.equal(ctx.identity.blueprintId, "image-generation-v3");
      assert.equal(ctx.identity.workflowId, "wf-100");
      assert.equal(Object.isFrozen(ctx.identity), true);

      assert.equal(ctx.state.status, "created");
      ctx.markRunning();
      assert.equal(ctx.state.status, "running");
      assert.ok(ctx.state.startedAt);
      ctx.markCompleted();
      assert.equal(ctx.state.status, "completed");
      assert.ok(ctx.state.finishedAt);
      assert.equal(ctx.state.error, null);

      const err = new Error("boom");
      ctx.markFailed(err);
      assert.equal(ctx.state.status, "failed");
      assert.equal(ctx.state.error, err);

      ctx.cache.set("sig-1", { value: 1 });
      assert.equal(ctx.cache.size, 1);
      ctx.dispose();
      assert.equal(ctx.cache.size, 0);
    });

    it("enforces CACHEABLE: false on base.image_generate, base.video_generate, base.llm in default registry", () => {
      const defaultReg = createDefaultV3NodeRegistry();
      assert.equal(defaultReg.get("base.image_generate").CACHEABLE, false);
      assert.equal(defaultReg.get("base.video_generate").CACHEABLE, false);
      assert.equal(defaultReg.get("base.llm").CACHEABLE, false);
      assert.equal(defaultReg.get("base.save_media").CACHEABLE, false);
      assert.equal(defaultReg.get("base.resolve_references").CACHEABLE, true);
    });
    it("caches compiled plans for frozen workflows returning identical plan in O(1)", () => {
      const reg = createTestRegistry();
      const compiler = new GraphCompiler(reg);
      const frozenWf = Object.freeze({
        id: "frozen-test-wf",
        nodes: Object.freeze([
          Object.freeze({
            id: "out",
            type: "base.save_media",
            inputs: { media_id: "m1", asset_url: "https://example.com/asset.png" },
          }),
        ]),
      });

      const plan1 = compiler.compile(frozenWf);
      const plan2 = compiler.compile(frozenWf);
      assert.strictEqual(plan1, plan2, "Compiled plan must be cached and returned as identical reference in O(1)");
    });
  });

  describe("WorkflowExecutor", () => {
    it("isolates per-run cache (zero shared executor.cache, zero cross-run cache hits), enforces CACHEABLE: false, and clears cache in finally", async () => {
      const reg = new NodeRegistry();
      let resolveCalls = 0;
      let genCalls = 0;
      let saveCalls = 0;

      reg.register({
        type: "base.resolve_references",
        OUTPUT_NODE: false,
        CACHEABLE: true,
        INPUT_TYPES: { required: { prompt: { type: "STRING" } } },
        RETURN_TYPES: { prepared_prompt: "STRING" },
        async execute(inputs) {
          resolveCalls++;
          return { prepared_prompt: inputs.prompt.toUpperCase() };
        },
      });

      reg.register({
        type: "base.image_generate",
        OUTPUT_NODE: false,
        CACHEABLE: false,
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
      assert.equal("cache" in executor, false, "WorkflowExecutor must NOT hold process-global this.cache");

      const workflow = {
        id: "isolated-cache-test-v3",
        nodes: [
          {
            id: "branch_a",
            type: "base.resolve_references",
            inputs: { prompt: { fromInput: "prompt" } },
          },
          {
            id: "gen",
            type: "base.image_generate",
            inputs: {
              model: "flux",
              prompt: { fromNode: "branch_a", output: "prepared_prompt" },
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

      const jobCtx1 = createJobExecutionContext({ userId: "user-1", blueprintId: workflow.id });
      const run1 = await executor.execute({
        workflow,
        input: { prompt: "sunset beach", media_id: "m-1" },
        jobContext: jobCtx1,
      });
      assert.equal(run1.status, "completed");
      assert.equal(resolveCalls, 1);
      assert.equal(genCalls, 1);
      assert.equal(saveCalls, 1);
      assert.equal(run1.terminalOutputs.save.saved_media.url, "https://cdn.test/flux/1.png");
      assert.equal(jobCtx1.cache.size, 0, "Per-run JobExecutionContext cache must be cleared in finally");

      // Second independent run with identical prompt MUST NOT hit run1's cache
      const jobCtx2 = createJobExecutionContext({ userId: "user-1", blueprintId: workflow.id });
      const run2 = await executor.execute({
        workflow,
        input: { prompt: "sunset beach", media_id: "m-2" },
        jobContext: jobCtx2,
      });
      assert.equal(resolveCalls, 2, "resolve_references must run fresh in an independent execution");
      assert.equal(genCalls, 2, "generative node must execute fresh on every run (0 cross-run cache hits)");
      assert.equal(saveCalls, 2, "OUTPUT_NODE must execute on every run");
      assert.deepEqual(run2.cacheHits, []);
      assert.equal(run2.terminalOutputs.save.saved_media.url, "https://cdn.test/flux/2.png");
      assert.equal(run2.terminalOutputs.save.saved_media.id, "m-2");
      assert.equal(jobCtx2.cache.size, 0, "Per-run cache cleared in finally on run2");

      // Even with an explicit shared signatureCache, CACHEABLE: false nodes must NEVER return cached output
      const sharedCache = new Map();
      const explicit1 = await executor.execute({
        workflow,
        input: { prompt: "sunset beach", media_id: "m-3" },
        context: { runId: "same-run", userId: "user-1" },
        signatureCache: sharedCache,
      });
      const explicit2 = await executor.execute({
        workflow,
        input: { prompt: "sunset beach", media_id: "m-4" },
        context: { runId: "same-run", userId: "user-1" },
        signatureCache: sharedCache,
      });
      assert.equal(resolveCalls, 3, "cacheable node reused inside explicit same-scope signatureCache");
      assert.equal(genCalls, 4, "CACHEABLE: false generative node must NEVER be served from cache");
      assert.deepEqual(explicit2.cacheHits, ["branch_a"]);
      assert.notEqual(explicit1.terminalOutputs.save.saved_media.url, explicit2.terminalOutputs.save.saved_media.url);

      // Scoped signatures prevent cross-tenant and cross-run collisions
      const sigUserA = computeNodeSignature("base.resolve_references", { prompt: "hi" }, { runId: "r1", userId: "user-A" });
      const sigUserB = computeNodeSignature("base.resolve_references", { prompt: "hi" }, { runId: "r1", userId: "user-B" });
      const sigRun2 = computeNodeSignature("base.resolve_references", { prompt: "hi" }, { runId: "r2", userId: "user-A" });
      assert.notEqual(sigUserA, sigUserB);
      assert.notEqual(sigUserA, sigRun2);
    });

    it("executes nodes fail-fast (single attempt, tags error.nodeId, and stops downstream waves on error)", async () => {
      const reg = new NodeRegistry();
      let step1Calls = 0;
      let step2Calls = 0;

      reg.register({
        type: "base.step_one",
        OUTPUT_NODE: false,
        CACHEABLE: false,
        INPUT_TYPES: { required: { prompt: { type: "STRING" } } },
        RETURN_TYPES: { text: "STRING" },
        async execute() {
          step1Calls++;
          const err = new Error("Upstream rate limit");
          err.category = "RATE_LIMIT";
          err.retryable = true;
          throw err;
        },
      });

      reg.register({
        type: "base.step_two",
        OUTPUT_NODE: true,
        CACHEABLE: false,
        INPUT_TYPES: { required: { text: { type: "STRING" } } },
        RETURN_TYPES: { saved: "STRING" },
        async execute(inputs) {
          step2Calls++;
          return { saved: inputs.text };
        },
      });

      const executor = new WorkflowExecutor(reg);
      const wf = {
        id: "fail-fast-v3",
        nodes: [
          { id: "n1", type: "base.step_one", inputs: { prompt: "hello" } },
          { id: "n2", type: "base.step_two", inputs: { text: { fromNode: "n1", output: "text" } } },
        ],
      };

      await assert.rejects(
        () => executor.execute({ workflow: wf, input: {} }),
        (err) => {
          assert.equal(err.message, "Upstream rate limit");
          assert.equal(err.nodeId, "n1");
          return true;
        }
      );
      assert.equal(step1Calls, 1, "Failed node must execute exactly once without retries");
      assert.equal(step2Calls, 0, "Downstream node must never execute once upstream fails");

      const sig1 = computeNodeSignature("base.step_one", { b: 2, a: 1 });
      const sig2 = computeNodeSignature("base.step_one", { a: 1, b: 2 });
      assert.equal(sig1, sig2);
    });
  });
});
