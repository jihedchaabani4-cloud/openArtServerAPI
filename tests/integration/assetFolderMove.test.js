import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import apiRouter from "../../src/api/routes.js";
import { db } from "../../src/container.js";
import { supabase } from "../../lib/supabase.js";
import { redisConnection, workerRedisConnection, rateLimitRedisConnection } from "../../src/queue/redis.js";

process.env.NODE_ENV = "test";

describe("Asset Folder Move Route & Mass-Assignment Defense (Task F-T6)", () => {
  let server;
  let baseUrl;
  let origGetUser;

  // In-memory mock store
  let projects = [];
  let folders = [];
  let workflows = [];

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
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
      await rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect());
    } catch {}
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    projects = [
      { id: "proj-A1", user_id: "user-A", name: "User A Project 1" },
      { id: "proj-A2", user_id: "user-A", name: "User A Project 2" },
      { id: "proj-B1", user_id: "user-B", name: "User B Project 1" },
    ];

    folders = [
      {
        id: "folder-A-1",
        project_id: "proj-A1",
        user_id: "user-A",
        parent_id: null,
        name: "Scene 1",
        position: 0,
      },
      {
        id: "folder-A-2",
        project_id: "proj-A1",
        user_id: "user-A",
        parent_id: null,
        name: "Scene 2",
        position: 1,
      },
      {
        id: "folder-A-other-proj",
        project_id: "proj-A2",
        user_id: "user-A",
        parent_id: null,
        name: "Project 2 Folder",
        position: 0,
      },
      {
        id: "folder-B-1",
        project_id: "proj-B1",
        user_id: "user-B",
        parent_id: null,
        name: "Bob Folder",
        position: 0,
      },
    ];

    workflows = [
      {
        id: "wf-A-1",
        project_id: "proj-A1",
        user_id: "user-A",
        folder_id: "folder-A-1",
        display_name: "Workflow A1",
        create_time: new Date().toISOString(),
      },
      {
        id: "wf-B-1",
        project_id: "proj-B1",
        user_id: "user-B",
        folder_id: "folder-B-1",
        display_name: "Workflow B1",
        create_time: new Date().toISOString(),
      },
    ];

    // Mock db.projects
    db.projects.findByUser = async (userId, projectId) => {
      const p = projects.find((proj) => proj.id === projectId && proj.user_id === userId);
      return p ? [p] : [];
    };
    db.projects.findById = async (projectId) => {
      return projects.find((proj) => proj.id === projectId) || null;
    };

    // Mock db.folders
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

    // Mock db.workflows
    db.workflows.findById = async (id) => {
      return workflows.find((w) => w.id === id) || null;
    };
    db.workflows.getWorkflow = async (id) => {
      return workflows.find((w) => w.id === id) || null;
    };
    db.workflows.updateFolderId = async (workflowId, folderId, userId) => {
      const wf = workflows.find((w) => w.id === workflowId && (!userId || w.user_id === userId));
      if (!wf) return null;
      wf.folder_id = folderId;
      return wf;
    };
    db.workflows.updateFields = async (workflowId, fields) => {
      const wf = workflows.find((w) => w.id === workflowId);
      if (!wf) return null;
      Object.assign(wf, fields);
      return wf;
    };
  });

  describe("PATCH /api/assets/:assetId/folder - Dedicated Move Route", () => {
    it("Scenario 8: moves asset from folder A to folder B in same project", async () => {
      const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: "folder-A-2" }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.folderId, "folder-A-2");
      assert.equal(workflows.find((w) => w.id === "wf-A-1").folder_id, "folder-A-2");
    });

    it("Scenario 8: moves asset to null (returns to project root)", async () => {
      const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: null }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.folderId, null);
      assert.equal(workflows.find((w) => w.id === "wf-A-1").folder_id, null);
    });

    it("Scenario 8: moves asset with folderId='none' (returns to project root)", async () => {
      const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: "none" }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.folderId, null);
    });

    it("refuses moving asset to a foreign folder (User B's folder) -> 404", async () => {
      const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: "folder-B-1" }),
      });

      assert.equal(res.status, 404);
      // Asset folder must NOT change
      assert.equal(workflows.find((w) => w.id === "wf-A-1").folder_id, "folder-A-1");
    });

    it("refuses moving asset to a folder of another project of the same user -> 404", async () => {
      const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: "folder-A-other-proj" }),
      });

      assert.equal(res.status, 404);
      assert.equal(workflows.find((w) => w.id === "wf-A-1").folder_id, "folder-A-1");
    });

    it("refuses moving another user's asset (cross-tenant) -> 404", async () => {
      const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-B",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: "folder-B-1" }),
      });

      assert.equal(res.status, 404);
    });

    it("returns 401 when unauthenticated", async () => {
      const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId: null }),
      });

      assert.equal(res.status, 401);
    });

    it("ignores internal secret and returns 401 even if INTERNAL_AUTH_ENABLED=true", async () => {
      const origEnabled = process.env.INTERNAL_AUTH_ENABLED;
      process.env.INTERNAL_AUTH_ENABLED = "true";
      try {
        const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
          method: "PATCH",
          headers: {
            "x-internal-secret": process.env.INTERNAL_SECRET,
            "x-user-id": "user-A",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ folderId: null }),
        });

        assert.equal(res.status, 401);
      } finally {
        process.env.INTERNAL_AUTH_ENABLED = origEnabled;
      }
    });
  });

  describe("Mass-Assignment Defense on Generic Workflow Update Routes", () => {
    it("generic PATCH /api/workflows/:id rejects folderId with 400 even if display_name is present", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/wf-A-1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ display_name: "Valid Rename", folderId: "folder-A-2" }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.ok, false);
    });

    it("generic PATCH /api/workflows/:id rejects folder_id with 400 even if display_name is present", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/wf-A-1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ display_name: "Valid Rename", folder_id: "folder-A-2" }),
      });

      assert.equal(res.status, 400);
    });

    it("generic PATCH /api/workflows/:id rejects projectId with 400 even if display_name is present", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/wf-A-1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ display_name: "Valid Rename", projectId: "proj-A2" }),
      });

      assert.equal(res.status, 400);
    });

    it("generic PATCH /api/workflows/:id rejects userId with 400 even if display_name is present", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/wf-A-1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ display_name: "Valid Rename", userId: "user-B" }),
      });

      assert.equal(res.status, 400);
    });

    it("generic PATCH /api/workflows/workflows/:id rejects folderId/projectId/userId with 400", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/workflows/wf-A-1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ display_name: "Valid Rename", folderId: "folder-A-2" }),
      });

      assert.equal(res.status, 400);
    });
  });
});
