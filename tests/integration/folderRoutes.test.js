import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import apiRouter from "../../src/api/routes.js";
import { db } from "../../src/container.js";
import { supabase } from "../../lib/supabase.js";
import { setLimiterForTest, resetLimitersForTest } from "../../src/middleware/rateLimit.js";
import { redisConnection, workerRedisConnection, rateLimitRedisConnection } from "../../src/queue/redis.js";

process.env.NODE_ENV = "test";

describe("Folder Routes HTTP Acceptance & Security (Task F-T5)", () => {
  let server;
  let baseUrl;
  let origGetUser;

  // In-memory data store for the test suite
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
      { id: "proj-A", user_id: "user-A", name: "User A Project" },
      { id: "proj-B", user_id: "user-B", name: "User B Project" },
    ];

    folders = [
      {
        id: "f-root-A1",
        project_id: "proj-A",
        user_id: "user-A",
        parent_id: null,
        name: "Scene 1",
        position: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: "f-sub-A1",
        project_id: "proj-A",
        user_id: "user-A",
        parent_id: "f-root-A1",
        name: "Shots",
        position: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: "f-root-B1",
        project_id: "proj-B",
        user_id: "user-B",
        parent_id: null,
        name: "Scene 1",
        position: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    workflows = [
      { id: "wf-1", project_id: "proj-A", folder_id: "f-root-A1", user_id: "user-A" },
    ];

    // Mock project ownership checks
    db.projects.findByUser = async (userId, projectId) => {
      const p = projects.find((proj) => proj.id === projectId && proj.user_id === userId);
      return p ? [p] : [];
    };

    db.projects.findById = async (projectId) => {
      return projects.find((proj) => proj.id === projectId) || null;
    };

    // Mock folder repo
    db.folders.listByProject = async (projectId, userId) => {
      return folders
        .filter((f) => f.project_id === projectId && f.user_id === userId)
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
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

    db.folders.countByProject = async (projectId, userId) => {
      return folders.filter((f) => f.project_id === projectId && f.user_id === userId).length;
    };

    db.folders.create = async ({ projectId, userId, parentId, name, position }) => {
      const newFolder = {
        id: `f-new-${Date.now()}-${Math.random()}`,
        project_id: projectId,
        user_id: userId,
        parent_id: parentId || null,
        name,
        position,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      folders.push(newFolder);
      return newFolder;
    };

    db.folders.updateOwned = async (folderId, userId, patch) => {
      const f = folders.find((fol) => fol.id === folderId && fol.user_id === userId);
      if (!f) return null;
      if (patch.name !== undefined) f.name = patch.name;
      if (patch.parentId !== undefined) f.parent_id = patch.parentId;
      if (patch.position !== undefined) f.position = patch.position;
      f.updated_at = new Date().toISOString();
      return f;
    };

    db.folders.deleteOwned = async (folderId, userId) => {
      const idx = folders.findIndex((fol) => fol.id === folderId && fol.user_id === userId);
      if (idx === -1) return false;
      folders.splice(idx, 1);
      return true;
    };

    db.folders.countAssetsByFolder = async (projectId, userId) => {
      const map = {};
      for (const wf of workflows) {
        if (wf.project_id === projectId && wf.folder_id) {
          map[wf.folder_id] = (map[wf.folder_id] || 0) + 1;
        }
      }
      return map;
    };

    db.folders.countChildren = async (folderId, userId) => {
      return folders.filter((f) => f.parent_id === folderId && f.user_id === userId).length;
    };

    db.folders.countAssetsIn = async (folderId, userId) => {
      return workflows.filter((wf) => wf.folder_id === folderId).length;
    };
  });

  describe("Authentication & Boundary Hardening", () => {
    it("returns 401 when request is unauthenticated (no token)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`);
      assert.equal(res.status, 401);
    });

    it("ignores internal secret and returns 401 for folder routes even if INTERNAL_AUTH_ENABLED=true", async () => {
      const origEnabled = process.env.INTERNAL_AUTH_ENABLED;
      process.env.INTERNAL_AUTH_ENABLED = "true";
      try {
        const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
          headers: {
            "x-internal-secret": process.env.INTERNAL_SECRET,
            "x-user-id": "user-A",
          },
        });
        assert.equal(res.status, 401); // Internal secret not allowlisted on folder routes
      } finally {
        process.env.INTERNAL_AUTH_ENABLED = origEnabled;
      }
    });

    it("returns 404 when User B tries to list User A's folders (cross-tenant)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
        headers: { Authorization: "Bearer token-user-B" },
      });
      assert.equal(res.status, 404);
    });

    it("returns 404 when User B tries to update User A's folder (cross-tenant)", async () => {
      const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-B",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Attacker Rename" }),
      });
      assert.equal(res.status, 404);
    });

    it("returns 404 when User B tries to delete User A's folder (cross-tenant)", async () => {
      const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
        method: "DELETE",
        headers: { Authorization: "Bearer token-user-B" },
      });
      assert.equal(res.status, 404);
    });
  });

  describe("Acceptance Scenarios 1 to 6 & 10", () => {
    it("Scenario 1: creates root folder successfully (POST /api/projects/:id/folders)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "New Root Scene" }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.name, "New Root Scene");
      assert.equal(data.parentId, null);
      assert.equal(data.projectId, "proj-A");
    });

    it("Scenario 2: creates sub-folder under existing folder", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Angles", parentId: "f-root-A1" }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.name, "Angles");
      assert.equal(data.parentId, "f-root-A1");
    });

    it("creates sub-folder when parentId is provided in request body", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Sub Collection A", parentId: "f-root-A1" }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.name, "Sub Collection A");
      assert.equal(data.parentId, "f-root-A1");
    });

    it("Scenario 3: renames folder successfully (PATCH /api/folders/:id)", async () => {
      const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Scene 1 - Final Cut" }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.name, "Scene 1 - Final Cut");
    });

    it("Scenario 4: moves folder to root or another parent", async () => {
      const res = await fetch(`${baseUrl}/api/folders/f-sub-A1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ parentId: null }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.parentId, null);
    });

    it("Scenario 6: refuses deleting non-empty folder (409 FOLDER_NOT_EMPTY)", async () => {
      // f-root-A1 has sub-folder and workflow asset
      const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
        method: "DELETE",
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.errorCode, "FOLDER_NOT_EMPTY");
    });

    it("Scenario 5: deletes empty folder successfully (204 No Content)", async () => {
      // f-sub-A1 has 0 assets and 0 sub-folders
      const res = await fetch(`${baseUrl}/api/folders/f-sub-A1`, {
        method: "DELETE",
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 204);
      assert.equal(folders.some((f) => f.id === "f-sub-A1"), false);
    });

    it("lists folders with asset counts ordered by position, then name", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert(Array.isArray(data.items));
      assert.equal(data.items.length, 2);
      assert.equal(data.items[0].assetCount, 1);
    });

    it("Scenario 10: rejects invalid folder name with FOLDER_NAME_INVALID", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "   " }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.errorCode, "FOLDER_NAME_INVALID");
    });

    it("Scenario 10: rejects cyclic folder move with FOLDER_CYCLE", async () => {
      const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ parentId: "f-root-A1" }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.errorCode, "FOLDER_CYCLE");
    });

    it("rate limiting: returns 429 when folderWrite points are exceeded", async () => {
      setLimiterForTest("folderWrite", {
        consume: async () => {
          const err = new Error("Rate limit exceeded");
          err.msBeforeNext = 15000;
          throw err;
        },
      });

      try {
        const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
          method: "POST",
          headers: {
            Authorization: "Bearer token-user-A",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Spam Folder" }),
        });

        assert.equal(res.status, 429);
      } finally {
        resetLimitersForTest();
      }
    });
  });
});
