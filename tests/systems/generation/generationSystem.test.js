import { describe, it, after, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { triggerWorkflowRun, getWorkflowRun, compileWorkflow, startWorkflowRun, executeOrchestration, loadRegistries, RunRepository, NodeSafetyService, bootstrapV2, UseCaseService, jobQueueService, GenerationService, GenerationRequestService, WorkflowLifecycleService, WorkflowService, PromptService, LLMService, llmService, PromptBuilderProService, enhancePromptProcessor, generateNegativePromptProcessor, moderationSafetyProcessor, optimizeVisualPromptProcessor, GenerationError, GenerationValidationError, GenerationNotFoundError, GenerationCompilationError, GenerationQueueDispatchError, getUseCase, registerAllUseCases } from "#generation/tools";
import { imagesRouter, videoRouter, promptRouter, v2WorkflowsRouter, workflowsRouter, generationRouter } from "#generation/api";
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
 * typed errors, DTO contracts, and workflow triggers.
 */




describe("System 1: Generation & Workflows — Gateways & Public Tools Contract", () => {
    it("should export all expected public tools and facade members", () => {
        assert.equal(typeof triggerWorkflowRun, "function");
        assert.equal(typeof getWorkflowRun, "function");
        assert.equal(typeof compileWorkflow, "function");
        assert.equal(typeof startWorkflowRun, "function");
        assert.equal(typeof executeOrchestration, "function");
        assert.equal(typeof loadRegistries, "function");
        assert.equal(typeof RunRepository, "function");
        assert.equal(typeof NodeSafetyService, "object");
        assert.equal(typeof bootstrapV2, "function");
        assert.equal(typeof UseCaseService, "function");
        assert.equal(typeof jobQueueService, "object");
        assert.equal(typeof GenerationService, "function");
        assert.equal(typeof GenerationRequestService, "function");
        assert.equal(typeof WorkflowLifecycleService, "function");
        assert.equal(typeof WorkflowService, "function");
        assert.equal(typeof PromptService, "function");
        assert.equal(typeof LLMService, "function");
        assert.equal(typeof llmService, "object");
        assert.equal(typeof PromptBuilderProService, "function");
        assert.equal(typeof enhancePromptProcessor, "object");
        assert.equal(typeof generateNegativePromptProcessor, "object");
        assert.equal(typeof moderationSafetyProcessor, "object");
        assert.equal(typeof optimizeVisualPromptProcessor, "object");
    });

    it("should export valid Express routers from #generation/api", () => {
        assert.equal(typeof imagesRouter, "function");
        assert.equal(typeof videoRouter, "function");
        assert.equal(typeof promptRouter, "function");
        assert.equal(typeof v2WorkflowsRouter, "function");
        assert.equal(typeof workflowsRouter, "function");
        assert.equal(typeof generationRouter, "function");

        assert.ok(Array.isArray(imagesRouter.stack));
        assert.ok(Array.isArray(videoRouter.stack));
        assert.ok(Array.isArray(promptRouter.stack));
        assert.ok(Array.isArray(v2WorkflowsRouter.stack));
        assert.ok(Array.isArray(workflowsRouter.stack));
        assert.ok(Array.isArray(generationRouter.stack));
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

describe("System 1: Generation & Workflows — triggerWorkflowRun & getWorkflowRun validations", () => {
    it("should throw GenerationValidationError when workflowId is missing in triggerWorkflowRun", async () => {
        await assert.rejects(
            () => triggerWorkflowRun({}),
            (err) => {
                assert.ok(err instanceof GenerationValidationError);
                assert.equal(err.statusCode, 400);
                assert.match(err.message, /workflowId is required/);
                return true;
            }
        );
    });

    it("should throw GenerationNotFoundError when workflowId is not in registries", async () => {
        await assert.rejects(
            () => triggerWorkflowRun({ workflowId: "non-existent-workflow-xyz" }),
            (err) => {
                assert.ok(err instanceof GenerationNotFoundError);
                assert.equal(err.statusCode, 404);
                assert.match(err.message, /not found in registry/);
                return true;
            }
        );
    });

    it("should throw GenerationValidationError when runId is missing in getWorkflowRun", async () => {
        await assert.rejects(
            () => getWorkflowRun({}),
            (err) => {
                assert.ok(err instanceof GenerationValidationError);
                assert.equal(err.statusCode, 400);
                assert.match(err.message, /runId is required/);
                return true;
            }
        );
    });

    it("should throw GenerationNotFoundError when run is missing in getWorkflowRun", async () => {
        await assert.rejects(
            () => getWorkflowRun({ runId: "00000000-0000-0000-0000-000000000000" }),
            (err) => {
                assert.ok(err instanceof GenerationNotFoundError);
                assert.equal(err.statusCode, 404);
                return true;
            }
        );
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

  it("TEST 2: imagesRouter exposes ONLY /generated endpoint without aliases", () => {
    const registeredRoutes = imagesRouter.stack
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));

    assert.strictEqual(registeredRoutes.length, 1, "imagesRouter must have exactly 1 route: /generated");
    assert.strictEqual(registeredRoutes[0].path, "/generated");
    assert.ok(registeredRoutes[0].methods.includes("post"));

    // Verify removed aliases do NOT exist
    const forbiddenPaths = [
      "/generated/edit/existing",
      "/generated/edit/new",
      "/edit",
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

  it("TEST 4: Independent Use Cases registered for Image and Video generation flows", () => {
    registerAllUseCases();

    const imageUc = getUseCase("image-generation-v1");
    const videoUc = getUseCase("video-generation-v1");

    assert.ok(imageUc, "image-generation-v1 must be registered in Use Case Registry");
    assert.strictEqual(imageUc.workflowRef, "image-generation-v1");

    assert.ok(videoUc, "video-generation-v1 must be registered in Use Case Registry");
    assert.strictEqual(videoUc.workflowRef, "video-generation-v1");

    // Distinct use cases
    assert.notStrictEqual(
      imageUc.useCaseId,
      videoUc.useCaseId,
      "Image and Video must have distinct use cases"
    );
  });

  it("TEST 5: Image Generation Workflow Billing Plan calculates cost without LLM parameter error", async () => {
    const { compileWorkflowById } = await import("#generation/tools");
    const { calculateWorkflowBillingPlan } = await import("#generation/tools");
    const { loadRegistries } = await import("#generation/tools");

    const plan = compileWorkflowById("image-generation-v1", loadRegistries());

    assert.ok(plan, "Execution plan must compile successfully");

    const billingPlan = await calculateWorkflowBillingPlan({
      plan,
      inputs: {
        prompt: "A beautiful mountain sunset",
        model: "nanobana_pro",
        workflow_id: "wf-test-123",
        parameters: { resolution: "1k" },
      },
    });

    assert.ok(billingPlan, "Billing plan must be generated");
    assert.ok(billingPlan.totalCredits > 0, "Total credits must be greater than 0");
    assert.strictEqual(billingPlan.billableNodes.length, 2, "Must include both llm_translate and generate nodes");
  });

  it("TEST 6: Video Generation Workflow compiles and calculates billing plan for video models", async () => {
    const { compileWorkflowById } = await import("#generation/tools");
    const { calculateWorkflowBillingPlan } = await import("#generation/tools");
    const { loadRegistries } = await import("#generation/tools");

    const plan = compileWorkflowById("video-generation-v1", loadRegistries());

    assert.ok(plan, "Video execution plan must compile successfully");
    assert.strictEqual(plan.workflow_id, "video-generation-v1");

    const billingPlan = await calculateWorkflowBillingPlan({
      plan,
      inputs: {
        prompt: "A drone shot over futuristic Tokyo at night",
        model: "seedance_2_5",
        workflow_id: "wf-vid-test-456",
        parameters: { duration: 5, aspect_ratio: "16:9" },
      },
    });

    assert.ok(billingPlan, "Billing plan must be generated for video workflow");
    assert.ok(billingPlan.totalCredits > 0, "Total credits must be greater than 0");
    assert.strictEqual(billingPlan.billableNodes.length, 2, "Must include both llm_translate and generate nodes");
  });

  it("TEST 7: estimateNodeBillingAmount handles LLM node inputs with skills without capability error", async () => {
    const { estimateNodeBillingAmount } = await import("#generation/tools");

    const nodeConfig = { id: "llm_translate", type: "llm" };
    const resolvedInputs = {
      model: "gemini-3-flash",
      skill: { id: "llm/system-safety", version: "2.0.0", pipeline: [], parameters: {} },
      skills: ["llm/system-safety", "llm/translate", "llm/json-output"],
      images: [],
      jsonMode: true,
      parameters: {},
      temperature: 0.7,
      userPrompt: "cat",
    };

    const cost = estimateNodeBillingAmount(nodeConfig, resolvedInputs);
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

  // Spy on runRepo
  let originalGetRun;
  let originalListNodeRuns;

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
    originalGetRun = RunRepository.prototype.getRun;
    originalListNodeRuns = RunRepository.prototype.listNodeRuns;
  });

  afterEach(() => {
    RunRepository.prototype.getRun = originalGetRun;
    RunRepository.prototype.listNodeRuns = originalListNodeRuns;
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
        workflow_id: "image-generation-v1",
        input: {
          prompt: "An uncharged malicious run",
        },
      }),
    });

    const body = await res.json();
    assert.strictEqual(res.status, 404, `Expected HTTP 404 for disabled endpoint, got ${res.status}: ${JSON.stringify(body)}`);
    assert.strictEqual(body.code, "ENDPOINT_DISABLED");
  });

  // ── TEST 2: When enabled explicitly via feature flag, endpoint allows execution ──
  it("TEST 2: Feature flag enabled: allows execution only when ENABLE_V2_WORKFLOW_RUN_ENDPOINT=true", async () => {
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
    // It passed the feature flag check and reached registry resolution
    assert.notStrictEqual(body.code, "ENDPOINT_DISABLED", "Should not be blocked by feature flag when enabled");
    assert.strictEqual(body.code, "WORKFLOW_NOT_FOUND");
  });

  // ── TEST 3: GET /runs/:run_id enforces user ownership ──
  it("TEST 3: GET /runs/:run_id returns 404 when requested by a different user", async () => {
    RunRepository.prototype.getRun = async (runId) => {
      if (runId === "run-owned-by-user-A") {
        return {
          id: "run-owned-by-user-A",
          user_id: "user-A",
          status: "completed",
        };
      }
      return null;
    };

    const res = await fetch(`${baseUrl}/api/v2/workflows/runs/run-owned-by-user-A`, {
      method: "GET",
      headers: {
        "Authorization": "Bearer token-user-B", // DIFFERENT USER!
      },
    });

    const body = await res.json();
    assert.strictEqual(res.status, 404, `Expected HTTP 404 for unowned run, got ${res.status}`);
    assert.strictEqual(body.code, "RUN_NOT_FOUND");
  });
});
}

// ─── Source: memoryFallbackProhibitionBoundary.test.js ───
{
describe("RC1.4-D3(1) — Memory Fallbacks Prohibition Outside Tests", () => {
  let originalNodeEnv;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    RunRepository.useMemoryFallback = false;
    RunRepository.clientOverride = null;
  });

  it("TEST 1: NODE_ENV=production, repository constructed with fallback enabled -> constructor throws", () => {
    process.env.NODE_ENV = "production";
    assert.throws(
      () => new RunRepository({ useMemoryFallback: true }),
      /in-memory fallback is prohibited outside node_env=test/i
    );
  });

  it("TEST 2: NODE_ENV=development, repository constructed with fallback enabled -> constructor throws", () => {
    process.env.NODE_ENV = "development";
    assert.throws(
      () => new RunRepository({ useMemoryFallback: true }),
      /in-memory fallback is prohibited outside node_env=test/i
    );
  });

  it("TEST 3: NODE_ENV=production, DB call rejects -> error propagates and repository did NOT switch to memory", async () => {
    process.env.NODE_ENV = "production";
    const repo = new RunRepository();

    let calls = 0;
    const mockDbError = new Error("Database offline");
    mockDbError.code = "PGRST205"; // The table-not-found code that previously triggered fallback

    RunRepository.clientOverride = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => {
              calls++;
              return { data: null, error: mockDbError };
            }
          })
        })
      })
    };

    // First call must throw the DB error, NOT swallow it or fall back to memory
    await assert.rejects(
      async () => {
        await repo.createRun({ run_id: "test-run-1", workflow_id: "wf-1" });
      },
      (err) => {
        assert.equal(err.code, "PGRST205");
        return true;
      }
    );

    // Assert repository did NOT switch to memory fallback
    assert.equal(RunRepository.useMemoryFallback, false);

    // Second call must still attempt DB call, not use in-memory Map
    await assert.rejects(
      async () => {
        await repo.createRun({ run_id: "test-run-2", workflow_id: "wf-1" });
      },
      (err) => {
        assert.equal(err.code, "PGRST205");
        return true;
      }
    );

    assert.equal(calls, 2);
    assert.equal(RunRepository.useMemoryFallback, false);
  });

  it("TEST 4: NODE_ENV=test, fallback enabled -> works as before (regression guard)", async () => {
    process.env.NODE_ENV = "test";
    const repo = new RunRepository({ useMemoryFallback: true });
    RunRepository.useMemoryFallback = true;

    const created = await repo.createRun({
      run_id: "test-mem-run-1",
      workflow_id: "wf-test",
      input: { prompt: "test prompt" }
    });

    assert.ok(created);
    assert.equal(created.run_id, "test-mem-run-1");

    const fetched = await repo.getRun("test-mem-run-1");
    assert.ok(fetched);
    assert.equal(fetched.run_id, "test-mem-run-1");
  });

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
