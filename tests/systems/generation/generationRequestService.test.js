import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GenerationRequestService } from "#generation/tools";
import { AppError, redisConnection, workerRedisConnection, rateLimitRedisConnection } from "#shared";
import express from "express";
import http from "node:http";
import apiRouter from "../../../src/api/routes.js";
import { db, walletService, executionEngine, folderService, workflowService } from "../../../src/container.js";
import { supabase } from "#shared/db/supabase.js";
import { CharacterGenerationService } from "#characters/tools";
import { generateImage, generateVideo } from "#generation/api";

// ─── Source: generationRequestService.test.js ───
{
describe("GenerationRequestService unit tests", () => {
    it("successfully creates workflow, single media placeholder, and dispatches to executionEngine", async () => {
        const createdWorkflows = [];
        const createdMedia = [];
        const linkedWorkflows = [];
        let enqueuedPayload = null;

        const mockDb = {
            workflows: {
                createWorkflow: async (wf) => {
                    createdWorkflows.push(wf);
                    return wf;
                },
            },
            media: {
                createMedia: async (m) => {
                    createdMedia.push(m);
                    return m;
                },
                updateMedia: async () => {},
            },
            workflowMedia: {
                linkMedia: async (link) => {
                    linkedWorkflows.push(link);
                },
            },
        };

        const mockExecutionEngine = {
            launch: async (args) => {
                enqueuedPayload = args;
                return {
                    jobId: "job-img-999",
                    executionId: args.executionId,
                    cost: { totalCredits: 5 },
                };
            },
        };

        const mockFolderService = {
            validateAndAssertUsable: async (folderId) => folderId,
        };

        const service = new GenerationRequestService({
            db: mockDb,
            executionEngine: mockExecutionEngine,
            folderService: mockFolderService,
            assertOwns: async () => true,
            assertOwnsAny: async () => true,
        });

        const result = await service.requestGeneration({
            userId: "user-1",
            mediaType: "image",
            stepId: "image_generation",
            useCaseId: "image-generation-v3",
            prompt: "A beautiful cinematic landscape",
            model: "nanobana_pro",
            projectId: "proj-123",
            folderId: "folder-abc",
            references: ["wf-ref-1"],
            parameters: { aspect_ratio: "16:9" },
            mediaMeta: { width: 1920, height: 1080, aspect_ratio: "16:9" },
            defaultMessages: {
                started: "Image generation started.",
                addCredits: "Add credits to generate your image.",
            },
        });

        assert.equal(result.ok, true);
        assert.equal(result.status, "processing");
        assert.equal(result.needsCredits, false);
        assert.equal(result.cost, 5);
        assert.equal(result.taskId, "job-img-999");
        assert.equal(createdWorkflows.length, 1);
        assert.equal(createdWorkflows[0].display_name, "A beautiful cinematic landscape");
        assert.equal(createdWorkflows[0].folder_id, "folder-abc");
        assert.equal(createdMedia.length, 1);
        assert.equal(createdMedia[0].step_id, "image_generation");
        assert.equal(enqueuedPayload.useCaseId, "image-generation-v3");
        assert.equal(enqueuedPayload.userId, "user-1");
    });

    it("handles INSUFFICIENT_CREDITS and INSUFFICIENT_FUNDS (H10) gracefully without throwing, marking media as saved", async () => {
        for (const errCode of ["INSUFFICIENT_CREDITS", "INSUFFICIENT_FUNDS"]) {
            const updatedMedia = [];
            const mockDb = {
                workflows: {
                    createWorkflow: async (wf) => wf,
                },
                media: {
                    createMedia: async (m) => m,
                    updateMedia: async (id, patch) => {
                        updatedMedia.push({ id, ...patch });
                    },
                },
                workflowMedia: {
                    linkMedia: async () => {},
                },
            };

            const mockExecutionEngine = {
                launch: async () => {
                    const err = new Error("User does not have enough credits");
                    err.code = errCode;
                    throw err;
                },
            };

            const mockFolderService = {
                validateAndAssertUsable: async () => null,
            };

            const service = new GenerationRequestService({
                db: mockDb,
                executionEngine: mockExecutionEngine,
                folderService: mockFolderService,
                assertOwns: async () => true,
                assertOwnsAny: async () => true,
            });

            const result = await service.requestGeneration({
                userId: "user-1",
                mediaType: "video",
                stepId: "video_generation",
                useCaseId: "video-generation-v3",
                prompt: "A cinematic slow motion scene",
                model: "seedance_2_5",
                projectId: "proj-123",
                folderId: null,
                references: [],
                parameters: {},
                mediaMeta: { width: 1920, height: 1080, aspect_ratio: "16:9" },
                defaultMessages: {
                    started: "Video generation started.",
                    addCredits: "Add credits to generate your video.",
                },
            });

            assert.equal(result.ok, true, `${errCode} must return ok: true`);
            assert.equal(result.status, "saved", `${errCode} must return status: 'saved'`);
            assert.equal(result.needsCredits, true, `${errCode} must return needsCredits: true`);
            assert.equal(result.message, "User does not have enough credits");
            assert.equal(updatedMedia.length, 1);
            assert.equal(updatedMedia[0].status, "saved");
        }
    });

    it("handles QUEUE_DISPATCH_FAILED by marking media as failed and throwing 503 error", async () => {
        const updatedMedia = [];
        const mockDb = {
            workflows: {
                createWorkflow: async (wf) => wf,
            },
            media: {
                createMedia: async (m) => m,
                updateMedia: async (id, patch) => {
                    updatedMedia.push({ id, ...patch });
                },
            },
            workflowMedia: {
                linkMedia: async () => {},
            },
        };

        const mockExecutionEngine = {
            launch: async () => {
                const err = new Error("Redis cluster unreachable");
                err.code = "QUEUE_DISPATCH_FAILED";
                throw err;
            },
        };

        const mockFolderService = {
            validateAndAssertUsable: async () => null,
        };

        const service = new GenerationRequestService({
            db: mockDb,
            executionEngine: mockExecutionEngine,
            folderService: mockFolderService,
            assertOwns: async () => true,
            assertOwnsAny: async () => true,
        });

        await assert.rejects(
            async () => {
                await service.requestGeneration({
                    userId: "user-1",
                    mediaType: "image",
                    stepId: "image_generation",
                    useCaseId: "image-generation-v3",
                    prompt: "A neon cityscape",
                    model: "nanobana_pro",
                    projectId: "proj-123",
                    folderId: null,
                    references: [],
                    parameters: {},
                    mediaMeta: { width: 1024, height: 1024, aspect_ratio: "1:1" },
                });
            },
            (err) => {
                assert.equal(err.statusCode, 503);
                assert.equal(err.code, "QUEUE_DISPATCH_FAILED");
                assert.equal(updatedMedia.length, 1);
                assert.equal(updatedMedia[0].status, "failed");
                return true;
            }
        );
    });

    it("P1-1: collapses workflow + media placeholder + workflow_media link into a single create_generation_placeholder_atomic RPC hop", async () => {
        const rpcCalls = [];
        let fallbackWorkflowCalled = false;
        let fallbackMediaCalled = false;
        let fallbackLinkCalled = false;
        let launchedArgs = null;

        const mockDb = {
            rpc: async (fnName, params) => {
                rpcCalls.push({ fnName, params });
                assert.equal(fnName, "create_generation_placeholder_atomic");
                return {
                    data: {
                        workflow_id: params.p_workflow_id,
                        media_id: params.p_media_id,
                        role: params.p_role,
                    },
                    error: null,
                };
            },
            workflows: {
                createWorkflow: async () => {
                    fallbackWorkflowCalled = true;
                    throw new Error("Should not call multi-step createWorkflow when atomic RPC succeeds");
                },
            },
            media: {
                createMedia: async () => {
                    fallbackMediaCalled = true;
                    throw new Error("Should not call multi-step createMedia when atomic RPC succeeds");
                },
                updateMedia: async () => {},
            },
            workflowMedia: {
                linkMedia: async () => {
                    fallbackLinkCalled = true;
                    throw new Error("Should not call multi-step linkMedia when atomic RPC succeeds");
                },
            },
        };

        const mockExecutionEngine = {
            launch: async (args) => {
                launchedArgs = args;
                return { jobId: "job-vid-atomic", executionId: args.executionId, cost: { totalCredits: 10 } };
            },
        };

        const service = new GenerationRequestService({
            db: mockDb,
            executionEngine: mockExecutionEngine,
            folderService: { validateAndAssertUsable: async (fid) => fid },
            assertOwns: async () => true,
            assertOwnsAny: async () => true,
        });

        const result = await service.requestGeneration({
            userId: "user-atomic-1",
            mediaType: "video",
            stepId: "video_generation",
            useCaseId: "video-generation-v3",
            prompt: "Cinematic ocean waves at sunset",
            model: "seedance_2_5",
            projectId: "proj-atomic-1",
            folderId: "folder-atomic-1",
            references: [],
            parameters: {},
            mediaMeta: { width: 1280, height: 720, aspect_ratio: "16:9" },
        });

        assert.equal(result.ok, true);
        assert.equal(result.status, "processing");
        assert.equal(rpcCalls.length, 1);
        assert.equal(rpcCalls[0].params.p_project_id, "proj-atomic-1");
        assert.equal(rpcCalls[0].params.p_user_id, "user-atomic-1");
        assert.equal(rpcCalls[0].params.p_folder_id, "folder-atomic-1");
        assert.equal(rpcCalls[0].params.p_step_id, "video_generation");
        assert.equal(rpcCalls[0].params.p_workflow_type, "GENERATION");
        assert.equal(rpcCalls[0].params.p_role, "output");
        assert.equal(rpcCalls[0].params.p_width, 1280);
        assert.equal(rpcCalls[0].params.p_height, 720);
        assert.equal(rpcCalls[0].params.p_generation_config.model, "seedance_2_5");
        assert.equal(fallbackWorkflowCalled, false);
        assert.equal(fallbackMediaCalled, false);
        assert.equal(fallbackLinkCalled, false);
        assert.equal(launchedArgs.serverContext.workflowId, result.workflowId);
        assert.deepEqual(launchedArgs.serverContext.mediaIds, [result.mediaId]);
    });

    it("P1-1: gracefully falls back to multi-step persistence when create_generation_placeholder_atomic returns PGRST202", async () => {
        let rpcAttempts = 0;
        let createdWorkflow = null;
        let createdMedia = null;
        let linked = null;

        const mockDb = {
            rpc: async () => {
                rpcAttempts++;
                return { data: null, error: { code: "PGRST202", message: "function not found in schema cache" } };
            },
            workflows: {
                createWorkflow: async (wf) => {
                    createdWorkflow = wf;
                    return wf;
                },
            },
            media: {
                createMedia: async (m) => {
                    createdMedia = m;
                    return m;
                },
                updateMedia: async () => {},
            },
            workflowMedia: {
                linkMedia: async (link) => {
                    linked = link;
                    return link;
                },
            },
        };

        const service = new GenerationRequestService({
            db: mockDb,
            executionEngine: {
                launch: async (args) => ({ jobId: "job-fb", executionId: args.executionId, cost: { totalCredits: 5 } }),
            },
            folderService: { validateAndAssertUsable: async () => null },
            assertOwns: async () => true,
            assertOwnsAny: async () => true,
        });

        const result = await service.requestGeneration({
            userId: "user-fb-1",
            mediaType: "image",
            stepId: "image_generation",
            useCaseId: "image-generation-v3",
            prompt: "Fallback mountain",
            model: "nanobana_pro",
            projectId: "proj-fb-1",
            folderId: null,
            parameters: {},
            mediaMeta: { width: 1024, height: 1024, aspect_ratio: "1:1" },
        });

        assert.equal(result.ok, true);
        assert.equal(rpcAttempts, 1);
        assert.ok(createdWorkflow);
        assert.ok(createdMedia);
        assert.ok(linked);
    });

    it("enforces 1x fail-fast ownership gate (project, references, MEDIA_PARAM_KEYS, inline tags), resolves default video 16:9 mediaMeta, and forwards verify_ownership: false", async () => {
        const ownershipCalls = [];
        let createdCount = 0;
        let launchedArgs = null;

        const mockDb = {
            workflows: {
                createWorkflow: async (wf) => {
                    createdCount += 1;
                    return wf;
                },
            },
            media: {
                createMedia: async (m) => {
                    createdCount += 1;
                    return m;
                },
                updateMedia: async () => {},
            },
            workflowMedia: { linkMedia: async () => {} },
        };

        const service = new GenerationRequestService({
            db: mockDb,
            executionEngine: {
                launch: async (args) => {
                    launchedArgs = args;
                    return { jobId: "job-own-1", executionId: args.executionId, cost: { totalCredits: 10 } };
                },
            },
            folderService: { validateAndAssertUsable: async () => null },
            assertOwns: async (type, id, uid) => {
                ownershipCalls.push({ fn: "assertOwns", type, id, uid });
                if (id === "proj-foreign") throw new AppError("Project not found", 404);
                return { id };
            },
            assertOwnsAny: async (types, id, uid) => {
                ownershipCalls.push({ fn: "assertOwnsAny", types, id, uid });
                if (id === "char-foreign") throw new AppError("Reference not found", 404);
                return { id };
            },
        });

        // 1. Foreign inline <character:id> fails fast BEFORE placeholder creation
        await assert.rejects(
            () =>
                service.requestGeneration({
                    userId: "user-1",
                    mediaType: "image",
                    body: {
                        prompt: "Portrait of <character:char-foreign> in neon rain",
                        model: "nanobana_pro",
                        project_id: "proj-1",
                    },
                }),
            (err) => err.statusCode === 404
        );
        assert.equal(createdCount, 0, "must not create placeholders when inline entity ownership fails");
        assert.equal(launchedArgs, null, "must not launch job when inline entity ownership fails");

        // 2. Raw URL in nested parameters fails fast with 400 DIRECT_URL_NOT_ALLOWED
        await assert.rejects(
            () =>
                service.requestGeneration({
                    userId: "user-1",
                    mediaType: "image",
                    body: {
                        prompt: "A forest",
                        model: "nanobana_pro",
                        project_id: "proj-1",
                        parameters: { images: ["https://evil.example/img.png"] },
                    },
                }),
            (err) => err.statusCode === 400 && err.code === "DIRECT_URL_NOT_ALLOWED"
        );
        assert.equal(createdCount, 0);

        // 3. Valid video request resolves default 16:9 aspect ratio, verifies each ID once, and sets verify_ownership: false
        ownershipCalls.length = 0;
        const result = await service.requestGeneration({
            userId: "user-1",
            mediaType: "video",
            body: {
                prompt: "Soaring eagle with <character:char-1> and <element:elem-1>",
                model: "wan_3_0",
                project_id: "proj-1",
                references: ["wf-ref-1", "wf-ref-1"],
                parameters: { input_image: "media-in-1" },
            },
        });

        assert.equal(result.ok, true);
        assert.ok(launchedArgs);
        assert.equal(launchedArgs.input.aspect_ratio, "16:9");
        assert.equal(launchedArgs.input.verify_ownership, false);
        assert.deepEqual(
            ownershipCalls.map((c) => `${c.fn}:${c.type || c.types.join("|")}:${c.id}`),
            [
                "assertOwns:project:proj-1",
                "assertOwnsAny:workflow|character|element|media:wf-ref-1",
                "assertOwnsAny:character|workflow:char-1",
                "assertOwnsAny:element|workflow:elem-1",
                "assertOwnsAny:workflow|media:media-in-1",
            ]
        );
    });
});
}

