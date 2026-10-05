import { describe, it, after } from "node:test";
import assert from "node:assert";
import apiRouter from "../../src/api/routes.js";
import imagesRouter from "../../routes/images.js";
import videoRouter from "../../routes/video.js";
import { getUseCase } from "../../src/use-cases/useCaseRegistry.js";
import { registerAllUseCases } from "../../src/use-cases/registerUseCases.js";

describe("Generation API Boundary & Separation Tests", () => {
  after(() => {
    setTimeout(() => process.exit(0), 50);
  });

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
    const { compileWorkflowById } = await import("../../src/v2/compiler/compileWorkflow.js");
    const { calculateWorkflowBillingPlan } = await import("../../src/use-cases/workflowBillingPlan.js");
    const { loadRegistries } = await import("../../src/v2/registry/registryLoader.js");

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
    const { compileWorkflowById } = await import("../../src/v2/compiler/compileWorkflow.js");
    const { calculateWorkflowBillingPlan } = await import("../../src/use-cases/workflowBillingPlan.js");
    const { loadRegistries } = await import("../../src/v2/registry/registryLoader.js");

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
    const { estimateNodeBillingAmount } = await import("../../src/v2/runner/workflowRunner.js");

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



