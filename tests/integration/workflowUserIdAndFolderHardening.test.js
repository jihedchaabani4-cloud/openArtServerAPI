import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import apiRouter from "../../src/api/routes.js";
import imagesRouter from "../../routes/images.js";
import videoRouter from "../../routes/video.js";
import { db, elementService, workflowMediaService } from "../../src/container.js";
import { supabase } from "../../lib/supabase.js";
import { redisConnection, workerRedisConnection, rateLimitRedisConnection } from "../../src/queue/redis.js";
import { WorkflowRepository } from "../../src/db/WorkflowRepository.js";

process.env.NODE_ENV = "test";

describe("Workflow user_id Persistence, updateFolderId Hardening, and UUID Validation (P3 Fix)", () => {
  let server;
  let baseUrl;
  let origGetUser;

  let projects = [];
  let folders = [];
  let workflows = [];

  before(async () => {
    origGetUser = supabase.auth.getUser;
    supabase.auth.getUser = async (token) => {
      if (token === "token-user-A") return { data: { user: { id: "00000000-0000-0000-0000-000000000001" } }, error: null };
      if (token === "token-user-B") return { data: { user: { id: "00000000-0000-0000-0000-000000000002" } }, error: null };
      return { data: { user: null }, error: new Error("Invalid token") };
    };

    const app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
    app.use("/api/images", imagesRouter);
    app.use("/api/video", videoRouter);
    app.use((err, req, res, next) => {
      res.status(err.statusCode || 500).json({
        ok: false,
        message: err.message,
        code: err.errorCode || err.code || "INTERNAL_ERROR",
      });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    supabase.auth.getUser = origGetUser;
    await Promise.allSettled([
      rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect()),
      redisConnection?.quit().catch(() => redisConnection?.disconnect()),
      workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect()),
    ]);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    const userA = "00000000-0000-0000-0000-000000000001";
    const userB = "00000000-0000-0000-0000-000000000002";
    const projA = "11111111-1111-1111-1111-111111111111";
    const projB = "22222222-2222-2222-2222-222222222222";
    const folderA = "33333333-3333-3333-3333-333333333333";

    projects = [
      { id: projA, user_id: userA, name: "Project A" },
      { id: projB, user_id: userB, name: "Project B" },
    ];

    folders = [
      {
        id: folderA,
        project_id: projA,
        user_id: userA,
        parent_id: null,
        name: "Folder A",
        position: 0,
      },
    ];

    workflows = [
      {
        id: "44444444-4444-4444-4444-444444444444",
        project_id: projA,
        user_id: null, // Legacy / unpopulated user_id
        folder_id: null,
        display_name: "Legacy Workflow",
        create_time: new Date().toISOString(),
      },
    ];

    db.projects.findByUser = async (userId, projectId) => {
      const p = projects.find((proj) => proj.id === projectId && proj.user_id === userId);
      return p ? [p] : [];
    };
    db.projects.findById = async (projectId) => {
      return projects.find((proj) => proj.id === projectId) || null;
    };

    db.folders.findOwned = async (folderId, userId) => {
      return folders.find((f) => f.id === folderId && f.user_id === userId) || null;
    };
    db.folders.findOwnedInProject = async (folderId, projectId, userId) => {
      return (
        folders.find(
          (f) => f.id === folderId && f.project_id === projectId && f.user_id === userId
        ) || null
      );
    };

    db.workflows.findById = async (id) => {
      return workflows.find((w) => w.id === id) || null;
    };
    db.workflows.getWorkflow = async (id) => {
      return workflows.find((w) => w.id === id) || null;
    };
    db.workflows.updateFolderId = async (workflowId, folderId, userId, projectId) => {
      if (!workflowId || !userId || !projectId) {
        throw new Error("workflowId, userId, and projectId are required");
      }
      const wf = workflows.find((w) => w.id === workflowId && w.project_id === projectId);
      if (!wf) {
        const err = new Error("Not found");
        err.code = "PGRST116";
        err.statusCode = 404;
        throw err;
      }
      wf.folder_id = folderId;
      wf.user_id = userId;
      return wf;
    };
  });

  describe("1. Workflow user_id population on creation", () => {
    it("ElementService.createElement sets user_id on created workflow row", async () => {
      let createdWf = null;
      const origCreate = db.workflows.createWorkflow;
      db.workflows.createWorkflow = async (data) => {
        createdWf = data;
        return { id: "elem-wf-1", ...data };
      };

      const origIngest = elementService.mediaService.ingestElementSources;
      elementService.mediaService.ingestElementSources = async () => ({
        mediaRecords: [{ id: "m-1" }],
        primaryMedia: { id: "m-1" },
        storageUrls: [],
      });
      const origAnalysis = elementService.analysisService;
      elementService.analysisService = null;
      const origElCreate = db.elements.create;
      db.elements.create = async (d) => d;

      try {
        await elementService.createElement({
          name: "Test Element",
          sourceImages: [{ url: "https://example.com/img.jpg", purpose: "source" }],
          projectId: "11111111-1111-1111-1111-111111111111",
          userId: "00000000-0000-0000-0000-000000000001",
        });

        assert.ok(createdWf, "createWorkflow was called");
        assert.equal(createdWf.user_id, "00000000-0000-0000-0000-000000000001", "user_id must be populated from authenticated user");
      } finally {
        db.workflows.createWorkflow = origCreate;
        elementService.mediaService.ingestElementSources = origIngest;
        elementService.analysisService = origAnalysis;
        db.elements.create = origElCreate;
      }
    });

    it("WorkflowMediaService.detachMedia sets user_id on created standalone workflow row", async () => {
      let createdWf = null;
      const origCreate = db.workflows.createWorkflow;
      db.workflows.createWorkflow = async (data) => {
        createdWf = data;
        return { id: "detached-wf-1", ...data };
      };

      const origAuth = workflowMediaService.authService.verifyMediaOwnership;
      workflowMediaService.authService.verifyMediaOwnership = async () => true;

      const origMediaClient = db.media.client;
      db.media.client = () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: "media-1",
                  workflow_id: "old-wf",
                  status: "completed",
                  user_id: "00000000-0000-0000-0000-000000000001",
                  project_id: "11111111-1111-1111-1111-111111111111",
                },
                error: null,
              }),
            }),
          }),
        }),
      });

      const origMediaUpdate = db.media.updateFields;
      db.media.updateFields = async () => ({});
      const origWfUpdate = db.workflows.updateFields;
      db.workflows.updateFields = async () => ({});
      const origFindById = db.workflows.findById;
      db.workflows.findById = async () => null;

      try {
        await workflowMediaService.detachMedia({
          mediaId: "media-1",
          userId: "00000000-0000-0000-0000-000000000001",
          projectId: "11111111-1111-1111-1111-111111111111",
        });

        assert.ok(createdWf, "createWorkflow was called");
        assert.equal(createdWf.user_id, "00000000-0000-0000-0000-000000000001", "user_id must be populated on detached workflow");
      } finally {
        db.workflows.createWorkflow = origCreate;
        workflowMediaService.authService.verifyMediaOwnership = origAuth;
        db.media.client = origMediaClient;
        db.media.updateFields = origMediaUpdate;
        db.workflows.updateFields = origWfUpdate;
        db.workflows.findById = origFindById;
      }
    });
  });

  describe("2. Workflow with user_id NULL in project owned by User A", () => {
    it("User A moves it to User A's folder -> 200", async () => {
      const res = await fetch(`${baseUrl}/api/assets/44444444-4444-4444-4444-444444444444/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: "33333333-3333-3333-3333-333333333333" }),
      });

      assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
      const body = await res.json();
      assert.equal(body.folderId, "33333333-3333-3333-3333-333333333333");
    });

    it("User B attempts to move it -> 404", async () => {
      const res = await fetch(`${baseUrl}/api/assets/44444444-4444-4444-4444-444444444444/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-B",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: null }),
      });

      assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    });
  });

  describe("3. WorkflowRepository.updateFolderId Contract & Error Mapping", () => {
    it("throws if userId or projectId is missing", async () => {
      const repo = new WorkflowRepository();
      await assert.rejects(
        () => repo.updateFolderId("44444444-4444-4444-4444-444444444444", "33333333-3333-3333-3333-333333333333", null, "11111111-1111-1111-1111-111111111111"),
        /required/i
      );
      await assert.rejects(
        () => repo.updateFolderId("44444444-4444-4444-4444-444444444444", "33333333-3333-3333-3333-333333333333", "00000000-0000-0000-0000-000000000001", null),
        /required/i
      );
    });

    it("maps PGRST116 (zero rows updated) to 404 error", async () => {
      const repo = new WorkflowRepository();
      const origClient = repo.client.bind(repo);
      repo.client = () => ({
        from: () => ({
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: async () => ({
                    data: null,
                    error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
                  }),
                }),
              }),
            }),
          }),
        }),
      });

      try {
        await assert.rejects(
          () => repo.updateFolderId("44444444-4444-4444-4444-444444444444", null, "00000000-0000-0000-0000-000000000001", "11111111-1111-1111-1111-111111111111"),
          (err) => err.statusCode === 404 && err.code === "PGRST116"
        );
      } finally {
        repo.client = origClient;
      }
    });

    it("maps 23503 (foreign key constraint violation) to 404 error", async () => {
      const repo = new WorkflowRepository();
      const origClient = repo.client.bind(repo);
      repo.client = () => ({
        from: () => ({
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: async () => ({
                    data: null,
                    error: { code: "23503", message: "foreign key constraint violation" },
                  }),
                }),
              }),
            }),
          }),
        }),
      });

      try {
        await assert.rejects(
          () => repo.updateFolderId("44444444-4444-4444-4444-444444444444", "33333333-3333-3333-3333-333333333333", "00000000-0000-0000-0000-000000000001", "11111111-1111-1111-1111-111111111111"),
          (err) => err.statusCode === 404 && err.code === "23503"
        );
      } finally {
        repo.client = origClient;
      }
    });
  });

  describe("4. folderId UUID Validation (invalid -> 400)", () => {
    it("PATCH /api/assets/:assetId/folder rejects non-UUID folderId with 400", async () => {
      const res = await fetch(`${baseUrl}/api/assets/44444444-4444-4444-4444-444444444444/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: "invalid-not-a-uuid" }),
      });

      assert.equal(res.status, 400, `Expected 400, got ${res.status}`);
    });

    it("POST /api/assets/upload rejects non-UUID folderId with 400", async () => {
      const res = await fetch(`${baseUrl}/api/assets/upload`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          project_id: "11111111-1111-1111-1111-111111111111",
          folderId: "invalid-not-a-uuid",
          base64: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        }),
      });

      assert.equal(res.status, 400, `Expected 400, got ${res.status}`);
    });

    it("POST /api/images/generated rejects non-UUID folderId with 400", async () => {
      const res = await fetch(`${baseUrl}/api/images/generated`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: "11111111-1111-1111-1111-111111111111",
          folderId: "invalid-not-a-uuid",
          prompt: "test prompt",
          model: "nanobana_2",
        }),
      });

      assert.equal(res.status, 400, `Expected 400, got ${res.status}`);
    });

    it("POST /api/video/generated rejects non-UUID folderId with 400", async () => {
      const res = await fetch(`${baseUrl}/api/video/generated`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: "11111111-1111-1111-1111-111111111111",
          folderId: "invalid-not-a-uuid",
          prompt: "test video prompt",
          model: "seedance_v1",
        }),
      });

      assert.equal(res.status, 400, `Expected 400, got ${res.status}`);
    });
  });
});