// ─── Source: generationWithFolder.test.js ───
{
process.env.NODE_ENV = "test";

describe("Generation & Upload Endpoints with folderId & Worker Fallback (Task F-T8)", () => {
  let server;
  let baseUrl;
  let origGetUser;
  let origVerifyWorkflowOwnership;

  let projects = [];
  let folders = [];
  let workflows = [];
  let media = [];
  let creditHolds = [];
  let origLaunch;
  let origHoldCredits;
  let origDbMethods;

  before(async () => {
    origVerifyWorkflowOwnership = workflowService.authService.verifyWorkflowOwnership;
    workflowService.authService.verifyWorkflowOwnership = async (wfId, userId) => {
      const wf = workflows.find((w) => w.id === wfId);
      if (!wf) return false;
      const proj = projects.find((p) => p.id === wf.project_id);
      return Boolean(proj && proj.user_id === userId);
    };
    origLaunch = executionEngine.launch;
    origHoldCredits = walletService?.holdCredits;
    origDbMethods = {
      findByUser: db.projects.findByUser,
      findById: db.projects.findById,
      findOwnedInProject: db.folders.findOwnedInProject,
      createWorkflow: db.workflows.createWorkflow,
      getWorkflow: db.workflows.getWorkflow,
      updatePrimaryMedia: db.workflows.updatePrimaryMedia,
      createMedia: db.media.createMedia,
    };

    origGetUser = supabase.auth.getUser;
    supabase.auth.getUser = async (token) => {
      if (token === "token-user-A") {
        return { data: { user: { id: "user-A" } }, error: null };
      }
      if (token === "token-user-B") {
        return { data: { user: { id: "user-B" } }, error: null };
      }
      return { data: { user: null }, error: new Error("Invalid token") };
    };

    const app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
    app.use((err, req, res, next) => {
      res.status(err.statusCode || 500).json({
        ok: false,
        message: err.message,
        errorCode: err.errorCode || "INTERNAL_ERROR",
      });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    supabase.auth.getUser = origGetUser;
    if (origVerifyWorkflowOwnership) workflowService.authService.verifyWorkflowOwnership = origVerifyWorkflowOwnership;
    if (origLaunch) executionEngine.launch = origLaunch;
    if (walletService && origHoldCredits) walletService.holdCredits = origHoldCredits;
    if (origDbMethods) {
      db.projects.findByUser = origDbMethods.findByUser;
      db.projects.findById = origDbMethods.findById;
      db.folders.findOwnedInProject = origDbMethods.findOwnedInProject;
      db.workflows.createWorkflow = origDbMethods.createWorkflow;
      db.workflows.getWorkflow = origDbMethods.getWorkflow;
      db.workflows.updatePrimaryMedia = origDbMethods.updatePrimaryMedia;
      db.media.createMedia = origDbMethods.createMedia;
    }
    try {
      server?.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    } catch {}
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
      await rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect());
    } catch {}
  });

  beforeEach(() => {
    projects = [
      { id: "proj-A", user_id: "user-A", project_name: "Project A" },
      { id: "proj-B", user_id: "user-B", project_name: "Project B" },
    ];

    folders = [
      { id: "00000000-0000-4000-8000-000000000001", project_id: "proj-A", user_id: "user-A", name: "Valid Folder" },
      { id: "00000000-0000-4000-8000-000000000002", project_id: "proj-B", user_id: "user-B", name: "Foreign Folder" },
    ];

    workflows = [];
    media = [];
    creditHolds = [];

    // Mock db.projects
    db.projects.findByUser = async (userId, projectId) => {
      return projects.filter((p) => p.user_id === userId && (!projectId || p.id === projectId));
    };
    db.projects.findById = async (id) => {
      return projects.find((p) => p.id === id) || null;
    };

    // Mock db.folders
    db.folders.findOwnedInProject = async (folderId, projectId, userId) => {
      return folders.find((f) => f.id === folderId && f.project_id === projectId && f.user_id === userId) || null;
    };

    // Mock db.workflows
    db.workflows.createWorkflow = async (data) => {
      const record = { id: data.id || `wf-${Date.now()}`, ...data };
      workflows.push(record);
      return record;
    };
    db.workflows.getWorkflow = async (id) => workflows.find((w) => w.id === id) || null;
    db.workflows.updatePrimaryMedia = async (wfId, mediaId) => {
      const wf = workflows.find((w) => w.id === wfId);
      if (wf) wf.primary_media_id = mediaId;
      return wf;
    };

    // Mock db.media
    db.media.createMedia = async (data) => {
      const record = { id: data.id || `m-${Date.now()}`, ...data };
      media.push(record);
      return record;
    };

    // Mock executionEngine / wallet
    executionEngine.launch = async (opts) => {
      return { jobId: "job-1", executionId: opts.executionId, cost: { totalCredits: 1 } };
    };

    if (walletService) {
      walletService.holdCredits = async (userId, amount) => {
        creditHolds.push({ userId, amount });
        return { reservationId: "res-1" };
      };
    }
  });

  describe("POST /api/images/generated with folderId", () => {
    it("rejects foreign folderId with 404 and invokes 0 credit holds", async () => {
      const res = await fetch(`${baseUrl}/api/images/generated`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: "A beautiful mountain",
          model: "seedream_v5",
          project_id: "proj-A",
          folder_id: "00000000-0000-4000-8000-000000000002",
        }),
      });

      assert.equal(res.status, 404);
      assert.equal(creditHolds.length, 0, "Credit holds must be 0 on foreign folderId");
      assert.equal(workflows.length, 0, "No workflow should be created");
    });

    it("accepts valid folderId and persists it on created workflow", async () => {
      const res = await fetch(`${baseUrl}/api/images/generated`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: "A beautiful forest",
          model: "seedream_v5",
          project_id: "proj-A",
          folder_id: "00000000-0000-4000-8000-000000000001",
        }),
      });

      const data = await res.json();
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(data)}`);
      assert.equal(workflows.length, 1);
      assert.equal(workflows[0].folder_id, "00000000-0000-4000-8000-000000000001");
    });
  });

  describe("POST /api/video/generated with folderId", () => {
    it("rejects foreign folderId with 404 and invokes 0 credit holds", async () => {
      const res = await fetch(`${baseUrl}/api/video/generated`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: "A river flowing",
          model: "seedance_2_5",
          project_id: "proj-A",
          folder_id: "00000000-0000-4000-8000-000000000002",
        }),
      });

      assert.equal(res.status, 404);
      assert.equal(creditHolds.length, 0, "Credit holds must be 0 on foreign folderId");
    });
  });

  describe("POST /api/assets/upload with folderId", () => {
    it("rejects foreign folderId with 404 and creates 0 workflows", async () => {
      const res = await fetch(`${baseUrl}/api/assets/upload`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          base64: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          project_id: "proj-A",
          folder_id: "00000000-0000-4000-8000-000000000002",
        }),
      });

      assert.equal(res.status, 404);
      assert.equal(workflows.length, 0);
    });

    it("accepts valid folderId on upload and associates workflow to folder", async () => {
      const res = await fetch(`${baseUrl}/api/assets/upload`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          base64: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          project_id: "proj-A",
          folder_id: "00000000-0000-4000-8000-000000000001",
        }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.folder_id, "00000000-0000-4000-8000-000000000001");
      assert.equal(body.folderId, "00000000-0000-4000-8000-000000000001");
      assert.equal(workflows.length, 1);
      assert.equal(workflows[0].folder_id, "00000000-0000-4000-8000-000000000001");
    });

    it("accepts valid collection_id and source on upload as alias for folder_id", async () => {
      const res = await fetch(`${baseUrl}/api/assets/upload`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          project_id: "proj-A",
          collection_id: "00000000-0000-4000-8000-000000000001",
        }),
      });

      assert.equal(res.status, 200);
      assert.equal(workflows.length, 1);
      assert.equal(workflows[0].folder_id, "00000000-0000-4000-8000-000000000001");
    });
  });
});
}

// ─── Source: targetColumnsAndEntryPointWiringBoundary.test.js ───
{
/**
 * Boundary Tests: F2.2 — RunRepository Target Columns & Entry Point Wiring Invariants
 *
 * Verifies:
 * 1. F2.2-a: RunRepository writes and reads `v1_workflow_id`, `target_media_ids`, and `metadata`
 *    as first-class database columns in Supabase.
 * 2. F2.2-a: Backward compatibility for pre-migration rows: falls back to execution_plan
 *    targetWorkflowId / targetMediaIds if present.
 * 3. F2.2-a: Fail-closed invariant: runs without targets have null/empty targets and fail closed
 *    with normalized errors upon node persistence (never falling back to user input).
 * 4. F2.2-b: CharacterGenerationService.enqueueSheetGeneration creates placeholder media and
 *    propagates its mediaId and server-verified targets into runtime input and serverContext.
 * 5. F2.2-b: imageController.generateImage and videoController.generateVideo pass explicit
 *    server-verified targets (serverWorkflowId, serverMediaIds, serverProjectId).
 * 6. F2.2-b: End-to-end integration: execution of queued character sheet job completes the placeholder.
 */


after(async () => {
  try {
    await redisConnection.quit().catch(() => redisConnection.disconnect());
    await workerRedisConnection.quit().catch(() => workerRedisConnection.disconnect());
  } catch {}
});

describe("F2.2-b — Entry Point Wiring & Target Media Propagation Tests", () => {
  let origLaunch;
  let origJobQueueService;
  let origCreateWorkflow;
  let origCreateMedia;
  let origUpdateMedia;
  let origUpdateFields;
  let origFindWorkflow;
  let origProjectsFindById;
  let origWalletService;

  beforeEach(() => {
    origLaunch = executionEngine.launch;
    origJobQueueService = executionEngine.jobQueueService;
    origCreateWorkflow = db.workflows?.createWorkflow;
    origCreateMedia = db.media?.createMedia;
    origUpdateMedia = db.media?.updateMedia;
    origUpdateFields = db.media?.updateFields;
    origFindWorkflow = db.workflows?.findById;
    origProjectsFindById = db.projects?.findById;
    origWalletService = executionEngine.walletService;
  });

  afterEach(() => {
    executionEngine.launch = origLaunch;
    executionEngine.jobQueueService = origJobQueueService;
    executionEngine.walletService = origWalletService;

    if (db.workflows) {
      db.workflows.createWorkflow = origCreateWorkflow;
      db.workflows.findById = origFindWorkflow;
    }
    if (db.media) {
      db.media.createMedia = origCreateMedia;
      db.media.updateMedia = origUpdateMedia;
      db.media.updateFields = origUpdateFields;
    }
    if (db.projects) {
      db.projects.findById = origProjectsFindById;
    }
  });

  it("TEST 5: CharacterGenerationService.enqueueSheetGeneration creates placeholder and propagates its mediaId", async () => {
    let capturedMediaCreate = null;
    let capturedWorkflowMediaLink = null;
    let capturedPrepare = null;

    const fakeMedia = {
      id: "media-char-placeholder-777",
      project_id: "proj-111",
      step_id: "character_sheet",
      status: "processing",
    };

    const mockDb = {
      media: {
        createMedia: async (payload) => {
          capturedMediaCreate = payload;
          return fakeMedia;
        },
      },
      workflowMedia: {
        linkMedia: async (payload) => {
          capturedWorkflowMediaLink = payload;
          return payload;
        },
      },
    };

    const mockExecutionEngine = {
      launch: async (params) => {
        capturedPrepare = params;
        return {
          executionId: params.executionId,
          workflowRunId: params.executionId,
        };
      },
    };

    const service = new CharacterGenerationService({
      db: mockDb,
      executionEngine: mockExecutionEngine,
    });

    const res = await service.enqueueSheetGeneration({
      characterId: "char-wf-888",
      prompt: "cyberpunk warrior",
      references: [],
      projectId: "proj-111",
      userId: "user-123",
      name: "Cyber Warrior",
    });

    assert.ok(res);
    assert.ok(capturedMediaCreate, "Placeholder media must be created in DB");
    assert.strictEqual(capturedMediaCreate.workflow_id, undefined, "workflow_id must NOT be written to media");
    assert.strictEqual(capturedWorkflowMediaLink?.workflowId, "char-wf-888", "workflow_media relation must be created");

    assert.ok(capturedPrepare, "executionEngine.launch must be called");
    assert.notStrictEqual(capturedPrepare.executionId, "char-wf-888", "H9: executionId must be a fresh UUID, never characterId");
    assert.strictEqual(capturedPrepare.input.media_id, "media-char-placeholder-777", "media_id must match placeholder media ID");
    assert.deepStrictEqual(capturedPrepare.input.serverMediaIds, ["media-char-placeholder-777"], "serverMediaIds must include placeholder media ID");
    assert.strictEqual(capturedPrepare.input.serverWorkflowId, "char-wf-888", "serverWorkflowId must be set");
    assert.strictEqual(capturedPrepare.input.serverProjectId, "proj-111", "serverProjectId must be set");
    assert.strictEqual(capturedPrepare.input.verify_ownership, false, "verified character sheet dispatch must set verify_ownership: false");
    assert.strictEqual(capturedPrepare.serverContext?.workflowId, "char-wf-888", "serverContext.workflowId must be set");
    assert.deepStrictEqual(capturedPrepare.serverContext?.mediaIds, ["media-char-placeholder-777"], "serverContext.mediaIds must include placeholder media");
  });

  it("TEST 6: imageController.generateImage creates workflow and placeholder and propagates server targets", async () => {
    let capturedPrepare = null;

    executionEngine.launch = async (params) => {
      capturedPrepare = params;
      return {
        jobId: "job-img-123",
        executionId: params.executionId,
        cost: { totalCredits: 2 },
      };
    };

    db.projects = {
      findById: async () => ({ id: "proj-123", user_id: "user-test" }),
    };

    const fakeWorkflow = { id: "wf-img-456", project_id: "proj-123" };
    db.workflows = {
      createWorkflow: async () => fakeWorkflow,
      updateFields: async () => {},
    };

    const fakeMedia = { id: "media-img-789", workflow_id: "wf-img-456" };
    db.media = {
      createMedia: async () => fakeMedia,
      updateMedia: async () => fakeMedia,
    };

    const req = {
      user: { id: "user-test" },
      body: {
        prompt: "A beautiful mountain landscape",
        projectId: "proj-123",
        model: "nanobana_2",
      },
    };

    let statusCode = null;
    let jsonResponse = null;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };

    await generateImage(req, res);

    assert.ok(jsonResponse);
    assert.strictEqual(jsonResponse.ok, true);
    assert.ok(jsonResponse.workflowId);
    assert.ok(jsonResponse.mediaId);

    assert.ok(capturedPrepare, "executionEngine.launch must be called");
    assert.strictEqual(capturedPrepare.input.workflow_id, jsonResponse.workflowId);
    assert.strictEqual(capturedPrepare.input.media_id, jsonResponse.mediaId);
    assert.strictEqual(capturedPrepare.input.serverWorkflowId, jsonResponse.workflowId, "serverWorkflowId must be set");
    assert.deepStrictEqual(capturedPrepare.input.serverMediaIds, [jsonResponse.mediaId], "serverMediaIds must contain mediaId");
    assert.strictEqual(capturedPrepare.input.serverProjectId, "proj-123", "serverProjectId must be set");
  });

  it("TEST 7: videoController.generateVideo creates workflow and placeholder and propagates server targets", async () => {
    let capturedPrepare = null;

    executionEngine.launch = async (params) => {
      capturedPrepare = params;
      return {
        jobId: "job-vid-123",
        executionId: params.executionId,
        cost: { totalCredits: 10 },
      };
    };

    db.projects = {
      findById: async () => ({ id: "proj-vid-1", user_id: "user-vid-test" }),
    };

    const fakeWorkflow = { id: "wf-vid-555", project_id: "proj-vid-1" };
    db.workflows = {
      createWorkflow: async () => fakeWorkflow,
      updateFields: async () => {},
    };

    const fakeMedia = { id: "media-vid-666", workflow_id: "wf-vid-555" };
    db.media = {
      createMedia: async () => fakeMedia,
      updateMedia: async () => fakeMedia,
    };

    const req = {
      user: { id: "user-vid-test" },
      body: {
        prompt: "A drone flying over the ocean at sunset",
        projectId: "proj-vid-1",
        model: "wan_3_0",
      },
    };

    let statusCode = null;
    let jsonResponse = null;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };

    await generateVideo(req, res);

    assert.ok(jsonResponse);
    assert.strictEqual(jsonResponse.ok, true);
    assert.ok(jsonResponse.workflowId);
    assert.ok(jsonResponse.mediaId);

    assert.ok(capturedPrepare, "executionEngine.launch must be called");
    assert.strictEqual(capturedPrepare.input.workflow_id, jsonResponse.workflowId);
    assert.strictEqual(capturedPrepare.input.media_id, jsonResponse.mediaId);
    assert.strictEqual(capturedPrepare.input.serverWorkflowId, jsonResponse.workflowId, "serverWorkflowId must be set");
    assert.deepStrictEqual(capturedPrepare.input.serverMediaIds, [jsonResponse.mediaId], "serverMediaIds must contain mediaId");
    assert.strictEqual(capturedPrepare.input.serverProjectId, "proj-vid-1", "serverProjectId must be set");
  });

  it("TEST 8: End-to-end integration: Character generation sheet completes target placeholder media via ExecutionEngine", async () => {
    let mediaRecord = {
      id: "media-e2e-char-1",
      workflow_id: "char-wf-e2e-999",
      project_id: "proj-e2e",
      step_id: "character_sheet",
      status: "processing",
      url: null,
    };

    db.media = {
      createMedia: async (payload) => {
        mediaRecord = { ...mediaRecord, ...payload, id: "media-e2e-char-1" };
        return mediaRecord;
      },
      findByWorkflow: async (wfId) => {
        return wfId === "char-wf-e2e-999" ? [mediaRecord] : [];
      },
      updateMedia: async (mediaId, patch) => {
        if (mediaId === "media-e2e-char-1") {
          mediaRecord = { ...mediaRecord, ...patch };
        }
        return mediaRecord;
      },
      updateFields: async (mediaId, patch) => {
        if (mediaId === "media-e2e-char-1") {
          mediaRecord = { ...mediaRecord, ...patch };
        }
        return mediaRecord;
      },
    };

    let prelinkedCharacterMediaId = null;
    db.characters = {
      upsert: async () => ({ id: "char-wf-e2e-999" }),
      updateCharacter: async (_id, patch) => {
        if (patch?.primary_media_id) {
          prelinkedCharacterMediaId = patch.primary_media_id;
        }
      },
      findByCharacterId: async (id) => ({ id, user_id: "11111111-1111-4111-8111-111111111111" }),
    };

    let enqueuedJobData = null;
    const mockQueue = {
      addUseCaseJob: async (jobData) => {
        enqueuedJobData = jobData;
        return { id: "job-char-e2e" };
      },
    };

    const mockWallet = {
      reserve: async ({ referenceId }) => ({
        reservationId: referenceId || "hold-test-e2e",
        referenceId: referenceId || "hold-test-e2e",
        status: "held",
      }),
      commitHoldIdempotent: async () => ({ status: "COMPLETED" }),
      rollback: async () => ({ status: "FAILED" }),
      extendHold: async () => ({ status: "extended" }),
    };

    executionEngine.jobQueueService = mockQueue;
    executionEngine.walletService = mockWallet;

    // 1. CharacterGenerationService creates placeholder, links it to character upfront, & enqueues
    const charGenService = new CharacterGenerationService({
      db,
      executionEngine,
    });

    await charGenService.enqueueSheetGeneration({
      characterId: "char-wf-e2e-999",
      prompt: "A cybernetic samurai warrior",
      references: [],
      projectId: "proj-e2e",
      userId: "11111111-1111-4111-8111-111111111111",
      name: "Cyber Samurai",
    });

    assert.strictEqual(
      prelinkedCharacterMediaId,
      "media-e2e-char-1",
      "CharacterGenerationService must link placeholder media_id to character upfront"
    );
    assert.ok(enqueuedJobData, "Job must have been enqueued");
    assert.strictEqual(enqueuedJobData.input.media_id, "media-e2e-char-1");
    assert.deepStrictEqual(enqueuedJobData.input.serverMediaIds, ["media-e2e-char-1"]);

    // 2. Worker executes queued job end-to-end with mocked V3 node context (purely media-centric save_media)
    const result = await executionEngine.execute({
      useCaseId: enqueuedJobData.useCaseId,
      input: enqueuedJobData.input,
      userId: enqueuedJobData.userId,
      billingHoldId: enqueuedJobData.billingHoldId,
      executionId: enqueuedJobData.executionId,
      runId: enqueuedJobData.workflowRunId,
      nodeContext: {
        db,
        executeLLM: async ({ prompt }) => ({
          content: prompt,
          json: {
            is_safe: true,
            sanitized_prompt: prompt,
            prompt,
            description: prompt,
            character_description: prompt,
          },
        }),
        executeGeneration: async () => ({
          assets: [{ url: "https://storage.openart.ai/character-sheets/turnaround-char-999.png", width: 1344, height: 768 }],
        }),
      },
    });

    assert.strictEqual(result.status, "completed");
    // Assert target placeholder media is now completed with the generated URL!
    assert.strictEqual(mediaRecord.status, "success");
    assert.strictEqual(mediaRecord.url, "https://storage.openart.ai/character-sheets/turnaround-char-999.png");
  });
});
}
