import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import apiRouter from "../../src/api/routes.js";
import { db, useCaseService, folderService, workflowService } from "../../src/container.js";
import { rateLimitRedisConnection, redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { supabase } from "../../lib/supabase.js";
import { resetLimitersForTest } from "../../src/middleware/rateLimit.js";

describe("Generation & Gen-Edit APIs — All Models & Parameters Boundary Suite", () => {
  let server;
  let baseUrl;
  let origGetUser;
  let origVerifyWorkflowOwnership;

  let originalFindByUser;
  let originalFindProjectById;
  let originalFindOwnedFolder;
  let originalCreateWorkflow;
  let originalFindWorkflowById;
  let originalGetWorkflow;
  let originalUpdatePrimaryMedia;
  let originalCreateMedia;
  let originalUpdateMedia;
  let originalFindMediaByIdOrWorkflow;
  let originalFindMediaById;
  let originalLinkMedia;
  let originalFindByCharacterId;
  let originalResolveElementRecord;
  let originalPrepareAndEnqueue;

  let createdWorkflows = [];
  let createdMedia = [];
  let enqueueCalls = [];

  before(async () => {
    process.env.NODE_ENV = "test";
    origGetUser = supabase.auth.getUser;
    supabase.auth.getUser = async (token) => {
      if (token === "token-user-A") return { data: { user: { id: "user-A" } }, error: null };
      if (token === "token-user-B") return { data: { user: { id: "user-B" } }, error: null };
      return { data: { user: null }, error: new Error("Invalid token") };
    };

    const app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
    app.use((err, req, res, next) => {
      res.status(err.statusCode || 500).json({
        ok: false,
        message: err.message,
        code: err.code || "INTERNAL_ERROR",
      });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    supabase.auth.getUser = origGetUser;
    if (origVerifyWorkflowOwnership && workflowService?.authService) {
      workflowService.authService.verifyWorkflowOwnership = origVerifyWorkflowOwnership;
    }
    await Promise.allSettled([
      rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect()),
      redisConnection?.quit().catch(() => redisConnection?.disconnect()),
      workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect()),
    ]);
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    resetLimitersForTest();

    originalFindByUser = db.projects?.findByUser;
    originalFindProjectById = db.projects?.findById;
    originalFindOwnedFolder = db.folders?.findOwnedInProject;
    originalCreateWorkflow = db.workflows?.createWorkflow;
    originalFindWorkflowById = db.workflows?.findById;
    originalGetWorkflow = db.workflows?.getWorkflow;
    originalUpdatePrimaryMedia = db.workflows?.updatePrimaryMedia;
    originalCreateMedia = db.media?.createMedia;
    originalUpdateMedia = db.media?.updateMedia;
    originalFindMediaByIdOrWorkflow = db.media?.findMediaByIdOrWorkflow;
    originalFindMediaById = db.media?.findById;
    originalLinkMedia = db.workflowMedia?.linkMedia;
    originalFindByCharacterId = db.characters?.findByCharacterId;
    originalResolveElementRecord = db.elements?.resolveRecord;
    originalPrepareAndEnqueue = useCaseService?.prepareAndEnqueue;

    createdWorkflows = [];
    createdMedia = [];
    enqueueCalls = [];

    db.projects.findByUser = async (userId, projectId = null) => {
      const all = [
        { id: "proj-A", user_id: "user-A" },
        { id: "proj-B", user_id: "user-B" },
      ];
      return all.filter((p) => p.user_id === userId && (!projectId || p.id === projectId));
    };
    db.projects.findById = async (id) => {
      if (id === "proj-A") return { id: "proj-A", user_id: "user-A" };
      if (id === "proj-B") return { id: "proj-B", user_id: "user-B" };
      return null;
    };

    db.folders.findOwnedInProject = async (folderId, projectId, userId) => {
      if (
        folderId === "00000000-0000-4000-8000-000000000001" &&
        projectId === "proj-A" &&
        userId === "user-A"
      ) {
        return { id: folderId, project_id: "proj-A", user_id: "user-A", name: "Folder A" };
      }
      return null;
    };

    const ownedWorkflowIds = new Set(["wf-img-1", "wf-img-2", "wf-last-frame", "wf-vid-1", "wf-char-A", "wf-elem-A"]);
    db.workflows.createWorkflow = async (wf) => {
      createdWorkflows.push(wf);
      return wf;
    };
    db.workflows.findById = async (id) => {
      if (ownedWorkflowIds.has(id)) {
        return { id, project_id: "proj-A", user_id: "user-A", workflow_type: "GENERATION" };
      }
      if (id === "wf-foreign-B") {
        return { id, project_id: "proj-B", user_id: "user-B", workflow_type: "GENERATION" };
      }
      return null;
    };
    db.workflows.getWorkflow = db.workflows.findById;
    db.workflows.updatePrimaryMedia = async () => ({});

    const ownedMediaIds = new Set(["media-img-1", "media-img-2", "media-last-frame", "media-vid-1"]);
    db.media.createMedia = async (m) => {
      createdMedia.push(m);
      return m;
    };
    db.media.updateMedia = async () => ({});
    db.media.findMediaByIdOrWorkflow = async (id) => {
      if (ownedMediaIds.has(id) || ownedWorkflowIds.has(id)) {
        return { id, workflow_id: "wf-img-1", project_id: "proj-A", url: "https://cdn.example.com/a.png" };
      }
      if (id === "media-foreign-B" || id === "wf-foreign-B") {
        return { id, workflow_id: "wf-foreign-B", project_id: "proj-B", url: "https://cdn.example.com/b.png" };
      }
      return null;
    };
    db.media.findById = db.media.findMediaByIdOrWorkflow;

    if (db.workflowMedia) {
      db.workflowMedia.linkMedia = async () => ({});
    }

    if (db.characters) {
      db.characters.findByCharacterId = async (id) => {
        if (id === "char-A" || id === "wf-char-A") {
          return { id: "char-A", workflow_id: "wf-char-A", project_id: "proj-A", name: "Hero" };
        }
        return null;
      };
    }

    if (db.elements) {
      db.elements.resolveRecord = async (id) => {
        if (id === "elem-A" || id === "wf-elem-A") {
          return { id: "elem-A", workflow_id: "wf-elem-A", project_id: "proj-A", name: "Sword" };
        }
        return null;
      };
    }

    useCaseService.prepareAndEnqueue = async (args) => {
      enqueueCalls.push(args);
      return {
        jobId: `job-${enqueueCalls.length}`,
        executionId: args.executionId,
        cost: { totalCredits: 10 },
      };
    };
  });

  afterEach(() => {
    if (db.projects) {
      db.projects.findByUser = originalFindByUser;
      db.projects.findById = originalFindProjectById;
    }
    if (db.folders) db.folders.findOwnedInProject = originalFindOwnedFolder;
    if (db.workflows) {
      db.workflows.createWorkflow = originalCreateWorkflow;
      db.workflows.findById = originalFindWorkflowById;
      db.workflows.getWorkflow = originalGetWorkflow;
      db.workflows.updatePrimaryMedia = originalUpdatePrimaryMedia;
    }
    if (db.media) {
      db.media.createMedia = originalCreateMedia;
      db.media.updateMedia = originalUpdateMedia;
      db.media.findMediaByIdOrWorkflow = originalFindMediaByIdOrWorkflow;
      db.media.findById = originalFindMediaById;
    }
    if (db.workflowMedia) db.workflowMedia.linkMedia = originalLinkMedia;
    if (db.characters) db.characters.findByCharacterId = originalFindByCharacterId;
    if (db.elements) db.elements.resolveRecord = originalResolveElementRecord;
    if (useCaseService) useCaseService.prepareAndEnqueue = originalPrepareAndEnqueue;
  });

  async function postJson(path, body, token = "token-user-A") { // gate:allow-secret
    resetLimitersForTest();
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
  }

  // ===========================================================================
  // 1. IMAGE GENERATION & GEN-EDIT API (POST /api/images/generated)
  // ===========================================================================
  describe("POST /api/images/generated — All Image Models & Parameters", () => {
    it("nanobana_pro: accepts all valid parameters for text-to-image and gen-edit (input_image, images, resolution, aspect_ratio, output_format)", async () => {
      const resolutions = ["1k", "2k", "4k"];
      const aspectRatios = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
      const formats = ["png", "jpeg"];

      // Test all resolutions & formats in text-to-image
      for (const resolution of resolutions) {
        for (const output_format of formats) {
          const { status, data } = await postJson("/api/images/generated", {
            prompt: `NanoBanana Pro ${resolution} ${output_format}`,
            model: "nanobana_pro",
            project_id: "proj-A",
            parameters: {
              resolution,
              aspect_ratio: "16:9",
              output_format,
            },
          });
          assert.equal(status, 200, `Failed for ${resolution}/${output_format}: ${JSON.stringify(data)}`);
          assert.equal(data.ok, true);
          const lastEnqueued = enqueueCalls.at(-1);
          assert.equal(lastEnqueued.input.parameters.resolution, resolution);
          assert.equal(lastEnqueued.input.parameters.output_format, output_format);
          assert.equal(lastEnqueued.input.parameters.aspect_ratio, "16:9");
        }
      }

      // Test all 10 aspect ratios
      for (const aspect_ratio of aspectRatios) {
        const { status, data } = await postJson("/api/images/generated", {
          prompt: `Aspect ratio ${aspect_ratio}`,
          model: "nanobana_pro",
          project_id: "proj-A",
          parameters: { aspect_ratio },
        });
        assert.equal(status, 200, `Failed for aspect_ratio=${aspect_ratio}: ${JSON.stringify(data)}`);
        assert.equal(enqueueCalls.at(-1).input.parameters.aspect_ratio, aspect_ratio);
      }

      // Test Gen-Edit with input_image + multi-reference images + character/element references + alias model name
      const editRes = await postJson("/api/images/generated", {
        prompt: "Edit portrait with reference style",
        model: "nano-banana-pro",
        project_id: "proj-A",
        folder_id: "00000000-0000-4000-8000-000000000001",
        references: ["char-A", "elem-A"],
        parameters: {
          input_image: "media-img-1",
          images: ["wf-img-1", "wf-img-2"],
          resolution: "4k",
          aspect_ratio: "21:9",
          output_format: "jpeg",
        },
      });
      assert.equal(editRes.status, 200, JSON.stringify(editRes.data));
      const editEnqueued = enqueueCalls.at(-1);
      assert.equal(editEnqueued.input.parameters.input_image, "media-img-1");
      assert.deepEqual(editEnqueued.input.parameters.images, ["wf-img-1", "wf-img-2"]);
      assert.equal(editEnqueued.input.parameters.resolution, "4k");
      assert.equal(editEnqueued.input.parameters.aspect_ratio, "21:9");
      assert.equal(editEnqueued.input.parameters.output_format, "jpeg");
      assert.deepEqual(editEnqueued.input.references, ["char-A", "elem-A"]);
    });

    it("nanobana_2: accepts all valid parameters (0.5k-4k, 14 aspect ratios, enable_web_search, enable_image_search, input_image, images)", async () => {
      const resolutions = ["0.5k", "1k", "2k", "4k"];
      const aspectRatios = [
        "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4",
        "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1",
      ];

      for (const resolution of resolutions) {
        const { status, data } = await postJson("/api/images/generated", {
          prompt: `NanoBanana 2 ${resolution}`,
          model: "nanobana_2",
          project_id: "proj-A",
          parameters: {
            resolution,
            enable_web_search: true,
            enable_image_search: true,
            output_format: "jpeg",
          },
        });
        assert.equal(status, 200, `Failed for ${resolution}: ${JSON.stringify(data)}`);
        const params = enqueueCalls.at(-1).input.parameters;
        assert.equal(params.resolution, resolution);
        assert.equal(params.enable_web_search, true);
        assert.equal(params.enable_image_search, true);
        assert.equal(params.output_format, "jpeg");
      }

      for (const aspect_ratio of aspectRatios) {
        const { status, data } = await postJson("/api/images/generated", {
          prompt: `NB2 ratio ${aspect_ratio}`,
          model: "nanobana_2",
          project_id: "proj-A",
          parameters: {
            aspect_ratio,
            input_image: "wf-img-1",
            images: ["media-img-1", "media-img-2"],
          },
        });
        assert.equal(status, 200, `Failed for aspect_ratio=${aspect_ratio}: ${JSON.stringify(data)}`);
        const params = enqueueCalls.at(-1).input.parameters;
        assert.equal(params.aspect_ratio, aspect_ratio);
        assert.equal(params.input_image, "wf-img-1");
        assert.deepEqual(params.images, ["media-img-1", "media-img-2"]);
      }
    });

    it("nanobana_pro_ultra: accepts 4k/8k resolutions, 10 aspect ratios, output_format, and edit parameters", async () => {
      for (const resolution of ["4k", "8k"]) {
        for (const output_format of ["png", "jpeg"]) {
          const { status, data } = await postJson("/api/images/generated", {
            prompt: `Ultra ${resolution}`,
            model: "nanobana_pro_ultra",
            project_id: "proj-A",
            parameters: {
              resolution,
              aspect_ratio: "3:2",
              output_format,
              input_image: "wf-img-1",
              images: ["media-img-1"],
            },
          });
          assert.equal(status, 200, `Failed for ${resolution}/${output_format}: ${JSON.stringify(data)}`);
          const params = enqueueCalls.at(-1).input.parameters;
          assert.equal(params.resolution, resolution);
          assert.equal(params.output_format, output_format);
          assert.equal(params.aspect_ratio, "3:2");
          assert.equal(params.input_image, "wf-img-1");
        }
      }
    });

    it("seedream_v5: accepts 1k/1.5k/2k resolutions, 15 aspect ratios, prompt_optimization_mode (standard/fast), and output_format", async () => {
      const resolutions = ["1k", "1.5k", "2k"];
      const modes = ["standard", "fast"];
      const aspectRatios = [
        "1:1", "1:2", "2:1", "1:3", "3:1", "2:3", "3:2",
        "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "9:21", "21:9",
      ];

      for (const resolution of resolutions) {
        for (const prompt_optimization_mode of modes) {
          const { status, data } = await postJson("/api/images/generated", {
            prompt: `Seedream ${resolution} ${prompt_optimization_mode}`,
            model: "seedream_v5",
            project_id: "proj-A",
            parameters: {
              resolution,
              prompt_optimization_mode,
              output_format: "png",
            },
          });
          assert.equal(status, 200, JSON.stringify(data));
          const params = enqueueCalls.at(-1).input.parameters;
          assert.equal(params.resolution, resolution);
          assert.equal(params.prompt_optimization_mode, prompt_optimization_mode);
          assert.equal(params.output_format, "png");
        }
      }

      for (const aspect_ratio of aspectRatios) {
        const { status, data } = await postJson("/api/images/generated", {
          prompt: `Seedream ratio ${aspect_ratio}`,
          model: "seedream_v5",
          project_id: "proj-A",
          parameters: { aspect_ratio },
        });
        assert.equal(status, 200, `Failed for ${aspect_ratio}: ${JSON.stringify(data)}`);
        assert.equal(enqueueCalls.at(-1).input.parameters.aspect_ratio, aspect_ratio);
      }
    });

    it("gpt_image_2: accepts 1k/2k/4k resolutions, 15 aspect ratios, quality (low/medium/high), output_format (png/jpeg/webp), and edit inputs", async () => {
      const resolutions = ["1k", "2k", "4k"];
      const qualities = ["low", "medium", "high"];
      const formats = ["png", "jpeg", "webp"];

      for (const resolution of resolutions) {
        for (const quality of qualities) {
          for (const output_format of formats) {
            const { status, data } = await postJson("/api/images/generated", {
              prompt: `GPT Image 2 ${resolution} ${quality} ${output_format}`,
              model: "gpt_image_2",
              project_id: "proj-A",
              parameters: {
                resolution,
                quality,
                output_format,
                aspect_ratio: "9:21",
                input_image: "media-img-1",
                images: ["wf-img-1", "wf-img-2"],
              },
            });
            assert.equal(status, 200, JSON.stringify(data));
            const params = enqueueCalls.at(-1).input.parameters;
            assert.equal(params.resolution, resolution);
            assert.equal(params.quality, quality);
            assert.equal(params.output_format, output_format);
            assert.equal(params.aspect_ratio, "9:21");
            assert.equal(params.input_image, "media-img-1");
            assert.deepEqual(params.images, ["wf-img-1", "wf-img-2"]);
          }
        }
      }
    });

    it("rejects invalid parameters, unknown parameters, direct URLs, and cross-tenant IDs on POST /api/images/generated", async () => {
      // 1. Missing required fields
      const noPrompt = await postJson("/api/images/generated", { model: "nanobana_pro", project_id: "proj-A" });
      assert.equal(noPrompt.status, 400);

      const noProject = await postJson("/api/images/generated", { prompt: "hi", model: "nanobana_pro" });
      assert.equal(noProject.status, 400);

      const noModel = await postJson("/api/images/generated", { prompt: "hi", project_id: "proj-A" });
      assert.equal(noModel.status, 400);

      // 2. Invalid enum values per model
      const invalidEnumCases = [
        { model: "nanobana_pro", parameters: { resolution: "8k" } },
        { model: "nanobana_pro", parameters: { aspect_ratio: "1:8" } },
        { model: "nanobana_pro", parameters: { output_format: "webp" } },
        { model: "nanobana_pro_ultra", parameters: { resolution: "1k" } },
        { model: "nanobana_2", parameters: { resolution: "8k" } },
        { model: "seedream_v5", parameters: { prompt_optimization_mode: "turbo" } },
        { model: "gpt_image_2", parameters: { quality: "hd" } },
      ];
      for (const tc of invalidEnumCases) {
        const res = await postJson("/api/images/generated", {
          prompt: "test invalid enum",
          model: tc.model,
          project_id: "proj-A",
          parameters: tc.parameters,
        });
        assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(tc)}, got ${res.status}`);
      }

      // 3. Unknown / unsupported parameters per model
      const unknownParamCases = [
        { model: "nanobana_pro", parameters: { enable_web_search: true } },
        { model: "nanobana_2", parameters: { quality: "high" } },
        { model: "seedream_v5", parameters: { input_image: "wf-img-1" } },
        { model: "gpt_image_2", parameters: { negative_prompt: "blurry" } },
        { model: "gpt_image_2", parameters: { seed: 123 } },
      ];
      for (const tc of unknownParamCases) {
        const res = await postJson("/api/images/generated", {
          prompt: "test unknown param",
          model: tc.model,
          project_id: "proj-A",
          parameters: tc.parameters,
        });
        assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(tc)}, got ${res.status}`);
      }

      // 4. Direct URLs rejected with 400
      const directUrlCases = [
        { input_image: "wf-img-1" }, // top-level input_image forbidden
        { image_url: "https://evil.example.com/a.png" },
        { references: ["https://evil.example.com/a.png"] },
        { parameters: { input_image: "https://evil.example.com/a.png" } },
      ];
      for (const extra of directUrlCases) {
        const res = await postJson("/api/images/generated", {
          prompt: "direct url test",
          model: "nanobana_pro",
          project_id: "proj-A",
          ...extra,
        });
        assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(extra)}, got ${res.status}`);
      }

      // 5. Cross-tenant project or media returns 404 (never 403)
      const crossProject = await postJson("/api/images/generated", {
        prompt: "cross project",
        model: "nanobana_pro",
        project_id: "proj-B",
      });
      assert.equal(crossProject.status, 404);

      const crossMedia = await postJson("/api/images/generated", {
        prompt: "cross media",
        model: "nanobana_pro",
        project_id: "proj-A",
        parameters: { input_image: "media-foreign-B" },
      });
      assert.equal(crossMedia.status, 404);
    });
  });

  // ===========================================================================
  // 2. VIDEO GENERATION, I2V, KEYFRAME, EXTEND & RETAKE API (POST /api/video/generated)
  // ===========================================================================
  describe("POST /api/video/generated — All Video Models & Parameters", () => {
    it("wan_3_0: accepts all valid parameters for text-to-video, image-to-video, and keyframe interpolation", async () => {
      const durations = [5, 10];
      const aspectRatios = ["16:9", "9:16", "1:1", "4:3", "3:4"];
      const resolutions = ["480p", "720p", "1080p"];

      for (const duration of durations) {
        for (const resolution of resolutions) {
          const { status, data } = await postJson("/api/video/generated", {
            prompt: `Wan 3.0 ${duration}s ${resolution}`,
            model: "wan_3_0",
            project_id: "proj-A",
            parameters: {
              duration,
              resolution,
              aspect_ratio: "16:9",
              generate_audio: true,
              enable_prompt_expansion: true,
              seed: 12345,
            },
          });
          assert.equal(status, 200, JSON.stringify(data));
          const params = enqueueCalls.at(-1).input.parameters;
          assert.equal(params.duration, duration);
          assert.equal(params.resolution, resolution);
          assert.equal(params.generate_audio, true);
          assert.equal(params.enable_prompt_expansion, true);
          assert.equal(params.seed, 12345);
        }
      }

      for (const aspect_ratio of aspectRatios) {
        const { status, data } = await postJson("/api/video/generated", {
          prompt: `Wan I2V + last_frame ${aspect_ratio}`,
          model: "wan_3_0",
          project_id: "proj-A",
          parameters: {
            aspect_ratio,
            input_image: "wf-img-1",
            last_frame: "wf-last-frame",
            generate_audio: false,
          },
        });
        assert.equal(status, 200, JSON.stringify(data));
        const params = enqueueCalls.at(-1).input.parameters;
        assert.equal(params.aspect_ratio, aspect_ratio);
        assert.equal(params.input_image, "wf-img-1");
        assert.equal(params.last_frame, "wf-last-frame");
        assert.equal(params.generate_audio, false);
      }
    });

    it("seedance_2_5: accepts all valid parameters (duration 5/10, 6 aspect ratios, 480p-4k, generate_audio, input_image, last_frame)", async () => {
      const durations = [5, 10];
      const aspectRatios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
      const resolutions = ["480p", "720p", "1080p", "4k"];

      for (const duration of durations) {
        for (const resolution of resolutions) {
          const { status, data } = await postJson("/api/video/generated", {
            prompt: `Seedance 2.5 ${duration}s ${resolution}`,
            model: "seedance_2_5",
            project_id: "proj-A",
            parameters: {
              duration,
              resolution,
              generate_audio: false,
            },
          });
          assert.equal(status, 200, JSON.stringify(data));
          const params = enqueueCalls.at(-1).input.parameters;
          assert.equal(params.duration, duration);
          assert.equal(params.resolution, resolution);
          assert.equal(params.generate_audio, false);
        }
      }

      for (const aspect_ratio of aspectRatios) {
        const { status, data } = await postJson("/api/video/generated", {
          prompt: `Seedance 2.5 keyframe ${aspect_ratio}`,
          model: "seedance-2-5",
          project_id: "proj-A",
          parameters: {
            aspect_ratio,
            input_image: "media-img-1",
            last_frame: "media-last-frame",
          },
        });
        assert.equal(status, 200, JSON.stringify(data));
        const params = enqueueCalls.at(-1).input.parameters;
        assert.equal(params.aspect_ratio, aspect_ratio);
        assert.equal(params.input_image, "media-img-1");
        assert.equal(params.last_frame, "media-last-frame");
      }
    });

    it("seedance_2_5_extend: accepts input_video, prompt, duration (5/10), resolution (480p/720p/1080p/4k), and generate_audio", async () => {
      for (const duration of [5, 10]) {
        for (const resolution of ["480p", "720p", "1080p", "4k"]) {
          const { status, data } = await postJson("/api/video/generated", {
            prompt: `Extend clip ${duration}s ${resolution}`,
            model: "seedance_2_5_extend",
            project_id: "proj-A",
            parameters: {
              input_video: "wf-vid-1",
              duration,
              resolution,
              generate_audio: true,
            },
          });
          assert.equal(status, 200, `Failed for seedance_2_5_extend ${duration}/${resolution}: ${JSON.stringify(data)}`);
          const params = enqueueCalls.at(-1).input.parameters;
          assert.equal(params.input_video, "wf-vid-1");
          assert.equal(params.duration, duration);
          assert.equal(params.resolution, resolution);
          assert.equal(params.generate_audio, true);
          assert.equal(params.aspect_ratio, undefined, "seedance_2_5_extend schema does not have aspect_ratio");
        }
      }
    });

    it("ltx_2_3_fast & ltx_2_5_fast: accept all durations (6..20), resolutions (720p..4k), fps (24/25/48/50), camera_motion (all 8), input_image, last_frame", async () => {
      const durations = [6, 8, 10, 12, 14, 16, 18, 20];
      const resolutions = ["720p", "1080p", "1440p", "4k"];
      const fpsValues = [24, 25, 48, 50];
      const cameraMotions = [
        "dolly_in", "dolly_out", "dolly_left", "dolly_right",
        "jib_up", "jib_down", "static", "focus_shift",
      ];

      for (const model of ["ltx_2_3_fast", "ltx_2_5_fast"]) {
        for (const duration of durations) {
          const { status, data } = await postJson("/api/video/generated", {
            prompt: `${model} duration ${duration}`,
            model,
            project_id: "proj-A",
            parameters: {
              duration,
              aspect_ratio: "9:16",
              resolution: "1080p",
              fps: 24,
              generate_audio: true,
            },
          });
          assert.equal(status, 200, JSON.stringify(data));
          assert.equal(enqueueCalls.at(-1).input.parameters.duration, duration);
        }

        for (const resolution of resolutions) {
          for (const fps of fpsValues) {
            const { status, data } = await postJson("/api/video/generated", {
              prompt: `${model} ${resolution} ${fps}fps`,
              model,
              project_id: "proj-A",
              parameters: { resolution, fps },
            });
            assert.equal(status, 200, JSON.stringify(data));
            const params = enqueueCalls.at(-1).input.parameters;
            assert.equal(params.resolution, resolution);
            assert.equal(params.fps, fps);
          }
        }

        for (const camera_motion of cameraMotions) {
          const { status, data } = await postJson("/api/video/generated", {
            prompt: `${model} camera ${camera_motion}`,
            model,
            project_id: "proj-A",
            parameters: {
              camera_motion,
              input_image: "wf-img-1",
              last_frame: "wf-last-frame",
            },
          });
          assert.equal(status, 200, JSON.stringify(data));
          const params = enqueueCalls.at(-1).input.parameters;
          assert.equal(params.camera_motion, camera_motion);
          assert.equal(params.input_image, "wf-img-1");
          assert.equal(params.last_frame, "wf-last-frame");
        }
      }
    });

    it("ltx_2_3_pro & ltx_2_5_pro: accept durations (6/8/10), resolutions (720p..4k), fps (24/25/48/50), camera_motion, input_image, last_frame", async () => {
      for (const model of ["ltx_2_3_pro", "ltx_2_5_pro"]) {
        for (const duration of [6, 8, 10]) {
          const { status, data } = await postJson("/api/video/generated", {
            prompt: `${model} ${duration}s`,
            model,
            project_id: "proj-A",
            parameters: {
              duration,
              aspect_ratio: "16:9",
              resolution: "4k",
              fps: 50,
              generate_audio: false,
              camera_motion: "dolly_in",
              input_image: "media-img-1",
              last_frame: "media-last-frame",
            },
          });
          assert.equal(status, 200, JSON.stringify(data));
          const params = enqueueCalls.at(-1).input.parameters;
          assert.equal(params.duration, duration);
          assert.equal(params.resolution, "4k");
          assert.equal(params.fps, 50);
          assert.equal(params.generate_audio, false);
          assert.equal(params.camera_motion, "dolly_in");
        }
      }
    });

    it("ltx_extend: accepts input_video, prompt, all durations (2..20), and extend_direction (end/start)", async () => {
      const durations = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
      for (const duration of durations) {
        for (const extend_direction of ["end", "start"]) {
          const { status, data } = await postJson("/api/video/generated", {
            prompt: `LTX Extend ${duration}s ${extend_direction}`,
            model: "ltx_extend",
            project_id: "proj-A",
            parameters: {
              input_video: "wf-vid-1",
              duration,
              extend_direction,
            },
          });
          assert.equal(status, 200, `Failed for ltx_extend ${duration}/${extend_direction}: ${JSON.stringify(data)}`);
          const params = enqueueCalls.at(-1).input.parameters;
          assert.equal(params.input_video, "wf-vid-1");
          assert.equal(params.duration, duration);
          assert.equal(params.extend_direction, extend_direction);
          assert.equal(params.aspect_ratio, undefined);
        }
      }
    });

    it("ltx_retake: accepts input_video, prompt, start_time, duration (2..10), retake_mode, and resolution (1920x1080/1080x1920)", async () => {
      const durations = [2, 4, 6, 8, 10];
      const modes = ["replace_audio_and_video", "replace_video", "replace_audio"];
      const resolutions = ["1920x1080", "1080x1920"];

      for (const duration of durations) {
        for (const retake_mode of modes) {
          for (const resolution of resolutions) {
            const { status, data } = await postJson("/api/video/generated", {
              prompt: `LTX Retake ${duration}s ${retake_mode}`,
              model: "ltx_retake",
              project_id: "proj-A",
              parameters: {
                input_video: "media-vid-1",
                start_time: 1.5,
                duration,
                retake_mode,
                resolution,
              },
            });
            assert.equal(status, 200, `Failed for ltx_retake ${duration}/${retake_mode}/${resolution}: ${JSON.stringify(data)}`);
            const params = enqueueCalls.at(-1).input.parameters;
            assert.equal(params.input_video, "media-vid-1");
            assert.equal(params.start_time, 1.5);
            assert.equal(params.duration, duration);
            assert.equal(params.retake_mode, retake_mode);
            assert.equal(params.resolution, resolution);
            assert.equal(params.aspect_ratio, undefined);
          }
        }
      }
    });

    it("rejects missing required fields, invalid enums, unknown parameters, direct URLs, and cross-tenant IDs on POST /api/video/generated", async () => {
      // 1. Missing required model parameters
      const missingInputVideoExtend = await postJson("/api/video/generated", {
        prompt: "extend without video",
        model: "seedance_2_5_extend",
        project_id: "proj-A",
        parameters: { duration: 5 },
      });
      assert.equal(missingInputVideoExtend.status, 400);

      const missingInputVideoLtxExtend = await postJson("/api/video/generated", {
        prompt: "ltx extend without video",
        model: "ltx_extend",
        project_id: "proj-A",
        parameters: { duration: 4 },
      });
      assert.equal(missingInputVideoLtxExtend.status, 400);

      const missingStartTimeRetake = await postJson("/api/video/generated", {
        prompt: "ltx retake without start_time",
        model: "ltx_retake",
        project_id: "proj-A",
        parameters: { input_video: "wf-vid-1", duration: 4 },
      });
      assert.equal(missingStartTimeRetake.status, 400);

      // 2. Invalid enum values per video model
      const invalidVideoEnums = [
        { model: "wan_3_0", parameters: { duration: 15 } },
        { model: "wan_3_0", parameters: { resolution: "4k" } },
        { model: "seedance_2_5", parameters: { duration: 8 } },
        { model: "ltx_2_3_pro", parameters: { duration: 20 } },
        { model: "ltx_2_3_fast", parameters: { fps: 60 } },
        { model: "ltx_2_3_fast", parameters: { camera_motion: "barrel_roll" } },
        { model: "ltx_extend", parameters: { input_video: "wf-vid-1", extend_direction: "middle" } },
        { model: "ltx_retake", parameters: { input_video: "wf-vid-1", start_time: 1, retake_mode: "audio_only" } },
        { model: "ltx_retake", parameters: { input_video: "wf-vid-1", start_time: 1, resolution: "4k" } },
      ];
      for (const tc of invalidVideoEnums) {
        const res = await postJson("/api/video/generated", {
          prompt: "invalid video enum",
          model: tc.model,
          project_id: "proj-A",
          parameters: tc.parameters,
        });
        assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(tc)}, got ${res.status}`);
      }

      // 3. Explicit unknown parameters rejected with 400
      const unknownVideoParams = [
        { model: "seedance_2_5_extend", parameters: { input_video: "wf-vid-1", aspect_ratio: "16:9" } },
        { model: "ltx_extend", parameters: { input_video: "wf-vid-1", aspect_ratio: "16:9" } },
        { model: "ltx_retake", parameters: { input_video: "wf-vid-1", start_time: 0, aspect_ratio: "16:9" } },
        { model: "seedance_2_5", parameters: { camera_motion: "dolly_in" } },
      ];
      for (const tc of unknownVideoParams) {
        const res = await postJson("/api/video/generated", {
          prompt: "unknown video param",
          model: tc.model,
          project_id: "proj-A",
          parameters: tc.parameters,
        });
        assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(tc)}, got ${res.status}`);
      }

      // 4. Direct URLs rejected with 400
      const directVideoUrls = [
        { input_video: "wf-vid-1" },
        { video_url: "https://evil.example.com/v.mp4" },
        { parameters: { input_video: "https://evil.example.com/v.mp4" } },
        { parameters: { last_frame: "https://evil.example.com/f.png" } },
      ];
      for (const extra of directVideoUrls) {
        const res = await postJson("/api/video/generated", {
          prompt: "direct video url",
          model: "wan_3_0",
          project_id: "proj-A",
          ...extra,
        });
        assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(extra)}, got ${res.status}`);
      }

      // 5. Cross-tenant input_video / last_frame returns 404
      const crossVideo = await postJson("/api/video/generated", {
        prompt: "cross tenant video extend",
        model: "ltx_extend",
        project_id: "proj-A",
        parameters: { input_video: "wf-foreign-B", duration: 4 },
      });
      assert.equal(crossVideo.status, 404);
    });
  });
});
