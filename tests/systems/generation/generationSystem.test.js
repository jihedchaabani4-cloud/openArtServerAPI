import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as generationToolsNamespace from "#generation/tools";
import {
    WorkflowDispatchService,
    GenerationService,
    GenerationRequestService,
    WorkflowService,
    WorkflowRepository,
    configureGeneration,
    startGenerationWorker,
} from "#generation/tools";
import { JobExecutionContext, createJobExecutionContext } from "../../../src/systems/workflow-engine/internal/core/JobExecutionContext.js";
import { GraphCompiler } from "../../../src/systems/workflow-engine/internal/core/GraphCompiler.js";
import { WorkflowExecutor } from "../../../src/systems/workflow-engine/internal/core/WorkflowExecutor.js";
import { NodeRegistry } from "../../../src/systems/workflow-engine/internal/core/NodeRegistry.js";
import { createDefaultV3NodeRegistry } from "../../../src/systems/workflow-engine/internal/nodes/index.js";
import { V3_WORKFLOWS, getV3Workflow, imageGenerationV3, videoGenerationV3, characterSheetV3 } from "../../../src/systems/workflow-engine/internal/workflows/index.js";
import {
    GenerationError,
    GenerationValidationError,
    GenerationNotFoundError,
    GenerationCompilationError,
    GenerationQueueDispatchError,
} from "../../../src/systems/generation/internal/errors.js";
import { sendGenerationControllerError } from "../../../src/systems/generation/internal/controllers/generationControllerHelpers.js";
import * as generationApiNamespace from "#generation/api";
import { imagesRouter, videoRouter, v2WorkflowsRouter, workflowsRouter } from "#generation/api";
import apiRouter from "../../../src/api/routes.js";
import express from "express";
import http from "node:http";
import { supabase } from "#shared/db/supabase.js";
import { execSync } from "node:child_process";

