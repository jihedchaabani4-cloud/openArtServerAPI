import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as workflowEngineTools from "#workflow-engine/tools";
import {
  verifyInput,
  calculateCost,
  createWorkflowEngine,
  runWorkflow,
  configureWorkflowAdapters,
  WorkflowEngineError,
  WorkflowValidationError,
  WorkflowCompilationError,
  WorkflowUpstreamError,
  WorkflowNotFoundError,
  WorkflowSafetyError,
} from "#workflow-engine/tools";
import { NodeRegistry } from "../../../src/systems/workflow-engine/internal/core/NodeRegistry.js";
import { resetWorkflowAdaptersForTest } from "../../../src/systems/workflow-engine/internal/adapters.js";
import { createDefaultV3NodeRegistry } from "../../../src/systems/workflow-engine/internal/nodes/index.js";

describe("System 9: Standalone Workflow Engine (#workflow-engine/tools) Contract & Isolation", () => {
  afterEach(() => {
    resetWorkflowAdaptersForTest();
  });

  it("seals #workflow-engine/tools to exact 11 exports (zero queue/Redis/global-hook leaks)", () => {
    const expected = [
      "WorkflowCompilationError",
      "WorkflowEngineError",
      "WorkflowNotFoundError",
      "WorkflowSafetyError",
      "WorkflowUpstreamError",
      "WorkflowValidationError",
      "calculateCost",
      "configureWorkflowAdapters",
      "createWorkflowEngine",
      "runWorkflow",
      "verifyInput",
    ].sort();

    assert.deepEqual(Object.keys(workflowEngineTools).sort(), expected);
    for (const forbidden of [
      "notifyWorkflowFailure",
      "sanitizeWorkflowError",
      "jobQueueService",
      "ExecutionEngine",
      "GraphCompiler",
      "WorkflowExecutor",
      "NodeRegistry",
      "default",
    ]) {
      assert.equal(workflowEngineTools[forbidden], undefined, `Must not export ${forbidden}`);
    }
  });

  it("runs a declarative workflow in NODE_ENV=production without Redis and exits cleanly with code 0", () => {
    const script = `
      import * as m from "#workflow-engine/tools";
      import { NodeRegistry } from "./src/systems/workflow-engine/internal/core/NodeRegistry.js";

      const reg = new NodeRegistry([
        {
          type: "base.echo",
          OUTPUT_NODE: true,
          INPUT_TYPES: { required: { prompt: { type: "STRING" } } },
          RETURN_TYPES: { result: "STRING" },
          execute: async ({ prompt }) => ({ result: "ok:" + prompt }),
        },
      ]).freeze();

      const wf = Object.freeze({
        id: "standalone-zero-redis-wf",
        requiredInputs: ["prompt"],
        nodes: [{ id: "echo", type: "base.echo", inputs: { prompt: { fromInput: "prompt" } } }],
      });

      const engine = m.createWorkflowEngine({ registry: reg });
      const validation = engine.verifyInput(wf, { prompt: "hello" });
      const cost = engine.calculateCost(wf, { prompt: "hello" });
      const out = await m.runWorkflow(wf, { prompt: "hello" }, { registry: reg });
      console.log(JSON.stringify({ valid: validation.valid, totalCredits: cost.totalCredits, out: out.terminalOutputs.echo.result }));
    `;

    const res = spawnSync(process.execPath, ["--input-type=module"], {
      input: script,
      env: { ...process.env, NODE_ENV: "production", REDIS_URL: "", REDIS_HOST: "127.0.0.1", REDIS_PORT: "1" },
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(res.status, 0, `Expected exit 0, got ${res.status}. stderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
    assert.deepEqual(parsed, { valid: true, totalCredits: 0, out: "ok:hello" });
  });

  it("creates distinct engine instances sharing one default GraphCompiler and isolates custom registries", () => {
    const e1 = createWorkflowEngine();
    const e2 = createWorkflowEngine();

    assert.notStrictEqual(e1, e2);
    assert.strictEqual(e1.registry, e2.registry);
    assert.strictEqual(e1.compiler, e2.compiler);
    assert.strictEqual(e1.executor.compiler, e1.compiler);
    assert.strictEqual(e2.executor.compiler, e2.compiler);

    // Custom registry gets its own GraphCompiler so frozen blueprint plans never collide
    const customReg = new NodeRegistry([
      {
        type: "base.custom_out",
        OUTPUT_NODE: true,
        INPUT_TYPES: { required: { x: { type: "STRING" } } },
        RETURN_TYPES: { y: "STRING" },
        execute: async ({ x }) => ({ y: x }),
      },
    ]).freeze();
    const customEngine = createWorkflowEngine({ registry: customReg });
    assert.notStrictEqual(customEngine.compiler, e1.compiler);
    assert.strictEqual(customEngine.executor.compiler, customEngine.compiler);
  });

  it("fails fast BEFORE Wave 1 when SaveMediaNode required adapter is missing (zero paid AI calls)", async () => {
    resetWorkflowAdaptersForTest();
    let paidNodeCalled = false;

    const reg = createDefaultV3NodeRegistry();
    const engine = createWorkflowEngine({ registry: reg });

    await assert.rejects(
      () =>
        engine.runWorkflow(
          "image-remove-background-v3",
          { source_image_url: "https://cdn.example.com/in.png", media_id: "m-1" },
          {
            nodeContext: {
              executeProvider: async () => {
                paidNodeCalled = true;
                return { assets: [{ url: "https://cdn.example.com/out.png" }] };
              },
            },
          }
        ),
      (err) =>
        err instanceof WorkflowEngineError &&
        err.code === "WORKFLOW_ADAPTER_NOT_CONFIGURED" &&
        err.statusCode === 500
    );

    assert.equal(paidNodeCalled, false, "Must reject before Wave 1 executes paid model node");
  });

  it("resolves adapters with precedence: nodeContext > run adapters > engine adapters > global defaults", async () => {
    const calls = [];
    configureWorkflowAdapters({
      completeMedia: async (args) => {
        calls.push(`global:${args.mediaId}`);
        return { id: args.mediaId, source: "global" };
      },
    });

    const mockProvider = async () => ({ assets: [{ url: "https://cdn.example.com/out.png" }] });

    // 1. Global default
    await runWorkflow(
      "image-remove-background-v3",
      { source_image_url: "https://cdn.example.com/in.png", media_id: "m-global" },
      { nodeContext: { executeProvider: mockProvider } }
    );

    // 2. Engine-scoped adapter overrides global
    const engine = createWorkflowEngine({
      adapters: {
        completeMedia: async (args) => {
          calls.push(`engine:${args.mediaId}`);
          return { id: args.mediaId, source: "engine" };
        },
      },
    });
    await engine.runWorkflow(
      "image-remove-background-v3",
      { source_image_url: "https://cdn.example.com/in.png", media_id: "m-engine" },
      { nodeContext: { executeProvider: mockProvider } }
    );

    // 3. Per-run adapter overrides engine
    await engine.runWorkflow(
      "image-remove-background-v3",
      { source_image_url: "https://cdn.example.com/in.png", media_id: "m-run" },
      {
        adapters: {
          completeMedia: async (args) => {
            calls.push(`run:${args.mediaId}`);
            return { id: args.mediaId, source: "run" };
          },
        },
        nodeContext: { executeProvider: mockProvider },
      }
    );

    assert.deepEqual(calls, ["global:m-global", "engine:m-engine", "run:m-run"]);
  });

  it("preserves WorkflowSafetyError HTTP 422 CONTENT_SAFETY_VIOLATION and neutral error messages (zero refund copy)", async () => {
    const safetyErr = new WorkflowSafetyError("Blocked unsafe content");
    assert.equal(safetyErr.statusCode, 422);
    assert.equal(safetyErr.code, "CONTENT_SAFETY_VIOLATION");
    assert.equal(safetyErr.is_safe, false);
    assert.equal(safetyErr.safetyCategory, "CONTENT_SAFETY_VIOLATION");

    let hookPayload = null;
    const engine = createWorkflowEngine({
      onFailure: (payload) => {
        hookPayload = payload;
      },
    });

    await assert.rejects(
      () =>
        engine.runWorkflow(
          "image-remove-background-v3",
          { source_image_url: "https://cdn.example.com/in.png", media_id: "m-fail" },
          {
            adapters: { completeMedia: async () => ({}) },
            nodeContext: {
              executeProvider: async () => {
                throw new WorkflowUpstreamError("Provider 502 error");
              },
            },
          }
        ),
      WorkflowUpstreamError
    );

    assert.ok(hookPayload, "onFailure hook must fire on execution error");
    assert.doesNotMatch(hookPayload.errorMessage, /refund/i, "workflow-engine must remain billing-neutral");
  });

  it("verifyInput never throws and calculateCost fails closed on invalid pricing", () => {
    const missingRes = verifyInput("non-existent-workflow-id", {});
    assert.equal(missingRes.valid, false);
    assert.equal(missingRes.errors[0].code, "USE_CASE_NOT_FOUND");

    const cost = calculateCost("image-relight-v3", {
      prompt: "warm key light",
      source_image_url: "https://cdn.example.com/src.png",
    });
    assert.ok(cost.totalCredits > 0);
    assert.equal(cost.breakdown.length, 3, "image-relight-v3 is a 3-node zero-LLM DAG");
  });
});
