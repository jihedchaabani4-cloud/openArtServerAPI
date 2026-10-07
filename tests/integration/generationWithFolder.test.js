import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import apiRouter from "../../src/api/routes.js";
import { db, walletService, useCaseService, folderService } from "../../src/container.js";
import { supabase } from "../../lib/supabase.js";
import { V1StorageBridge } from "../../src/v2/services/v1StorageBridge.js";
import { redisConnection, workerRedisConnection, rateLimitRedisConnection } from "../../src/queue/redis.js";

process.env.NODE_ENV = "test";

const v1StorageBridge = new V1StorageBridge({ db });

describe("Generation & Upload Endpoints with folderId & Worker Fallback (Task F-T8)", () => {
  let server;
  let baseUrl;
  let origGetUser;

  let projects = [];
  let folders = [];
  let workflows = [];
  let media = [];
  let creditHolds = [];

  before(async () => {
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

    // Mock useCaseService / wallet
    useCaseService.prepareAndEnqueue = async (opts) => {
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
          model: "seedance_2_5_extend",
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

  describe("Worker Resiliency: deleted folder fallback", () => {
    it("falls back to folder_id = null when target folder is deleted before worker creates placeholder", async () => {
      const { workflow } = await v1StorageBridge.createV1Placeholder({
        projectId: "proj-A",
        userId: "user-A",
        folderId: "deleted-folder-123",
        displayName: "Worker Workflow",
      });

      assert.ok(workflow);
      assert.equal(workflow.folder_id, null, "Deleted folder must fall back to folder_id = null");
    });
  });
});