// ─── Source: generationSystem.test.js ───
{
/**
 * Generation & Workflows System (System 1) — Unit & Gateway Contract Tests
 *
 * Verifies System 1 Generation (#generation/api, #generation/tools) boundaries,
 * typed errors, DTO contracts, and V3 workflow engine.
 */

describe("System 1: Generation & Workflows — Gateways & Public Tools Contract", () => {
    it("seals #generation/api and #generation/tools to exact production surface (zero handler leaks or internal V3 exports)", () => {
        const expectedApiExports = [
            "imagesRouter",
            "v2WorkflowsRouter",
            "videoRouter",
            "workflowsRouter",
        ].sort();
        const expectedToolsExports = [
            "GenerationRequestService",
            "GenerationService",
            "WorkflowDispatchService",
            "WorkflowRepository",
            "WorkflowService",
            "configureGeneration",
            "startGenerationWorker",
        ].sort();

        assert.deepEqual(Object.keys(generationApiNamespace).sort(), expectedApiExports);
        assert.deepEqual(Object.keys(generationToolsNamespace).sort(), expectedToolsExports);

        for (const forbiddenApi of [
            "generationRouter",
            "generateImage",
            "relightImage",
            "changeImageAngle",
            "removeImageBackground",
            "editImage",
            "generateVideo",
            "getProjectData",
            "deleteItem",
            "toggleItemLike",
            "deleteWorkflow",
            "bulkDeleteWorkflows",
            "setPrimaryMedia",
            "deleteMedia",
            "default",
        ]) {
            assert.equal(
                generationApiNamespace[forbiddenApi],
                undefined,
                `#generation/api must not export ${forbiddenApi}`
            );
        }

        for (const forbiddenTool of [
            "ExecutionEngine",
            "jobQueueService",
            "JobExecutionContext",
            "createJobExecutionContext",
            "GraphCompiler",
            "WorkflowExecutor",
            "NodeRegistry",
            "workflowRepository",
            "default",
        ]) {
            assert.equal(
                generationToolsNamespace[forbiddenTool],
                undefined,
                `#generation/tools must not export ${forbiddenTool}`
            );
        }
    });

    it("should export all expected V3 public tools and domain services", () => {
        assert.equal(typeof WorkflowDispatchService, "function");
        assert.equal(typeof JobExecutionContext, "function");
        assert.equal(typeof createJobExecutionContext, "function");
        assert.equal(typeof WorkflowService, "function");
        assert.equal(typeof GenerationService, "function");
        assert.equal(typeof GenerationRequestService, "function");
        assert.equal(typeof WorkflowRepository, "function");
        assert.equal(typeof configureGeneration, "function");
        assert.equal(typeof startGenerationWorker, "function");
    });

    it("should export valid Express routers from #generation/api", () => {
        assert.equal(typeof imagesRouter, "function");
        assert.equal(typeof videoRouter, "function");
        assert.equal(typeof v2WorkflowsRouter, "function");
        assert.equal(typeof workflowsRouter, "function");

        assert.ok(Array.isArray(imagesRouter.stack));
        assert.ok(Array.isArray(videoRouter.stack));
        assert.ok(Array.isArray(v2WorkflowsRouter.stack));
        assert.ok(Array.isArray(workflowsRouter.stack));
    });

    it("rejects malformed or PostgREST-injection cursor values in WorkflowRepository.listProjectAssets", async () => {
        const orCalls = [];
        const mockBuilder = {
            select() { return this; },
            eq() { return this; },
            in() { return this; },
            not() { return this; },
            is() { return this; },
            or(expr) { orCalls.push(expr); return this; },
            order() { return this; },
            limit() { return this; },
            then(resolve) { return resolve({ data: [], error: null }); },
        };
        const mockClient = { from: () => mockBuilder };
        const repo = new WorkflowRepository(mockClient);

        // Injection attempt in createTime
        await assert.rejects(
            () => repo.listProjectAssets("proj-1", {
                cursor: { createTime: "2026-01-01T00:00:00Z,id.gt.0", id: "wf-1" },
            }),
            (err) => err instanceof GenerationValidationError && err.statusCode === 400
        );

        // Injection attempt in id
        await assert.rejects(
            () => repo.listProjectAssets("proj-1", {
                cursor: { createTime: "2026-01-01T00:00:00.000Z", id: "wf-1),project_id.neq.0" },
            }),
            (err) => err instanceof GenerationValidationError && err.statusCode === 400
        );

        // Valid ISO-8601 timestamp + safe id succeeds and passes sanitized .or() filter
        await repo.listProjectAssets("proj-1", {
            cursor: { createTime: "2026-01-01T12:30:00.123Z", id: "wf_123-abc" },
        });
        assert.equal(orCalls.length, 1);
        assert.equal(
            orCalls[0],
            "create_time.lt.2026-01-01T12:30:00.123Z,and(create_time.eq.2026-01-01T12:30:00.123Z,id.lt.wf_123-abc)"
        );
    });

    it("masks raw Redis/internal error messages on HTTP 503 QUEUE_DISPATCH_FAILED responses", () => {
        let statusCode = 200;
        let payload = null;
        const res = {
            status(code) { statusCode = code; return res; },
            json(body) { payload = body; return res; },
        };
        const err = new GenerationQueueDispatchError(
            "Failed to enqueue workflow: ECONNREFUSED 10.0.0.5:6379 ioredis cluster down"
        );
        err.workflowId = "wf-503";
        err.mediaId = "m-503";
        err.mediaIds = ["m-503"];

        sendGenerationControllerError(res, err, {
            logger: { error() {} },
            actionName: "generateImage",
            fallbackMessage: "Failed to generate image",
        });

        assert.equal(statusCode, 503);
        assert.equal(payload.ok, false);
        assert.equal(payload.code, "QUEUE_DISPATCH_FAILED");
        assert.equal(payload.workflowId, "wf-503");
        assert.equal(payload.mediaId, "m-503");
        assert.doesNotMatch(payload.message, /ECONNREFUSED|10\.0\.0\.5|ioredis|redis/i);
    });

    it("should enforce Generation typed error hierarchy", () => {
        const baseErr = new GenerationError("generic", 500);
        assert.equal(baseErr.statusCode, 500);
        assert.equal(baseErr.errorCode, "GENERATION_ERROR");

        const valErr = new GenerationValidationError("invalid parameter", { field: "prompt" });
        assert.equal(valErr.statusCode, 400);
        assert.equal(valErr.errorCode, "GENERATION_VALIDATION_ERROR");
        assert.equal(valErr.field, "prompt");

        const notFoundErr = new GenerationNotFoundError("workflow missing", { resourceId: "wf-1" });
        assert.equal(notFoundErr.statusCode, 404);
        assert.equal(notFoundErr.errorCode, "GENERATION_NOT_FOUND");
        assert.equal(notFoundErr.resourceId, "wf-1");

        const compErr = new GenerationCompilationError("compilation failed", { errors: ["node missing"] });
        assert.equal(compErr.statusCode, 422);
        assert.equal(compErr.errorCode, "COMPILATION_FAILED");
        assert.deepEqual(compErr.errors, ["node missing"]);

        const queueErr = new GenerationQueueDispatchError("dispatch failed", { attempts: 3 });
        assert.equal(queueErr.statusCode, 503);
        assert.equal(queueErr.errorCode, "QUEUE_DISPATCH_FAILED");
        assert.equal(queueErr.attempts, 3);
    });
});
}

