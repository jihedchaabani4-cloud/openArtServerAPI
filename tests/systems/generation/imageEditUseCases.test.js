/**
 * System 1: Generation & Workflows — In-Place Image Edit Use Cases Tests
 *
 * Behavioral & boundary tests for:
 *   - HTTP / Controller Boundary: `relightImage` (`POST /api/images/relight`),
 *     `changeImageAngle` (`POST /api/images/angles`), and `imagesRouter`
 *   - Service Behavior: `GenerationRequestService.requestImageEdit`
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { relightImage, changeImageAngle, removeImageBackground, editImage, getProjectData, imagesRouter } from "#generation/api";
import { GenerationRequestService } from "#generation/tools";
import { appendMediaToWorkflow, completeMedia, WorkflowMediaRepository } from "#media/tools";
import { WorkflowExecutor, createDefaultV3NodeRegistry } from "../../../src/systems/generation/internal/v3/index.js";
import { imageEditV3 } from "../../../src/systems/generation/internal/v3/workflows/imageEditV3.js";
import { generationRequestService, db } from "../../../src/container.js";
import { AppError } from "#shared";

function createMockRes() {
  let statusCode = 200;
  let payload = null;
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      payload = data;
      return res;
    },
    getStatus: () => statusCode,
    getPayload: () => payload,
  };
  return res;
}

describe("In-Place Image Edit Controllers & Router Boundary (relightImage, changeImageAngle)", () => {
  let originalRequestImageEdit;
  let originalFindById;
  let originalGetWorkflow;
  let originalFindByMedia;
  let originalFindByUser;

  beforeEach(() => {
    originalRequestImageEdit = generationRequestService.requestImageEdit;
    if (db.workflows) {
      originalFindById = db.workflows.findById;
      originalGetWorkflow = db.workflows.getWorkflow;
      db.workflows.findById = async (id) => ({
        id,
        user_id: "user-owner",
        project_id: "proj-1",
      });
      db.workflows.getWorkflow = db.workflows.findById;
    }
    if (db.workflowMedia) {
      originalFindByMedia = db.workflowMedia.findByMedia;
      db.workflowMedia.findByMedia = async () => [];
    }
    if (db.projects) {
      originalFindByUser = db.projects.findByUser;
      db.projects.findByUser = async (userId, projectId) =>
        userId === "user-owner" && projectId === "proj-1"
          ? [{ id: "proj-1", user_id: "user-owner" }]
          : [];
    }
  });

  afterEach(() => {
    generationRequestService.requestImageEdit = originalRequestImageEdit;
    if (db.workflows) {
      db.workflows.findById = originalFindById;
      db.workflows.getWorkflow = originalGetWorkflow;
    }
    if (db.workflowMedia) {
      db.workflowMedia.findByMedia = originalFindByMedia;
    }
    if (db.projects) {
      db.projects.findByUser = originalFindByUser;
    }
  });

  it("imagesRouter mounts POST /relight and POST /angles with auth and rate-limit middleware", () => {
    const routes = imagesRouter.stack
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
        handlersCount: layer.route.stack.length,
      }));

    const relightRoute = routes.find((r) => r.path === "/relight");
    const anglesRoute = routes.find((r) => r.path === "/angles");
    assert.ok(relightRoute, "imagesRouter must register /relight");
    assert.ok(anglesRoute, "imagesRouter must register /angles");
    assert.ok(relightRoute.methods.includes("post"));
    assert.ok(anglesRoute.methods.includes("post"));
    assert.ok(relightRoute.handlersCount >= 3, "/relight must include requireAuth, rateLimit, controller");
    assert.ok(anglesRoute.handlersCount >= 3, "/angles must include requireAuth, rateLimit, controller");
  });

  describe("Common rejection rules across /relight and /angles", () => {
    const handlers = [
      { name: "relightImage", fn: relightImage, validExtra: { light_type: "soft", brightness: 70 } },
      { name: "changeImageAngle", fn: changeImageAngle, validExtra: { rotation: 30 } },
    ];

    for (const { name, fn, validExtra } of handlers) {
      it(`${name} rejects client model / model_name with 400 MODEL_LOCKED`, async () => {
        let calledService = false;
        generationRequestService.requestImageEdit = async () => {
          calledService = true;
          return { ok: true };
        };

        for (const extra of [{ model: "nanobana_2" }, { model_name: "gpt-image-2" }]) {
          const res = createMockRes();
          await fn(
            {
              body: { workflow_id: "wf-1", ...validExtra, ...extra },
              user: { id: "user-owner" },
            },
            res
          );
          assert.equal(res.getStatus(), 400);
          assert.equal(res.getPayload().ok, false);
          assert.equal(res.getPayload().code, "MODEL_LOCKED");
          assert.equal(calledService, false);
        }
      });

      it(`${name} rejects client media_id / mediaId / source_media_id with 400 MEDIA_ID_NOT_ALLOWED`, async () => {
        for (const extra of [
          { media_id: "media-1" },
          { mediaId: "media-1" },
          { source_media_id: "media-1" },
        ]) {
          const res = createMockRes();
          await fn(
            {
              body: { workflow_id: "wf-1", ...validExtra, ...extra },
              user: { id: "user-owner" },
            },
            res
          );
          assert.equal(res.getStatus(), 400);
          assert.equal(res.getPayload().ok, false);
          assert.equal(res.getPayload().code, "MEDIA_ID_NOT_ALLOWED");
        }
      });

      it(`${name} rejects raw HTTP(S) image URLs in top-level fields or parameters with 400 DIRECT_URL_NOT_ALLOWED`, async () => {
        const forbiddenBodies = [
          { workflow_id: "wf-1", ...validExtra, image_url: "https://evil.example/img.png" },
          { workflow_id: "wf-1", ...validExtra, source: "https://evil.example/img.png" },
          { workflow_id: "wf-1", ...validExtra, input_image: "http://evil.example/img.png" },
          { workflow_id: "wf-1", ...validExtra, source_url: "https://evil.example/img.png" },
          {
            workflow_id: "wf-1",
            ...validExtra,
            parameters: { input_image: "https://evil.example/img.png" },
          },
          {
            workflow_id: "wf-1",
            ...validExtra,
            parameters: { nested: { refs: ["http://evil.example/a.png"] } },
          },
        ];

        for (const body of forbiddenBodies) {
          const res = createMockRes();
          await fn({ body, user: { id: "user-owner" } }, res);
          assert.equal(res.getStatus(), 400);
          assert.equal(res.getPayload().ok, false);
          assert.equal(res.getPayload().code, "DIRECT_URL_NOT_ALLOWED");
        }
      });

      it(`${name} rejects missing or blank workflow_id with 400 MISSING_WORKFLOW_ID`, async () => {
        for (const wfPatch of [{}, { workflow_id: "" }, { workflow_id: "   " }, { workflowId: "  " }]) {
          const res = createMockRes();
          await fn({ body: { ...validExtra, ...wfPatch }, user: { id: "user-owner" } }, res);
          assert.equal(res.getStatus(), 400);
          assert.equal(res.getPayload().ok, false);
          assert.equal(res.getPayload().code, "MISSING_WORKFLOW_ID");
        }
      });

      it(`${name} enforces workflow ownership before mutating anything`, async () => {
        let calledService = false;
        generationRequestService.requestImageEdit = async () => {
          calledService = true;
          return { ok: true };
        };

        // Workflow belongs to user-owner, caller is user-attacker
        db.workflows.findById = async () => ({
          id: "wf-secret",
          user_id: "user-owner",
          project_id: "proj-1",
        });
        db.workflows.getWorkflow = db.workflows.findById;

        const res = createMockRes();
        await fn(
          {
            body: { workflow_id: "wf-secret", ...validExtra },
            user: { id: "user-attacker" },
          },
          res
        );

        assert.equal(res.getStatus(), 404, "assertOwns must fail closed with 404 to prevent enumeration");
        assert.equal(res.getPayload().ok, false);
        assert.equal(calledService, false, "service must not be called when ownership check fails");
      });
    }
  });

  describe("relightImage validation & delegation", () => {
    it("accepts valid flat relight controls and delegates to generationRequestService.requestImageEdit with locked nanobana_2", async () => {
      let capturedArgs = null;
      generationRequestService.requestImageEdit = async (args) => {
        capturedArgs = args;
        return {
          ok: true,
          status: "processing",
          needsCredits: false,
          workflowId: args.workflowId,
          mediaId: "media-relight-new",
          sourceMediaId: "media-orig",
        };
      };

      const res = createMockRes();
      await relightImage(
        {
          body: {
            workflow_id: " wf-relight-1 ",
            light_type: "Hard",
            brightness: 85,
            color: "#ffaa33",
            size: 25,
            rotation: -135,
            tilt: 45,
            distance: 60,
            prompt: "Dramatic rim highlight on hair",
            parameters: { resolution: "2k" },
          },
          user: { id: "user-owner" },
        },
        res
      );

      assert.equal(res.getStatus(), 200);
      assert.equal(res.getPayload().ok, true);
      assert.equal(res.getPayload().mediaId, "media-relight-new");
      assert.ok(capturedArgs);
      assert.equal(capturedArgs.userId, "user-owner");
      assert.equal(capturedArgs.workflowId, "wf-relight-1");
      assert.equal(capturedArgs.editType, "relight");
      assert.equal(capturedArgs.stepId, "image_relight");
      assert.equal(capturedArgs.useCaseId, "image-relight-v3");
      assert.equal(capturedArgs.model, "nanobana_2");
      assert.equal(capturedArgs.userPrompt, "Dramatic rim highlight on hair");
      assert.deepEqual(capturedArgs.editSettings, {
        light_type: "hard",
        brightness: 85,
        color: "#FFAA33",
        size: 25,
        rotation: -135,
        tilt: 45,
        distance: 60,
      });
      assert.deepEqual(capturedArgs.parameters, { resolution: "2k" });
      assert.match(capturedArgs.prompt, /hard light/i);
      assert.match(capturedArgs.prompt, /brightness 85%/);
      assert.match(capturedArgs.prompt, /color #FFAA33/);
      assert.match(capturedArgs.prompt, /distance 60\/100/);
      assert.match(capturedArgs.prompt, /Dramatic rim highlight on hair/);
    });

    it("accepts boundary values and optional distance omitted", async () => {
      let capturedArgs = null;
      generationRequestService.requestImageEdit = async (args) => {
        capturedArgs = args;
        return { ok: true, status: "processing" };
      };

      const res = createMockRes();
      await relightImage(
        {
          body: {
            workflow_id: "wf-bounds",
            light_type: "soft",
            brightness: 0,
            color: "#000000",
            size: 100,
            rotation: 360,
            tilt: -90,
          },
          user: { id: "user-owner" },
        },
        res
      );

      assert.equal(res.getStatus(), 200);
      assert.equal("distance" in capturedArgs.editSettings, false);
      assert.deepEqual(capturedArgs.editSettings, {
        light_type: "soft",
        brightness: 0,
        color: "#000000",
        size: 100,
        rotation: 360,
        tilt: -90,
      });
    });

    it("rejects invalid light_type, invalid hex color, and out-of-range numeric controls with 400", async () => {
      const invalidCases = [
        { light_type: "neon", expectedCode: "INVALID_LIGHT_TYPE" },
        { light_type: 123, expectedCode: "INVALID_LIGHT_TYPE" },
        { color: "#FFF", expectedCode: "INVALID_COLOR" },
        { color: "FFFFFF", expectedCode: "INVALID_COLOR" },
        { color: "#GGGGGG", expectedCode: "INVALID_COLOR" },
        { color: 123456, expectedCode: "INVALID_COLOR" },
        { brightness: -1, expectedCode: "OUT_OF_RANGE" },
        { brightness: 101, expectedCode: "OUT_OF_RANGE" },
        { brightness: true, expectedCode: "INVALID_NUMBER" },
        { size: -0.1, expectedCode: "OUT_OF_RANGE" },
        { size: 100.1, expectedCode: "OUT_OF_RANGE" },
        { rotation: -181, expectedCode: "OUT_OF_RANGE" },
        { rotation: 361, expectedCode: "OUT_OF_RANGE" },
        { tilt: -91, expectedCode: "OUT_OF_RANGE" },
        { tilt: 91, expectedCode: "OUT_OF_RANGE" },
        { distance: -1, expectedCode: "OUT_OF_RANGE" },
        { distance: 101, expectedCode: "OUT_OF_RANGE" },
      ];

      for (const { expectedCode, ...badFields } of invalidCases) {
        const res = createMockRes();
        await relightImage(
          {
            body: { workflow_id: "wf-1", ...badFields },
            user: { id: "user-owner" },
          },
          res
        );
        assert.equal(res.getStatus(), 400, `Expected 400 for ${JSON.stringify(badFields)}`);
        assert.equal(res.getPayload().ok, false);
        assert.equal(res.getPayload().code, expectedCode);
      }
    });
  });

  describe("changeImageAngle validation & delegation", () => {
    it("accepts valid rotation, tilt, zoom, and optional prompt, delegating to requestImageEdit with locked nanobana_2", async () => {
      let capturedArgs = null;
      generationRequestService.requestImageEdit = async (args) => {
        capturedArgs = args;
        return {
          ok: true,
          status: "processing",
          needsCredits: false,
          workflowId: args.workflowId,
          mediaId: "media-angle-new",
          sourceMediaId: "media-orig",
        };
      };

      const res = createMockRes();
      await changeImageAngle(
        {
          body: {
            workflow_id: "wf-angle-1",
            rotation: -180,
            tilt: 90,
            zoom: 10,
            prompt: "Keep crisp focus on face",
          },
          user: { id: "user-owner" },
        },
        res
      );

      assert.equal(res.getStatus(), 200);
      assert.equal(res.getPayload().ok, true);
      assert.ok(capturedArgs);
      assert.equal(capturedArgs.editType, "angles");
      assert.equal(capturedArgs.stepId, "image_angles");
      assert.equal(capturedArgs.useCaseId, "image-angles-v3");
      assert.equal(capturedArgs.model, "nanobana_2");
      assert.deepEqual(capturedArgs.editSettings, {
        rotation: -180,
        tilt: 90,
        zoom: 10,
      });
      assert.match(capturedArgs.prompt, /rotation -180 degrees, tilt 90 degrees, zoom 10\/10/);
      assert.match(capturedArgs.prompt, /Keep crisp focus on face/);
    });

    it("allows (0, 0, 0) camera pose when a non-empty prompt is provided", async () => {
      let capturedArgs = null;
      generationRequestService.requestImageEdit = async (args) => {
        capturedArgs = args;
        return { ok: true, status: "processing" };
      };

      const res = createMockRes();
      await changeImageAngle(
        {
          body: {
            workflow_id: "wf-angle-prompt-only",
            rotation: 0,
            tilt: 0,
            zoom: 0,
            prompt: "Slight Dutch tilt",
          },
          user: { id: "user-owner" },
        },
        res
      );

      assert.equal(res.getStatus(), 200);
      assert.deepEqual(capturedArgs.editSettings, { rotation: 0, tilt: 0, zoom: 0 });
    });

    it("rejects all-zero no-op (0, 0, 0 without prompt) and out-of-range values with 400", async () => {
      const invalidCases = [
        { rotation: 0, tilt: 0, zoom: 0, expectedCode: "NO_OP_CAMERA_ANGLE" },
        { rotation: 0, tilt: 0, zoom: 0, prompt: "   ", expectedCode: "NO_OP_CAMERA_ANGLE" },
        { expectedCode: "NO_OP_CAMERA_ANGLE" },
        { rotation: -181, expectedCode: "OUT_OF_RANGE" },
        { rotation: 361, expectedCode: "OUT_OF_RANGE" },
        { tilt: -91, expectedCode: "OUT_OF_RANGE" },
        { tilt: 91, expectedCode: "OUT_OF_RANGE" },
        { zoom: -0.5, expectedCode: "OUT_OF_RANGE" },
        { zoom: 10.1, expectedCode: "OUT_OF_RANGE" },
      ];

      for (const { expectedCode, ...badFields } of invalidCases) {
        const res = createMockRes();
        await changeImageAngle(
          {
            body: { workflow_id: "wf-1", ...badFields },
            user: { id: "user-owner" },
          },
          res
        );
        assert.equal(res.getStatus(), 400, `Expected 400 for ${JSON.stringify(badFields)}`);
        assert.equal(res.getPayload().ok, false);
        assert.equal(res.getPayload().code, expectedCode);
      }
    });

    it("returns HTTP 503 when service throws QUEUE_DISPATCH_FAILED", async () => {
      generationRequestService.requestImageEdit = async () => {
        const err = new AppError("Queue unavailable", 503);
        err.code = "QUEUE_DISPATCH_FAILED";
        err.workflowId = "wf-1";
        err.mediaId = "media-new-fail";
        err.mediaIds = ["media-new-fail"];
        throw err;
      };

      const res = createMockRes();
      await changeImageAngle(
        {
          body: { workflow_id: "wf-1", rotation: 45 },
          user: { id: "user-owner" },
        },
        res
      );

      assert.equal(res.getStatus(), 503);
      assert.equal(res.getPayload().ok, false);
      assert.equal(res.getPayload().status, "failed");
      assert.equal(res.getPayload().code, "QUEUE_DISPATCH_FAILED");
      assert.equal(res.getPayload().workflowId, "wf-1");
      assert.equal(res.getPayload().mediaId, "media-new-fail");
    });
  });
});

describe("GenerationRequestService.requestImageEdit behavioral tests", () => {
  function createEditMocks({
    workflow = { id: "wf-edit-1", project_id: "proj-1", workflow_type: "GENERATION" },
    trashed = false,
    primaryMedia = {
      id: "media-src-1",
      url: "https://cdn.example.com/workflows/wf-edit-1/primary.png",
      status: "success",
      width: 1920,
      height: 1080,
      generation_config: { aspect_ratio: "16:9" },
    },
    workflowMediaList = null,
    launchImpl = null,
  } = {}) {
    const createdWorkflows = [];
    const createdMedia = [];
    const updatedMedia = [];
    const linkedMedia = [];
    const primarySwaps = [];
    const launchCalls = [];

    const mockDb = {
      workflows: {
        findById: async (id) => (workflow && workflow.id === id ? workflow : null),
        createWorkflow: async (wf) => {
          createdWorkflows.push(wf);
          return wf;
        },
      },
      trash: {
        getTrashedWorkflowIdSet: async ({ workflowIds }) =>
          new Set(trashed ? workflowIds : []),
      },
      workflowMedia: {
        getPrimaryMedia: async () => primaryMedia,
        ...(workflowMediaList !== null
          ? { findByWorkflow: async () => workflowMediaList }
          : {}),
        linkMedia: async (link) => {
          linkedMedia.push(link);
          return link;
        },
        setPrimaryMedia: async (args) => {
          primarySwaps.push(args);
          return args;
        },
      },
      media: {
        createMedia: async (m) => {
          createdMedia.push(m);
          return m;
        },
        updateMedia: async (id, patch) => {
          updatedMedia.push({ id, ...patch });
          return { id, ...patch };
        },
      },
    };

    const mockExecutionEngine = {
      launch: async (args) => {
        launchCalls.push(args);
        if (launchImpl) return launchImpl(args);
        return {
          jobId: "job-edit-123",
          executionId: args.executionId,
          cost: { totalCredits: 13 },
        };
      },
    };

    const service = new GenerationRequestService({
      db: mockDb,
      executionEngine: mockExecutionEngine,
      folderService: {},
    });

    return {
      service,
      createdWorkflows,
      createdMedia,
      updatedMedia,
      linkedMedia,
      primarySwaps,
      launchCalls,
    };
  }

  const baseEditRequest = {
    userId: "user-1",
    workflowId: "wf-edit-1",
    editType: "relight",
    stepId: "image_relight",
    useCaseId: "image-relight-v3",
    model: "nanobana_2",
    prompt: "Relight the existing image. Lighting setup: soft light, brightness 80%, color #FFEEDD, size 50/100, rotation 30 degrees, tilt 15 degrees.",
    userPrompt: "Warm studio bounce",
    editSettings: {
      light_type: "soft",
      brightness: 80,
      color: "#FFEEDD",
      size: 50,
      rotation: 30,
      tilt: 15,
    },
    parameters: {},
  };

  it("throws 404 WORKFLOW_NOT_FOUND when workflow does not exist", async () => {
    const { service, createdMedia } = createEditMocks({ workflow: null });
    await assert.rejects(
      () => service.requestImageEdit(baseEditRequest),
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.equal(err.code, "WORKFLOW_NOT_FOUND");
        return true;
      }
    );
    assert.equal(createdMedia.length, 0);
  });

  it("throws 409 WORKFLOW_TRASHED when workflow is in trash", async () => {
    const { service, createdMedia } = createEditMocks({ trashed: true });
    await assert.rejects(
      () => service.requestImageEdit(baseEditRequest),
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, "WORKFLOW_TRASHED");
        return true;
      }
    );
    assert.equal(createdMedia.length, 0);
  });

  it("throws 400 PRIMARY_MEDIA_NOT_FOUND when workflow has no primary media", async () => {
    const { service, createdMedia } = createEditMocks({ primaryMedia: null });
    await assert.rejects(
      () => service.requestImageEdit(baseEditRequest),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, "PRIMARY_MEDIA_NOT_FOUND");
        return true;
      }
    );
    assert.equal(createdMedia.length, 0);
  });

  it("throws 409 PRIMARY_MEDIA_NOT_READY when primary media is processing or pending", async () => {
    for (const status of ["processing", "pending"]) {
      const { service, createdMedia } = createEditMocks({
        primaryMedia: {
          id: "media-src-1",
          url: null,
          status,
          width: 1024,
          height: 1024,
        },
      });
      await assert.rejects(
        () => service.requestImageEdit(baseEditRequest),
        (err) => {
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, "PRIMARY_MEDIA_NOT_READY");
          return true;
        }
      );
      assert.equal(createdMedia.length, 0);
    }
  });

  it("throws 400 PRIMARY_MEDIA_INVALID when primary media is failed or missing HTTPS URL", async () => {
    const invalidPrimaryCases = [
      { id: "m-1", url: "https://cdn.example.com/failed.png", status: "failed" },
      { id: "m-2", url: null, status: "success" },
      { id: "m-3", url: "s3://bucket/not-http.png", status: "success" },
      { id: "m-4", url: "", status: "saved" },
    ];

    for (const primaryMedia of invalidPrimaryCases) {
      const { service, createdMedia } = createEditMocks({ primaryMedia });
      await assert.rejects(
        () => service.requestImageEdit(baseEditRequest),
        (err) => {
          assert.equal(err.statusCode, 400);
          assert.equal(err.code, "PRIMARY_MEDIA_INVALID");
          return true;
        }
      );
      assert.equal(createdMedia.length, 0);
    }
  });

  it("appends a single placeholder into the same workflow, immediately promotes is_primary, stores edit metadata, inherits dimensions/ratio, and passes source_image_url to executionEngine", async () => {
    const {
      service,
      createdWorkflows,
      createdMedia,
      linkedMedia,
      primarySwaps,
      launchCalls,
    } = createEditMocks();

    const result = await service.requestImageEdit(baseEditRequest);

    assert.equal(result.ok, true);
    assert.equal(result.status, "processing");
    assert.equal(result.needsCredits, false);
    assert.equal(result.cost, 13);
    assert.equal(result.workflowId, "wf-edit-1");
    assert.equal(result.sourceMediaId, "media-src-1");
    assert.equal(result.workflow.id, "wf-edit-1");
    assert.equal(result.workflow.primary_media_id, result.mediaId);
    assert.notEqual(result.mediaId, "media-src-1");

    // Must NOT create a new workflow
    assert.equal(createdWorkflows.length, 0);

    // Must append exactly 1 placeholder media row
    assert.equal(createdMedia.length, 1);
    const placeholder = createdMedia[0];
    assert.equal(placeholder.id, result.mediaId);
    assert.equal(placeholder.project_id, "proj-1");
    assert.equal(placeholder.step_id, "image_relight");
    assert.equal(placeholder.status, "processing");
    assert.equal(placeholder.width, 1920);
    assert.equal(placeholder.height, 1080);

    // Must store source_media_id, edit_type, edit_settings, locked model in generation_config
    assert.equal(placeholder.generation_config.source_media_id, "media-src-1");
    assert.equal(placeholder.generation_config.edit_type, "relight");
    assert.deepEqual(placeholder.generation_config.edit_settings, baseEditRequest.editSettings);
    assert.equal(placeholder.generation_config.model, "nanobana_2");
    assert.equal(placeholder.generation_config.aspect_ratio, "16:9");
    assert.equal(placeholder.generation_config.user_prompt, "Warm studio bounce");

    // Must link into the SAME parent workflow and immediately promote to is_primary = true
    assert.equal(linkedMedia.length, 1);
    assert.equal(linkedMedia[0].workflow_id || linkedMedia[0].workflowId, "wf-edit-1");
    assert.equal(primarySwaps.length, 1);
    assert.deepEqual(primarySwaps[0], { workflowId: "wf-edit-1", mediaId: result.mediaId });

    // Must pass resolved source_image_url to executionEngine.launch
    assert.equal(launchCalls.length, 1);
    assert.equal(launchCalls[0].useCaseId, "image-relight-v3");
    assert.equal(launchCalls[0].input.source_image_url, "https://cdn.example.com/workflows/wf-edit-1/primary.png");
    assert.equal(launchCalls[0].input.source_media_id, "media-src-1");
    assert.equal(launchCalls[0].input.model, "nanobana_2");
    assert.equal(launchCalls[0].input.workflow_id, "wf-edit-1");
    assert.equal(launchCalls[0].input.media_id, result.mediaId);
    assert.equal(launchCalls[0].input.aspect_ratio, "16:9");
    assert.equal(launchCalls[0].input.width, 1920);
    assert.equal(launchCalls[0].input.height, 1080);
  });

  it("falls back to schema-safe default aspect ratio ('1:1') when source media has a non-standard ratio like 13:17", async () => {
    const { service, createdMedia, launchCalls } = createEditMocks({
      primaryMedia: {
        id: "media-nonstd",
        url: "https://cdn.example.com/nonstd.png",
        status: "success",
        width: 1300,
        height: 1700,
        generation_config: { aspect_ratio: "13:17" },
      },
    });

    const result = await service.requestImageEdit(baseEditRequest);
    assert.equal(result.ok, true);
    assert.equal(createdMedia[0].width, 1300);
    assert.equal(createdMedia[0].height, 1700);
    assert.equal(createdMedia[0].generation_config.aspect_ratio, "1:1");
    assert.equal(launchCalls[0].input.aspect_ratio, "1:1");
  });

  it("marks new placeholder 'saved' (keeping is_primary = true) and returns needsCredits: true on INSUFFICIENT_CREDITS", async () => {
    const { service, updatedMedia, primarySwaps } = createEditMocks({
      launchImpl: async () => {
        const err = new Error("Not enough credits for relight");
        err.code = "INSUFFICIENT_CREDITS";
        throw err;
      },
    });

    const result = await service.requestImageEdit(baseEditRequest);
    assert.equal(result.ok, true);
    assert.equal(result.status, "saved");
    assert.equal(result.needsCredits, true);
    assert.equal(result.workflow.primary_media_id, result.mediaId);

    // Primary swap was executed once and NOT reverted
    assert.equal(primarySwaps.length, 1);
    assert.equal(primarySwaps[0].mediaId, result.mediaId);

    // Placeholder updated to status: "saved"
    assert.equal(updatedMedia.length, 1);
    assert.equal(updatedMedia[0].id, result.mediaId);
    assert.equal(updatedMedia[0].status, "saved");
  });

  it("marks new placeholder 'failed' (keeping is_primary = true) and throws 503 QUEUE_DISPATCH_FAILED on dispatch error", async () => {
    const { service, updatedMedia, primarySwaps } = createEditMocks({
      launchImpl: async () => {
        const err = new Error("Redis unavailable");
        err.code = "QUEUE_DISPATCH_FAILED";
        throw err;
      },
    });

    let caught = null;
    try {
      await service.requestImageEdit(baseEditRequest);
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, "must throw on QUEUE_DISPATCH_FAILED");
    assert.equal(caught.statusCode, 503);
    assert.equal(caught.code, "QUEUE_DISPATCH_FAILED");
    assert.equal(caught.workflowId, "wf-edit-1");
    assert.ok(caught.mediaId);
    assert.deepEqual(caught.mediaIds, [caught.mediaId]);

    // Primary swap was executed once and NOT reverted
    assert.equal(primarySwaps.length, 1);
    assert.equal(primarySwaps[0].mediaId, caught.mediaId);

    // Placeholder updated to status: "failed"
    assert.equal(updatedMedia.length, 1);
    assert.equal(updatedMedia[0].id, caught.mediaId);
    assert.equal(updatedMedia[0].status, "failed");
  });

  it("strips parameters.prompt so client input cannot overwrite the deterministic edit prompt passed to modelValidator or executionEngine", async () => {
    const validatorInputs = [];
    const { service, createdMedia, launchCalls } = createEditMocks();
    const originalValidator = service.modelValidator;
    service.modelValidator = (model, input) => {
      validatorInputs.push({ model, input: { ...input } });
      return originalValidator(model, input);
    };

    const result = await service.requestImageEdit({
      ...baseEditRequest,
      parameters: {
        prompt: "malicious override prompt that must be stripped",
        resolution: "2k",
      },
    });

    assert.equal(result.ok, true);
    assert.equal(validatorInputs.length, 1);
    assert.equal(validatorInputs[0].input.prompt, baseEditRequest.prompt);
    assert.notEqual(validatorInputs[0].input.prompt, "malicious override prompt that must be stripped");

    assert.equal(launchCalls.length, 1);
    assert.equal(launchCalls[0].input.prompt, baseEditRequest.prompt);
    assert.equal("prompt" in launchCalls[0].input.parameters, false);
    assert.equal(createdMedia[0].generation_config.prompt, baseEditRequest.prompt);
    assert.equal("prompt" in createdMedia[0].generation_config.parameters, false);
  });

  it("preserves is_primary = true across appendMediaToWorkflow -> completeMedia so getPrimaryMedia still returns the completed edit for chained edits", async () => {
    const wfId = "wf-chained-edit-regression-1";
    const originalMediaId = "media-chained-orig-1";
    const editMediaId = "media-chained-edit-2";
    const workflowMediaRepo = new WorkflowMediaRepository();
    const mediaStore = new Map();

    // Seed original primary media in the workflow
    mediaStore.set(originalMediaId, {
      id: originalMediaId,
      project_id: "proj-1",
      step_id: "image_generation",
      url: "https://cdn.example.com/orig.png",
      status: "success",
      width: 1024,
      height: 1024,
    });
    await workflowMediaRepo.linkMedia({
      workflowId: wfId,
      mediaId: originalMediaId,
      role: "output",
      is_primary: true,
    });

    const mockMediaRepo = {
      createMedia: async (m) => {
        const record = { ...m };
        mediaStore.set(record.id, record);
        return record;
      },
      findById: async (id) => mediaStore.get(id) || null,
      updateFields: async (id, patch) => {
        const next = { ...(mediaStore.get(id) || { id }), ...patch };
        mediaStore.set(id, next);
        return next;
      },
    };

    const mockDb = {
      media: mockMediaRepo,
      workflowMedia: workflowMediaRepo,
    };

    // 1. Append new edit placeholder and promote to is_primary = true
    await appendMediaToWorkflow(mockDb, {
      workflow_id: wfId,
      mediaData: {
        id: editMediaId,
        project_id: "proj-1",
        step_id: "image_relight",
        url: null,
        width: 1024,
        height: 1024,
        generation_config: {
          prompt: baseEditRequest.prompt,
          model: "nanobana_2",
          edit_type: "relight",
          source_media_id: originalMediaId,
          edit_settings: baseEditRequest.editSettings,
        },
      },
      setAsPrimary: true,
      initialStatus: "processing",
    });

    const primaryBeforeComplete = await workflowMediaRepo.getPrimaryMedia(wfId);
    assert.equal(primaryBeforeComplete?.media_id, editMediaId);
    assert.equal(primaryBeforeComplete?.is_primary, true);

    // 2. Worker completes media via completeMedia({ workflowId, role: "output" })
    const completed = await completeMedia({
      mediaId: editMediaId,
      url: "https://cdn.example.com/relight-result.png",
      finalPrompt: "Enhanced relight prompt",
      workflowId: wfId,
      role: "output",
      mediaRepository: mockMediaRepo,
      workflowMediaRepository: workflowMediaRepo,
    });

    assert.equal(completed.status, "success");
    assert.equal(completed.url, "https://cdn.example.com/relight-result.png");

    const persisted = mediaStore.get(editMediaId);
    assert.equal(persisted.generation_config.source_media_id, originalMediaId);
    assert.equal(persisted.generation_config.edit_type, "relight");
    assert.deepEqual(persisted.generation_config.edit_settings, baseEditRequest.editSettings);
    assert.equal(persisted.generation_config.prompt_optimized, "Enhanced relight prompt");

    // 3. getPrimaryMedia(wfId) must STILL return the completed edit media with is_primary: true
    const primaryAfterComplete = await workflowMediaRepo.getPrimaryMedia(wfId);
    assert.ok(primaryAfterComplete, "getPrimaryMedia must NOT return null after completeMedia");
    assert.equal(primaryAfterComplete.media_id, editMediaId);
    assert.equal(primaryAfterComplete.is_primary, true);
  });

  it("falls back to failed primary's valid source_media_id on the same workflow without reverting is_primary", async () => {
    const validOriginal = {
      id: "media-orig-1",
      url: "https://cdn.example.com/workflows/wf-edit-1/orig.png",
      status: "success",
      role: "output",
      width: 1920,
      height: 1080,
      generation_config: { aspect_ratio: "16:9" },
    };
    const failedPrimary = {
      id: "media-failed-2",
      url: null,
      status: "failed",
      role: "output",
      is_primary: true,
      width: 1920,
      height: 1080,
      generation_config: {
        aspect_ratio: "16:9",
        source_media_id: "media-orig-1",
        edit_type: "relight",
      },
    };

    const { service, createdMedia, primarySwaps, launchCalls } = createEditMocks({
      primaryMedia: failedPrimary,
      workflowMediaList: [validOriginal, failedPrimary],
    });

    const result = await service.requestImageEdit(baseEditRequest);

    assert.equal(result.ok, true);
    assert.equal(result.status, "processing");
    assert.equal(result.sourceMediaId, "media-orig-1");
    assert.equal(createdMedia.length, 1);
    assert.equal(createdMedia[0].generation_config.source_media_id, "media-orig-1");
    assert.notEqual(createdMedia[0].generation_config.source_media_id, "media-failed-2");
    assert.equal(createdMedia[0].width, 1920);
    assert.equal(createdMedia[0].height, 1080);
    assert.equal(launchCalls.length, 1);
    assert.equal(launchCalls[0].input.source_image_url, validOriginal.url);
    assert.equal(launchCalls[0].input.source_media_id, "media-orig-1");
    assert.equal(primarySwaps.length, 1);
    assert.deepEqual(primarySwaps[0], { workflowId: "wf-edit-1", mediaId: result.mediaId });
  });

  it("falls back to latest completed non-reference media when failed primary lacks a valid in-workflow source_media_id", async () => {
    const olderSuccess = {
      id: "media-v1",
      url: "https://cdn.example.com/workflows/wf-edit-1/v1.png",
      status: "success",
      role: "original",
      width: 1024,
      height: 1024,
      generation_config: { aspect_ratio: "1:1" },
    };
    const newerSuccess = {
      id: "media-v2",
      url: "https://cdn.example.com/workflows/wf-edit-1/v2.png",
      status: "success",
      role: "output",
      width: 1280,
      height: 720,
      generation_config: { aspect_ratio: "16:9" },
    };
    const refAttachment = {
      id: "media-ref-attach",
      url: "https://cdn.example.com/workflows/wf-edit-1/ref.png",
      status: "success",
      role: "reference",
      width: 512,
      height: 512,
    };
    const failedPrimaryWithForeignSource = {
      id: "media-failed-3",
      url: null,
      status: "failed",
      role: "output",
      is_primary: true,
      generation_config: { source_media_id: "media-from-another-workflow" },
    };

    const { service, createdMedia, launchCalls } = createEditMocks({
      primaryMedia: failedPrimaryWithForeignSource,
      workflowMediaList: [olderSuccess, newerSuccess, refAttachment, failedPrimaryWithForeignSource],
    });

    const result = await service.requestImageEdit(baseEditRequest);

    assert.equal(result.ok, true);
    assert.equal(result.sourceMediaId, "media-v2");
    assert.equal(createdMedia[0].generation_config.source_media_id, "media-v2");
    assert.equal(createdMedia[0].width, 1280);
    assert.equal(createdMedia[0].height, 720);
    assert.equal(launchCalls[0].input.source_image_url, newerSuccess.url);
    assert.equal(launchCalls[0].input.source_media_id, "media-v2");
  });

  it("recovers after INSUFFICIENT_CREDITS (saved primary stays is_primary = true) on subsequent requestImageEdit", async () => {
    const wfId = "wf-recover-insufficient-credits-1";
    const origMediaId = "media-ic-orig-1";
    const workflowMediaRepo = new WorkflowMediaRepository();
    const mediaStore = new Map();

    mediaStore.set(origMediaId, {
      id: origMediaId,
      project_id: "proj-1",
      step_id: "image_generation",
      url: "https://cdn.example.com/workflows/wf-ic/orig.png",
      status: "success",
      width: 1024,
      height: 1024,
      generation_config: { aspect_ratio: "1:1" },
    });
    await workflowMediaRepo.linkMedia({
      workflowId: wfId,
      mediaId: origMediaId,
      role: "output",
      is_primary: true,
    });

    let shouldFailCredits = true;
    const launchCalls = [];
    const service = new GenerationRequestService({
      db: {
        workflows: {
          findById: async (id) => (id === wfId ? { id: wfId, project_id: "proj-1", user_id: "user-1" } : null),
        },
        trash: { getTrashedWorkflowIdSet: async () => new Set() },
        workflowMedia: workflowMediaRepo,
        media: {
          createMedia: async (m) => {
            const record = { ...m };
            mediaStore.set(record.id, record);
            return record;
          },
          findById: async (id) => mediaStore.get(id) || null,
          updateMedia: async (id, patch) => {
            const next = { ...(mediaStore.get(id) || { id }), ...patch };
            mediaStore.set(id, next);
            return next;
          },
        },
      },
      executionEngine: {
        launch: async (args) => {
          launchCalls.push(args);
          if (shouldFailCredits) {
            const err = new Error("Not enough credits");
            err.code = "INSUFFICIENT_CREDITS";
            throw err;
          }
          return { jobId: "job-ic-retry-2", executionId: args.executionId, cost: { totalCredits: 13 } };
        },
      },
      folderService: {},
    });

    // Call 1: hits INSUFFICIENT_CREDITS -> saved placeholder MUST remain is_primary = true
    const first = await service.requestImageEdit({ ...baseEditRequest, workflowId: wfId });
    assert.equal(first.status, "saved");
    assert.equal(first.needsCredits, true);
    const primaryAfterSaved = await workflowMediaRepo.getPrimaryMedia(wfId);
    assert.equal(primaryAfterSaved?.media_id, first.mediaId, "saved edit must stay is_primary = true");
    assert.equal(mediaStore.get(first.mediaId)?.status, "saved");
    assert.equal(mediaStore.get(first.mediaId)?.url, null);

    // Call 2: user tops up credits and retries edit on the same workflow -> must NOT throw 400 PRIMARY_MEDIA_INVALID
    shouldFailCredits = false;
    const second = await service.requestImageEdit({ ...baseEditRequest, workflowId: wfId });
    assert.equal(second.ok, true);
    assert.equal(second.status, "processing");
    assert.equal(second.sourceMediaId, origMediaId);
    assert.notEqual(second.mediaId, first.mediaId);
    assert.equal(mediaStore.get(second.mediaId)?.generation_config?.source_media_id, origMediaId);
    assert.equal(launchCalls[1].input.source_image_url, "https://cdn.example.com/workflows/wf-ic/orig.png");
    assert.equal(launchCalls[1].input.source_media_id, origMediaId);

    const primaryAfterRetry = await workflowMediaRepo.getPrimaryMedia(wfId);
    assert.equal(primaryAfterRetry?.media_id, second.mediaId, "new retry edit must now be promoted to is_primary = true");
  });

  it("recovers after failed edit (failed primary stays is_primary = true) on subsequent requestImageEdit", async () => {
    const wfId = "wf-recover-failed-edit-1";
    const origMediaId = "media-fail-orig-1";
    const workflowMediaRepo = new WorkflowMediaRepository();
    const mediaStore = new Map();

    mediaStore.set(origMediaId, {
      id: origMediaId,
      project_id: "proj-1",
      step_id: "image_generation",
      url: "https://cdn.example.com/workflows/wf-fail/orig.png",
      status: "success",
      width: 1024,
      height: 1536,
      generation_config: { aspect_ratio: "2:3" },
    });
    await workflowMediaRepo.linkMedia({
      workflowId: wfId,
      mediaId: origMediaId,
      role: "output",
      is_primary: true,
    });

    let shouldFailDispatch = true;
    const launchCalls = [];
    const service = new GenerationRequestService({
      db: {
        workflows: {
          findById: async (id) => (id === wfId ? { id: wfId, project_id: "proj-1", user_id: "user-1" } : null),
        },
        trash: { getTrashedWorkflowIdSet: async () => new Set() },
        workflowMedia: workflowMediaRepo,
        media: {
          createMedia: async (m) => {
            const record = { ...m };
            mediaStore.set(record.id, record);
            return record;
          },
          findById: async (id) => mediaStore.get(id) || null,
          updateMedia: async (id, patch) => {
            const next = { ...(mediaStore.get(id) || { id }), ...patch };
            mediaStore.set(id, next);
            return next;
          },
        },
      },
      executionEngine: {
        launch: async (args) => {
          launchCalls.push(args);
          if (shouldFailDispatch) {
            const err = new Error("Redis unavailable");
            err.code = "QUEUE_DISPATCH_FAILED";
            throw err;
          }
          return { jobId: "job-fail-retry-2", executionId: args.executionId, cost: { totalCredits: 13 } };
        },
      },
      folderService: {},
    });

    // Call 1: fails -> failed placeholder MUST remain is_primary = true
    let failedMediaId = null;
    await assert.rejects(
      () => service.requestImageEdit({ ...baseEditRequest, workflowId: wfId }),
      (err) => {
        assert.equal(err.statusCode, 503);
        assert.equal(err.code, "QUEUE_DISPATCH_FAILED");
        failedMediaId = err.mediaId;
        return true;
      }
    );
    assert.ok(failedMediaId);
    const primaryAfterFailure = await workflowMediaRepo.getPrimaryMedia(wfId);
    assert.equal(primaryAfterFailure?.media_id, failedMediaId, "failed edit must stay is_primary = true");
    assert.equal(mediaStore.get(failedMediaId)?.status, "failed");

    // Call 2: subsequent edit on the same workflow succeeds using origMediaId
    shouldFailDispatch = false;
    const recovered = await service.requestImageEdit({ ...baseEditRequest, workflowId: wfId });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.status, "processing");
    assert.equal(recovered.sourceMediaId, origMediaId);
    assert.equal(mediaStore.get(recovered.mediaId)?.generation_config?.source_media_id, origMediaId);
    assert.equal(launchCalls[1].input.source_image_url, "https://cdn.example.com/workflows/wf-fail/orig.png");
    assert.equal(launchCalls[1].input.source_media_id, origMediaId);

    const primaryAfterRecovery = await workflowMediaRepo.getPrimaryMedia(wfId);
    assert.equal(primaryAfterRecovery?.media_id, recovered.mediaId);
  });

  it("still throws 400 PRIMARY_MEDIA_INVALID when workflow has zero valid completed non-reference media", async () => {
    const failedOnlyPrimary = {
      id: "media-only-failed-1",
      url: null,
      status: "failed",
      role: "output",
      is_primary: true,
    };
    const savedRow = {
      id: "media-only-saved-2",
      url: null,
      status: "saved",
      role: "output",
    };
    const refOnlyRow = {
      id: "media-only-ref-3",
      url: "https://cdn.example.com/ref-only.png",
      status: "success",
      role: "reference",
    };

    const { service, createdMedia } = createEditMocks({
      primaryMedia: failedOnlyPrimary,
      workflowMediaList: [savedRow, refOnlyRow, failedOnlyPrimary],
    });

    await assert.rejects(
      () => service.requestImageEdit(baseEditRequest),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, "PRIMARY_MEDIA_INVALID");
        return true;
      }
    );
    assert.equal(createdMedia.length, 0);
  });
});

describe("POST /api/images/remove-background — Direct & Guided Bria Models + Project Data Config", () => {
  it("mounts POST /remove-background on imagesRouter and delegates both Bria models cleanly", async () => {
    const route = imagesRouter.stack.find((l) => l.route?.path === "/remove-background");
    assert.ok(route, "imagesRouter must mount /remove-background");
    assert.equal(route.route.methods.post, true);

    const wfId = "wf-rmbg-ctrl-1";
    const userId = "user-rmbg-ctrl-1";
    const calls = [];

    const origRequestImageEdit = generationRequestService.requestImageEdit;
    const origFindById = db.workflows.findById;
    const origGetWorkflow = db.workflows.getWorkflow;
    const origFindByUser = db.projects.findByUser;

    try {
      generationRequestService.requestImageEdit = async (args) => {
        calls.push(args);
        return {
          ok: true,
          status: "processing",
          needsCredits: false,
          workflowId: args.workflowId,
          mediaId: "media-rmbg-new",
          sourceMediaId: "media-rmbg-src",
          cost: args.model === "bria_remove_background_guided" ? 4 : 3,
        };
      };
      db.workflows.findById = async (id) =>
        id === wfId ? { id: wfId, project_id: "proj-rmbg-1", user_id: userId } : null;
      db.workflows.getWorkflow = db.workflows.findById;
      db.projects.findByUser = async (uid, pid) =>
        uid === userId && pid === "proj-rmbg-1" ? [{ id: "proj-rmbg-1", user_id: userId }] : [];

      // 1. Default model -> bria_remove_background_3_0
      const res1 = createMockRes();
      await removeImageBackground({ user: { id: userId }, body: { workflow_id: wfId } }, res1);
      assert.equal(res1.getStatus(), 200);
      assert.equal(calls[0].model, "bria_remove_background_3_0");
      assert.equal(calls[0].useCaseId, "image-remove-background-v3");
      assert.equal(calls[0].editType, "remove_background");
      assert.equal(calls[0].parameters.preserve_alpha, true);

      // 2. Guided model with alias + prompt
      const res2 = createMockRes();
      await removeImageBackground(
        {
          user: { id: userId },
          body: {
            workflow_id: wfId,
            model: "bria/remove-background-guided",
            prompt: "keep only the jacket",
            preserve_alpha: false,
          },
        },
        res2
      );
      assert.equal(res2.getStatus(), 200);
      assert.equal(calls[1].model, "bria_remove_background_guided");
      assert.equal(calls[1].prompt, "keep only the jacket");
      assert.equal(calls[1].parameters.preserve_alpha, false);

      // 3. Rejects unsupported model (e.g. nanobana_2)
      const resBadModel = createMockRes();
      await removeImageBackground({ user: { id: userId }, body: { workflow_id: wfId, model: "nanobana_2" } }, resBadModel);
      assert.equal(resBadModel.getStatus(), 400);
      assert.equal(resBadModel.getPayload().code, "INVALID_MODEL");

      // 4. Rejects prompt on non-guided bria_remove_background_3_0
      const resBadPrompt = createMockRes();
      await removeImageBackground(
        { user: { id: userId }, body: { workflow_id: wfId, model: "bria_remove_background_3_0", prompt: "keep chair" } },
        resBadPrompt
      );
      assert.equal(resBadPrompt.getStatus(), 400);
      assert.equal(resBadPrompt.getPayload().code, "PROMPT_NOT_SUPPORTED_FOR_MODEL");

      // 5. Rejects media_id directly
      const resBadMedia = createMockRes();
      await removeImageBackground({ user: { id: userId }, body: { workflow_id: wfId, media_id: "m-1" } }, resBadMedia);
      assert.equal(resBadMedia.getStatus(), 400);
      assert.equal(resBadMedia.getPayload().code, "MEDIA_ID_NOT_ALLOWED");
    } finally {
      generationRequestService.requestImageEdit = origRequestImageEdit;
      db.workflows.findById = origFindById;
      db.workflows.getWorkflow = origGetWorkflow;
      db.projects.findByUser = origFindByUser;
    }
  });

  it("GET /api/workflows/project-data/:project_id includes both Bria remove-background models in modelConfig", async () => {
    const res = createMockRes();
    await getProjectData({ params: { project_id: "null" }, user: { id: "user-1" } }, res);
    assert.equal(res.getStatus(), 200);

    const models = res.getPayload()?.result?.data?.json?.modelConfig?.models || [];
    const direct = models.find((m) => m.key === "bria_remove_background_3_0");
    const guided = models.find((m) => m.key === "bria_remove_background_guided");

    assert.ok(direct, "project-data modelConfig must include bria_remove_background_3_0");
    assert.ok(guided, "project-data modelConfig must include bria_remove_background_guided");
    assert.equal(direct.category, "remove_background");
    assert.equal(guided.category, "remove_background");
    assert.deepEqual(direct.supportedModes, ["remove_background"]);
    assert.deepEqual(guided.supportedModes, ["remove_background"]);
    assert.equal(direct.pricing.defaultCost, 3);
    assert.equal(guided.pricing.defaultCost, 4);
    assert.ok(guided.parameters.prompt, "guided model config must expose optional prompt parameter");
    assert.equal(direct.parameters.prompt, undefined, "direct 3.0 model config must not expose prompt parameter");
  });
});

describe("POST /api/images/edit — General In-Place Image Edit (Dynamic Edit-Capable Models + References)", () => {
  it("mounts POST /edit, validates edit-capable models & references, enforces ownership, and delegates to image-edit-v3", async () => {
    const route = imagesRouter.stack.find((l) => l.route?.path === "/edit");
    assert.ok(route, "imagesRouter must mount /edit");
    assert.equal(route.route.methods.post, true);

    const wfId = "wf-edit-ctrl-1";
    const refWfId = "wf-ref-ctrl-2";
    const userId = "user-edit-ctrl-1";
    const calls = [];

    const origRequestImageEdit = generationRequestService.requestImageEdit;
    const origFindById = db.workflows.findById;
    const origGetWorkflow = db.workflows.getWorkflow;
    const origFindByUser = db.projects.findByUser;

    try {
      generationRequestService.requestImageEdit = async (args) => {
        calls.push(args);
        return {
          ok: true,
          status: "processing",
          needsCredits: false,
          workflowId: args.workflowId,
          mediaId: "media-edit-new",
          sourceMediaId: "media-edit-src",
          cost: 13,
        };
      };
      db.workflows.findById = async (id) =>
        id === wfId || id === refWfId ? { id, project_id: "proj-edit-1", user_id: userId } : null;
      db.workflows.getWorkflow = db.workflows.findById;
      db.projects.findByUser = async (uid, pid) =>
        uid === userId && pid === "proj-edit-1" ? [{ id: "proj-edit-1", user_id: userId }] : [];

      // 1. Default model (nanobana_2) + prompt + references
      const res1 = createMockRes();
      await editImage(
        {
          user: { id: userId },
          body: {
            workflow_id: wfId,
            prompt: "Change the jacket to red leather",
            references: [refWfId],
            parameters: { resolution: "2k" },
          },
        },
        res1
      );
      assert.equal(res1.getStatus(), 200);
      assert.equal(calls[0].model, "nanobana_2");
      assert.equal(calls[0].useCaseId, "image-edit-v3");
      assert.equal(calls[0].editType, "edit");
      assert.equal(calls[0].stepId, "image_edit");
      assert.deepEqual(calls[0].references, [refWfId]);
      assert.equal(calls[0].parameters.resolution, "2k");

      // 2. Explicit edit-capable model (gpt_image_2 / nanobana_pro)
      const res2 = createMockRes();
      await editImage(
        {
          user: { id: userId },
          body: { workflow_id: wfId, model: "nanobana_pro", prompt: "Add sunset glow" },
        },
        res2
      );
      assert.equal(res2.getStatus(), 200);
      assert.equal(calls[1].model, "nanobana_pro");

      // 3. Rejects non-edit-capable image model (seedream_v5)
      const resSeedream = createMockRes();
      await editImage(
        {
          user: { id: userId },
          body: { workflow_id: wfId, model: "seedream_v5", prompt: "Add sunglasses" },
        },
        resSeedream
      );
      assert.equal(resSeedream.getStatus(), 400);
      assert.equal(resSeedream.getPayload().code, "MODEL_NOT_EDIT_CAPABLE");

      // 4. Rejects missing prompt
      const resNoPrompt = createMockRes();
      await editImage({ user: { id: userId }, body: { workflow_id: wfId } }, resNoPrompt);
      assert.equal(resNoPrompt.getStatus(), 400);
      assert.equal(resNoPrompt.getPayload().code, "MISSING_PROMPT");

      // 5. Rejects raw URL in references
      const resRawRef = createMockRes();
      await editImage(
        {
          user: { id: userId },
          body: { workflow_id: wfId, prompt: "Add hat", references: ["https://evil.com/x.png"] },
        },
        resRawRef
      );
      assert.equal(resRawRef.getStatus(), 400);
      assert.equal(resRawRef.getPayload().code, "DIRECT_URL_NOT_ALLOWED");

      // 6. Rejects media_id directly
      const resMediaId = createMockRes();
      await editImage(
        { user: { id: userId }, body: { workflow_id: wfId, media_id: "m-1", prompt: "Add hat" } },
        resMediaId
      );
      assert.equal(resMediaId.getStatus(), 400);
      assert.equal(resMediaId.getPayload().code, "MEDIA_ID_NOT_ALLOWED");

      // 7. Rejects raw URL in characters or elements
      const resBadCharUrl = createMockRes();
      await editImage(
        {
          user: { id: userId },
          body: { workflow_id: wfId, prompt: "Add char", characters: ["https://evil.com/c.png"] },
        },
        resBadCharUrl
      );
      assert.equal(resBadCharUrl.getStatus(), 400);
      assert.equal(resBadCharUrl.getPayload().code, "DIRECT_URL_NOT_ALLOWED");

      const resBadElemUrl = createMockRes();
      await editImage(
        {
          user: { id: userId },
          body: { workflow_id: wfId, prompt: "Add elem", elements: ["https://evil.com/e.png"] },
        },
        resBadElemUrl
      );
      assert.equal(resBadElemUrl.getStatus(), 400);
      assert.equal(resBadElemUrl.getPayload().code, "DIRECT_URL_NOT_ALLOWED");
    } finally {
      generationRequestService.requestImageEdit = origRequestImageEdit;
      db.workflows.findById = origFindById;
      db.workflows.getWorkflow = origGetWorkflow;
      db.projects.findByUser = origFindByUser;
    }
  });

  it("enforces model.parameters.images.max - 1 cap upfront on POST /api/images/edit (400 TOO_MANY_REFERENCES)", async () => {
    const wfId = "wf-edit-cap-1";
    const userId = "user-edit-cap-1";
    const calls = [];

    const origRequestImageEdit = generationRequestService.requestImageEdit;
    const origFindById = db.workflows.findById;
    const origGetWorkflow = db.workflows.getWorkflow;
    const origFindByUser = db.projects.findByUser;

    try {
      generationRequestService.requestImageEdit = async (args) => {
        calls.push(args);
        return {
          ok: true,
          status: "processing",
          needsCredits: false,
          workflowId: args.workflowId,
          mediaId: "media-cap-ok",
          sourceMediaId: "media-cap-src",
          cost: 13,
        };
      };
      db.workflows.findById = async (id) => ({ id, project_id: "proj-cap-1", user_id: userId });
      db.workflows.getWorkflow = db.workflows.findById;
      db.projects.findByUser = async (uid, pid) =>
        uid === userId && pid === "proj-cap-1" ? [{ id: "proj-cap-1", user_id: userId }] : [];

      // nanobana_2 has images.max = 14 -> max 13 additional references (1 slot reserved for source image)
      const thirteenRefs = Array.from({ length: 13 }, (_, i) => `wf-ref-${i + 1}`);
      const resOk13 = createMockRes();
      await editImage(
        {
          user: { id: userId },
          body: {
            workflow_id: wfId,
            model: "nanobana_2",
            prompt: "Add all 13 references",
            references: [...thirteenRefs, wfId, thirteenRefs[0]], // duplicate + target wfId do not inflate count
          },
        },
        resOk13
      );
      assert.equal(resOk13.getStatus(), 200);
      assert.equal(calls.length, 1);

      // 14 additional references across references + characters + elements exceeds nanobana_2 cap (13) -> 400
      const resTooManyNano = createMockRes();
      await editImage(
        {
          user: { id: userId },
          body: {
            workflow_id: wfId,
            model: "nanobana_2",
            prompt: "Add too many refs",
            references: Array.from({ length: 10 }, (_, i) => `wf-ref-${i + 1}`),
            characters: ["char-1", "char-2"],
            elements: ["elem-1", "elem-2"],
          },
        },
        resTooManyNano
      );
      assert.equal(resTooManyNano.getStatus(), 400);
      assert.equal(resTooManyNano.getPayload().code, "TOO_MANY_REFERENCES");

      // gpt_image_2 has images.max = 16 -> max 15 additional references
      const resOkGpt15 = createMockRes();
      await editImage(
        {
          user: { id: userId },
          body: {
            workflow_id: wfId,
            model: "gpt_image_2",
            prompt: "Add 15 refs",
            references: Array.from({ length: 15 }, (_, i) => `wf-gpt-${i + 1}`),
          },
        },
        resOkGpt15
      );
      assert.equal(resOkGpt15.getStatus(), 200);

      const resTooManyGpt16 = createMockRes();
      await editImage(
        {
          user: { id: userId },
          body: {
            workflow_id: wfId,
            model: "gpt_image_2",
            prompt: "Add 16 refs",
            references: Array.from({ length: 16 }, (_, i) => `wf-gpt-${i + 1}`),
          },
        },
        resTooManyGpt16
      );
      assert.equal(resTooManyGpt16.getStatus(), 400);
      assert.equal(resTooManyGpt16.getPayload().code, "TOO_MANY_REFERENCES");
    } finally {
      generationRequestService.requestImageEdit = origRequestImageEdit;
      db.workflows.findById = origFindById;
      db.workflows.getWorkflow = origGetWorkflow;
      db.projects.findByUser = origFindByUser;
    }
  });

  it("forwards characters and elements from POST /api/images/edit through GenerationRequestService into imageEditV3 -> ResolveRefsNode", async () => {
    const wfId = "wf-edit-char-elem-1";
    const charId = "char-edit-1";
    const elemId = "elem-edit-1";
    const refWfId = "wf-edit-ref-2";
    const userId = "user-edit-ce-1";

    const origRequestImageEdit = generationRequestService.requestImageEdit;
    const origFindById = db.workflows.findById;
    const origGetWorkflow = db.workflows.getWorkflow;
    const origFindByUser = db.projects.findByUser;
    const origCharFind = db.characters.findByCharacterId;
    const origElemResolve = db.elements.resolveRecord;

    let launchedArgs = null;
    const service = new GenerationRequestService({
      db: {
        workflows: {
          findById: async (id) => (id === wfId ? { id: wfId, project_id: "proj-ce-1", user_id: userId } : null),
        },
        trash: { getTrashedWorkflowIdSet: async () => new Set() },
        workflowMedia: {
          getPrimaryMedia: async () => ({
            id: "media-src-ce-1",
            url: "https://cdn.example.com/workflows/wf-ce/primary.png",
            status: "success",
            width: 1024,
            height: 1024,
            generation_config: { aspect_ratio: "1:1" },
          }),
          linkMedia: async (l) => l,
          setPrimaryMedia: async (p) => p,
        },
        media: {
          createMedia: async (m) => m,
          updateMedia: async (id, patch) => ({ id, ...patch }),
        },
      },
      executionEngine: {
        launch: async (args) => {
          launchedArgs = args;
          return { jobId: "job-ce-1", executionId: args.executionId, cost: { totalCredits: 13 } };
        },
      },
      folderService: {},
    });

    try {
      generationRequestService.requestImageEdit = service.requestImageEdit.bind(service);
      db.workflows.findById = async (id) =>
        [wfId, refWfId, charId, elemId].includes(id)
          ? { id, project_id: "proj-ce-1", user_id: userId }
          : null;
      db.workflows.getWorkflow = db.workflows.findById;
      db.projects.findByUser = async (uid, pid) =>
        uid === userId && pid === "proj-ce-1" ? [{ id: "proj-ce-1", user_id: userId }] : [];
      db.characters.findByCharacterId = async (id) =>
        id === charId ? { id: charId, workflow_id: charId, project_id: "proj-ce-1", user_id: userId } : null;
      db.elements.resolveRecord = async (id) =>
        id === elemId ? { id: elemId, workflow_id: elemId } : null;

      const res = createMockRes();
      await editImage(
        {
          user: { id: userId },
          body: {
            workflow_id: wfId,
            model: "nanobana_2",
            prompt: `Place <character:${charId}> holding <element:${elemId}> next to the lamp`,
            references: [refWfId],
            characters: [charId],
            elements: [elemId],
          },
        },
        res
      );

      assert.equal(res.getStatus(), 200);
      assert.ok(launchedArgs, "ExecutionEngine.launch must be called");
      assert.deepEqual(launchedArgs.input.references, [refWfId]);
      assert.deepEqual(launchedArgs.input.characters, [charId]);
      assert.deepEqual(launchedArgs.input.elements, [elemId]);

      // Execute full 4-node imageEditV3 DAG with the exact runtime input forwarded by requestImageEdit
      const executor = new WorkflowExecutor(createDefaultV3NodeRegistry());
      let capturedGenerateImages = null;
      const execResult = await executor.execute({
        workflow: imageEditV3,
        input: launchedArgs.input,
        context: {
          userId,
          assertOwns: async () => true,
          assertOwnsAny: async () => true,
          getCharacterPromptContext: async ({ characterId }) => {
            if (characterId !== charId) throw new Error("Character not found");
            return {
              id: characterId,
              workflowId: characterId,
              name: "Nova",
              description: "Cyber courier",
              traits: { visor: "amber" },
              referenceMediaUrls: ["https://cdn.example.com/nova-sheet.png"],
            };
          },
          getElementPromptContext: async ({ elementIds }) => {
            if (!elementIds.includes(elemId)) throw new Error("Element not found");
            return {
              elements: [
                {
                  id: elemId,
                  workflowId: elemId,
                  name: "Plasma Lantern",
                  description: "Floating glass lantern",
                  guidelines: "Warm cyan glow",
                  referenceMediaUrls: ["https://cdn.example.com/lantern.png"],
                },
              ],
            };
          },
          getMediaUrls: async () => [],
          getWorkflowPrimaryMedia: async (id) =>
            id === refWfId
              ? { mediaId: "m-ref-wf-2", url: "https://cdn.example.com/ref-wf-2.png", status: "success" }
              : null,
          executeLLM: async () => ({
            text: "Edit @image1 adding @Nova with @Plasma Lantern",
            json: { is_safe: true, prompt: "Edit @image1 adding @Nova with @Plasma Lantern" },
          }),
          executeProvider: async (_model, params) => {
            capturedGenerateImages = params.images;
            return {
              assets: [{ url: "https://cdn.example.com/edit-ce-result.png" }],
              metadata: { model: "nanobana_2", provider: "wavespeed" },
            };
          },
          db: {
            media: {
              findById: async (id) => ({ id, workflow_id: wfId, status: "processing", generation_config: {} }),
              updateMedia: async (id, patch) => ({ id, ...patch }),
            },
            workflowMedia: {
              isMediaLinkedToWorkflow: async () => true,
              linkMedia: async (l) => l,
            },
          },
        },
      });

      assert.equal(execResult.status, "completed");
      const resolved = execResult.nodeOutputs.resolve_refs;
      assert.equal(resolved.status, "success");
      assert.deepEqual(resolved.reference_urls, [
        "https://cdn.example.com/workflows/wf-ce/primary.png",
        "https://cdn.example.com/nova-sheet.png",
        "https://cdn.example.com/lantern.png",
        "https://cdn.example.com/ref-wf-2.png",
      ]);
      assert.deepEqual(capturedGenerateImages, resolved.reference_urls);
      assert.match(resolved.prepared_prompt, /@Nova/);
      assert.match(resolved.prepared_prompt, /@Plasma Lantern/);
      assert.ok(!resolved.prepared_prompt.includes(`<character:${charId}>`));
      assert.ok(!resolved.prepared_prompt.includes(`<element:${elemId}>`));
    } finally {
      generationRequestService.requestImageEdit = origRequestImageEdit;
      db.workflows.findById = origFindById;
      db.workflows.getWorkflow = origGetWorkflow;
      db.projects.findByUser = origFindByUser;
      db.characters.findByCharacterId = origCharFind;
      db.elements.resolveRecord = origElemResolve;
    }
  });
});