// ─── Source: apiRoutingBoundary.test.js ───
{
describe("Generation API Boundary & Separation Tests", () => {

  it("TEST 1: API Router mounts /images and /video on separate, independent routers", () => {
    // Find route layers mounted on apiRouter
    const layers = apiRouter.stack.filter((layer) => layer.name === "router");
    
    // Find image layer and video layer
    const imageLayer = layers.find((l) => l.regexp.test("/images"));
    const videoLayer = layers.find((l) => l.regexp.test("/video"));

    assert.ok(imageLayer, "apiRouter must mount /images");
    assert.ok(videoLayer, "apiRouter must mount /video");

    // Strictly separate instances: videoRouter !== imagesRouter
    assert.notStrictEqual(
      imageLayer.handle,
      videoLayer.handle,
      "Video router must NOT be an alias of imagesRouter (router.use('/video', imagesRouter) is forbidden)"
    );
    assert.strictEqual(imageLayer.handle, imagesRouter, "images router must be imagesRouter");
    assert.strictEqual(videoLayer.handle, videoRouter, "video router must be videoRouter");
  });

  it("TEST 2: imagesRouter exposes ONLY /generated, /relight, /angles, /remove-background, and /edit endpoints without legacy aliases", () => {
    const registeredRoutes = imagesRouter.stack
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));

    assert.strictEqual(
      registeredRoutes.length,
      5,
      "imagesRouter must have exactly 5 routes: /generated, /relight, /angles, /remove-background, /edit"
    );
    assert.deepStrictEqual(
      registeredRoutes.map((r) => r.path),
      ["/generated", "/relight", "/angles", "/remove-background", "/edit"]
    );
    for (const route of registeredRoutes) {
      assert.ok(route.methods.includes("post"), `imagesRouter ${route.path} must accept POST`);
    }

    // Verify removed aliases do NOT exist
    const forbiddenPaths = [
      "/generated/edit/existing",
      "/generated/edit/new",
      "/motion",
      "/extend",
    ];
    for (const p of forbiddenPaths) {
      assert.ok(
        !registeredRoutes.some((r) => r.path === p),
        `imagesRouter must NOT contain alias "${p}"`
      );
    }
  });

  it("TEST 3: videoRouter exposes ONLY /generated endpoint without aliases", () => {
    const registeredRoutes = videoRouter.stack
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));

    assert.strictEqual(registeredRoutes.length, 1, "videoRouter must have exactly 1 route: /generated");
    assert.strictEqual(registeredRoutes[0].path, "/generated");
    assert.ok(registeredRoutes[0].methods.includes("post"));

    // Verify removed aliases do NOT exist
    const forbiddenPaths = [
      "/edit",
      "/motion",
      "/extend",
    ];
    for (const p of forbiddenPaths) {
      assert.ok(
        !registeredRoutes.some((r) => r.path === p),
        `videoRouter must NOT contain alias "${p}"`
      );
    }
  });

  it("TEST 4: Independent V3 Workflows registered for Image and Video generation flows", () => {
    const imageWf = getV3Workflow("image-generation-v3");
    const videoWf = getV3Workflow("video-generation-v3");

    assert.ok(imageWf, "image-generation-v1 must resolve in V3 Workflow Registry");
    assert.strictEqual(imageWf.id, "image-generation-v3");

    assert.ok(videoWf, "video-generation-v1 must resolve in V3 Workflow Registry");
    assert.strictEqual(videoWf.id, "video-generation-v3");

    // Distinct workflows
    assert.notStrictEqual(
      imageWf.id,
      videoWf.id,
      "Image and Video must have distinct V3 workflows"
    );
  });

  it("TEST 5: Image Generation V3 Workflow GraphCompiler compiles active nodes and waves", async () => {
    const compiler = new GraphCompiler(createDefaultV3NodeRegistry());
    const plan = compiler.compile(getV3Workflow("image-generation-v3"));

    assert.ok(plan, "Execution plan must compile successfully");
    assert.strictEqual(plan.workflowId, "image-generation-v3");
    assert.ok(Array.isArray(plan.activeNodeIds) && plan.activeNodeIds.length === 4);
    assert.ok(Array.isArray(plan.waves) && plan.waves.length >= 4);
  });

  it("TEST 6: Video Generation V3 Workflow compiles cleanly into waves", async () => {
    const compiler = new GraphCompiler(createDefaultV3NodeRegistry());
    const plan = compiler.compile(getV3Workflow("video-generation-v3"));

    assert.ok(plan, "Video execution plan must compile successfully");
    assert.strictEqual(plan.workflowId, "video-generation-v3");
    assert.ok(Array.isArray(plan.activeNodeIds) && plan.activeNodeIds.length === 4);
    assert.ok(Array.isArray(plan.waves) && plan.waves.length >= 4);
  });

  it("TEST 7: LlmNode.estimateCost handles LLM node inputs with skills without capability error", async () => {
    const { LlmNode } = await import("../../../src/systems/workflow-engine/internal/nodes/index.js");

    const cost = LlmNode.estimateCost({
      model: "gemini-3-flash",
      prompt: "cat",
      skills: ["system-safety", "translate"],
    });
    assert.strictEqual(cost, 1, "gemini_3_flash LLM node billing should be 1 credit without parameter errors");
  });
});
}

// ─── Source: v2WorkflowRunBoundary.test.js ───
{
describe("V2 Workflow Run Security & Boundary Tests (Task T3)", () => {
  let server;
  let baseUrl;
  let origGetUser;
  const testSecret = "test-internal-secret-phase0-t3"; // gate:allow-secret
  const originalSecret = process.env.INTERNAL_SECRET;
  const originalFlag = process.env.ENABLE_V2_WORKFLOW_RUN_ENDPOINT;

  before(async () => {
    process.env.INTERNAL_SECRET = testSecret;
    origGetUser = supabase.auth.getUser;
    supabase.auth.getUser = async (token) => {
      if (token && token.startsWith("token-")) {
        const userId = token.replace("token-", "");
        return { data: { user: { id: userId } }, error: null };
      }
      return { data: { user: null }, error: new Error("Invalid token") };
    };

    const app = express();
    app.use(express.json());
    app.use("/api/v2/workflows", v2WorkflowsRouter);
    app.use((err, req, res, next) => {
      res.status(err.statusCode || 500).json({
        ok: false,
        message: err.message,
      });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    supabase.auth.getUser = origGetUser;
    process.env.INTERNAL_SECRET = originalSecret;
    if (originalFlag !== undefined) {
      process.env.ENABLE_V2_WORKFLOW_RUN_ENDPOINT = originalFlag;
    } else {
      delete process.env.ENABLE_V2_WORKFLOW_RUN_ENDPOINT;
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    delete process.env.ENABLE_V2_WORKFLOW_RUN_ENDPOINT;
  });

  // ── TEST 1: Default configuration rejects POST /api/v2/workflows/run with 404 ──
  it("TEST 1: Default config: POST /api/v2/workflows/run is disabled and returns 404", async () => {
    delete process.env.ENABLE_V2_WORKFLOW_RUN_ENDPOINT;

    const res = await fetch(`${baseUrl}/api/v2/workflows/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-attacker",
      },
      body: JSON.stringify({
        workflow_id: "image-generation-v3",
        input: {
          prompt: "An uncharged malicious run",
        },
      }),
    });

    const body = await res.json();
    assert.strictEqual(res.status, 404, `Expected HTTP 404 for disabled endpoint, got ${res.status}: ${JSON.stringify(body)}`);
    assert.strictEqual(body.code, "ENDPOINT_DISABLED");
  });

  // ── TEST 2: Even when legacy feature flag is set, V2 run endpoint remains disabled ──
  it("TEST 2: Legacy feature flag ignored: POST /api/v2/workflows/run remains disabled (404 ENDPOINT_DISABLED)", async () => {
    process.env.ENABLE_V2_WORKFLOW_RUN_ENDPOINT = "true";

    const res = await fetch(`${baseUrl}/api/v2/workflows/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-admin",
      },
      body: JSON.stringify({
        workflow_id: "non-existent-workflow",
        input: {
          prompt: "Test",
        },
      }),
    });

    const body = await res.json();
    assert.strictEqual(res.status, 404);
    assert.strictEqual(body.code, "ENDPOINT_DISABLED");
  });
});
}

// ─── Source: memoryFallbackProhibitionBoundary.test.js ───
{
describe("RC1.4-D3(1) — Memory Fallbacks Prohibition Outside Tests", () => {
  it("TEST 5: src/shared/db/supabase.js with missing env and NODE_ENV=production -> throws at load", () => {
    assert.throws(
      () => {
        execSync(
          'node --input-type=module -e "process.env.DOTENV_CONFIG_PATH=\'nonexistent\'; process.env.NODE_ENV=\'production\'; delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_KEY; import(\'./src/shared/db/supabase.js\');"',
          { stdio: "pipe" }
        );
      },
      (err) => {
        const stderr = err.stderr ? err.stderr.toString() : "";
        return /Fatal: Supabase URL/i.test(stderr) || /supabaseUrl is required/i.test(stderr);
      }
    );
  });

  it("TEST 6: src/shared/db/supabase.js with missing env and NODE_ENV=test -> loads successfully with test fake", () => {
    const output = execSync(
      'node --input-type=module -e "process.env.DOTENV_CONFIG_PATH=\'nonexistent\'; process.env.NODE_ENV=\'test\'; delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_KEY; import(\'./src/shared/db/supabase.js\').then(m => { if (m.supabase && m.supabaseAdmin) console.log(\'TEST_FAKE_LOADED_OK\'); });"',
      { stdio: "pipe" }
    ).toString();

    assert.match(output, /TEST_FAKE_LOADED_OK/);
  });
});
}
after(() => {
  setTimeout(() => process.exit(0), 100);
});
