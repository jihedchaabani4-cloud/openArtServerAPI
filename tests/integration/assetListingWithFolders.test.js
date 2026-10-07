import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import apiRouter from "../../src/api/routes.js";
import { db } from "../../src/container.js";
import { supabase } from "../../lib/supabase.js";
import { redisConnection, workerRedisConnection, rateLimitRedisConnection } from "../../src/queue/redis.js";

process.env.NODE_ENV = "test";

describe("Asset Listing with Folder Filters & Pagination (Task F-T7)", () => {
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
      { id: "proj-A", user_id: "user-A", project_name: "Project Alpha" },
      { id: "proj-B", user_id: "user-B", project_name: "Project Beta" },
    ];

    // Tree:
    // folder-root-1 (root)
    //   └── folder-sub-1 (child of folder-root-1)
    // folder-root-2 (root)
    folders = [
      {
        id: "folder-root-1",
        project_id: "proj-A",
        user_id: "user-A",
        parent_id: null,
        name: "Scenes",
        position: 0,
        create_time: "2026-10-07T10:00:00.000Z",
      },
      {
        id: "folder-sub-1",
        project_id: "proj-A",
        user_id: "user-A",
        parent_id: "folder-root-1",
        name: "Scene 1",
        position: 0,
        create_time: "2026-10-07T10:05:00.000Z",
      },
      {
        id: "folder-root-2",
        project_id: "proj-A",
        user_id: "user-A",
        parent_id: null,
        name: "Characters",
        position: 1,
        create_time: "2026-10-07T10:10:00.000Z",
      },
      {
        id: "folder-foreign",
        project_id: "proj-B",
        user_id: "user-B",
        parent_id: null,
        name: "Foreign Folder",
        position: 0,
        create_time: "2026-10-07T10:00:00.000Z",
      },
    ];

    // Workflows:
    // wf-root-asset (folder_id: null)
    // wf-in-root-1  (folder_id: folder-root-1)
    // wf-in-sub-1   (folder_id: folder-sub-1)
    // wf-in-root-2  (folder_id: folder-root-2)
    // wf-foreign    (proj-B, user-B)
    workflows = [
      {
        id: "wf-1",
        project_id: "proj-A",
        user_id: "user-A",
        folder_id: null,
        display_name: "Root Asset 1",
        create_time: "2026-10-07T11:00:00.000Z",
      },
      {
        id: "wf-2",
        project_id: "proj-A",
        user_id: "user-A",
        folder_id: "folder-root-1",
        display_name: "In Root 1",
        create_time: "2026-10-07T11:05:00.000Z",
      },
      {
        id: "wf-3",
        project_id: "proj-A",
        user_id: "user-A",
        folder_id: "folder-sub-1",
        display_name: "In Sub 1",
        create_time: "2026-10-07T11:10:00.000Z",
      },
      {
        id: "wf-4",
        project_id: "proj-A",
        user_id: "user-A",
        folder_id: "folder-root-2",
        display_name: "In Root 2",
        create_time: "2026-10-07T11:15:00.000Z",
      },
      {
        id: "wf-5",
        project_id: "proj-B",
        user_id: "user-B",
        folder_id: null,
        display_name: "Foreign WF",
        create_time: "2026-10-07T11:20:00.000Z",
      },
    ];

    // Mock db.projects
    db.projects.findByUser = async (userId, projectId) => {
      return projects.filter(
        (p) => p.user_id === userId && (!projectId || p.id === projectId)
      );
    };
    db.projects.findById = async (id) => {
      return projects.find((p) => p.id === id) || null;
    };

    // Mock db.folders
    db.folders.listByProject = async (projectId, userId) => {
      return folders.filter((f) => f.project_id === projectId && f.user_id === userId);
    };
    db.folders.findOwnedInProject = async (folderId, projectId, userId) => {
      return (
        folders.find(
          (f) => f.id === folderId && f.project_id === projectId && f.user_id === userId
        ) || null
      );
    };

    // Mock db.workflows
    db.workflows.listProjectAssets = async (projectId, { folderIds, folderIdNull, limit = 50, cursor } = {}) => {
      let list = workflows.filter((w) => w.project_id === projectId);
      if (folderIdNull) {
        list = list.filter((w) => w.folder_id === null || w.folder_id === undefined);
      } else if (Array.isArray(folderIds)) {
        list = list.filter((w) => folderIds.includes(w.folder_id));
      }

      // Order newest first
      list.sort((a, b) => {
        if (b.create_time !== a.create_time) return b.create_time.localeCompare(a.create_time);
        return b.id.localeCompare(a.id);
      });

      if (cursor && cursor.createTime) {
        list = list.filter((w) => {
          if (w.create_time < cursor.createTime) return true;
          if (w.create_time === cursor.createTime && w.id < cursor.id) return true;
          return false;
        });
      }

      return list.slice(0, limit + 1);
    };
  });

  describe("GET /api/projects/:projectId/assets", () => {
    it("Scenario 9.1: returns all project assets when folderId is omitted", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/assets`, {
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.items.length, 4);
      assert.equal(data.nextCursor, null);
      // Verify serialized DTO format
      assert.equal(data.items[0].projectId, "proj-A");
      assert.equal(typeof data.items[0].id, "string");
      assert.equal(typeof data.items[0].name, "string");
    });

    it("Scenario 9.2: returns only assets in specific folder (direct children)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/assets?folderId=folder-root-1`, {
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.items.length, 1);
      assert.equal(data.items[0].id, "wf-2");
      assert.equal(data.items[0].folderId, "folder-root-1");
    });

    it("Scenario 9.3: returns only assets with folder_id null when folderId=none", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/assets?folderId=none`, {
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.items.length, 1);
      assert.equal(data.items[0].id, "wf-1");
      assert.equal(data.items[0].folderId, null);
    });

    it("Scenario 9.4: returns assets in folder and sub-folders when includeDescendants=true", async () => {
      const res = await fetch(
        `${baseUrl}/api/projects/proj-A/assets?folderId=folder-root-1&includeDescendants=true`,
        { headers: { Authorization: "Bearer token-user-A" } }
      );

      assert.equal(res.status, 200);
      const data = await res.json();
      // Should include wf-2 (in folder-root-1) and wf-3 (in folder-sub-1)
      assert.equal(data.items.length, 2);
      const ids = data.items.map((i) => i.id).sort();
      assert.deepEqual(ids, ["wf-2", "wf-3"]);
    });

    it("Scenario 9.5: ignores includeDescendants when folderId=none", async () => {
      const res = await fetch(
        `${baseUrl}/api/projects/proj-A/assets?folderId=none&includeDescendants=true`,
        { headers: { Authorization: "Bearer token-user-A" } }
      );

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.items.length, 1);
      assert.equal(data.items[0].id, "wf-1");
    });

    it("Scenario 9.6: pagination across 2 pages with limit and nextCursor round-trip", async () => {
      // Page 1: limit=2
      const res1 = await fetch(`${baseUrl}/api/projects/proj-A/assets?limit=2`, {
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res1.status, 200);
      const page1 = await res1.json();
      assert.equal(page1.items.length, 2);
      assert.ok(page1.nextCursor, "Expected nextCursor on page 1");

      // Page 2: with cursor
      const res2 = await fetch(
        `${baseUrl}/api/projects/proj-A/assets?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
        { headers: { Authorization: "Bearer token-user-A" } }
      );

      assert.equal(res2.status, 200);
      const page2 = await res2.json();
      assert.equal(page2.items.length, 2);
      assert.equal(page2.nextCursor, null);

      // Verify no overlap
      const p1Ids = page1.items.map((i) => i.id);
      const p2Ids = page2.items.map((i) => i.id);
      for (const id of p1Ids) {
        assert.ok(!p2Ids.includes(id), `Page 2 should not contain ${id}`);
      }
      assert.equal(p1Ids.length + p2Ids.length, 4);
    });

    it("returns 400 for invalid folderId format", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/assets?folderId=invalid!@#$%`, {
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.errorCode, "VALIDATION_ERROR");
    });

    it("returns 404 for foreign folderId (User B's folder)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/assets?folderId=folder-foreign`, {
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 404);
    });

    it("returns 404 for foreign projectId (cross-tenant)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-B/assets`, {
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 404);
    });

    it("returns 401 when unauthenticated", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/assets`);
      assert.equal(res.status, 401);
    });

    it("Decision D-20: preserves existing /api/workflows/project-data/:project_id response shape", async () => {
      const { projectReadService } = await import("../../src/container.js");
      const origGetProjectData = projectReadService.getProjectData;
      projectReadService.getProjectData = async () => ({
        projectName: "Project Alpha",
        appConfig: {},
        sessions: [],
        workflows: [{ id: "wf-1" }],
        media: [],
        elements: [],
        characters: [],
      });

      try {
        const res = await fetch(`${baseUrl}/api/workflows/project-data/proj-A`, {
          headers: { Authorization: "Bearer token-user-A" },
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.ok(data.result?.data?.json?.projectContents, "Expected result.data.json.projectContents shape");
        assert.ok(Array.isArray(data.result.data.json.projectContents.workflows));
      } finally {
        projectReadService.getProjectData = origGetProjectData;
      }
    });

    it("returns folder_id and folderId on workflows in /api/workflows/project-data/:projectId", async () => {
      const origFrom = supabase.from;
      supabase.from = (table) => {
        if (table === "project") {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: "proj-A", user_id: "user-A", project_name: "Project A" },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "media") {
          return {
            select: () => ({
              eq: () => ({
                order: async () => ({ data: [], error: null }),
              }),
            }),
          };
        }
        if (table === "element") {
          return {
            select: () => ({
              in: async () => ({ data: [], error: null }),
            }),
          };
        }
        return origFrom?.call(supabase, table);
      };

      const origFindByProject = db.workflows.findByProject;
      db.workflows.findByProject = async (projectId, options = {}) => {
        return [
          {
            id: "wf-2",
            display_name: "In Root 1",
            folder_id: "folder-root-1",
            workflow_type: "UPLOAD",
            create_time: "2026-10-07T11:05:00.000Z",
          },
          {
            id: "wf-1",
            display_name: "Root Asset 1",
            folder_id: null,
            workflow_type: "UPLOAD",
            create_time: "2026-10-07T11:00:00.000Z",
          },
        ];
      };

      try {
        const res = await fetch(`${baseUrl}/api/workflows/project-data/proj-A`, {
          headers: { Authorization: "Bearer token-user-A" },
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        const workflowsInResponse = data.result?.data?.json?.projectContents?.workflows;
        assert.ok(workflowsInResponse, "Expected workflows array");
        const wfInFolder = workflowsInResponse.find((w) => w.id === "wf-2");
        assert.ok(wfInFolder, "Expected wf-2");
        assert.equal(wfInFolder.folder_id, "folder-root-1", "wf-2 must have folder_id");
        assert.equal(wfInFolder.folderId, "folder-root-1", "wf-2 must have folderId alias");
        assert.equal(wfInFolder.metadata?.folder_id, "folder-root-1", "metadata must have folder_id");
      } finally {
        supabase.from = origFrom;
        db.workflows.findByProject = origFindByProject;
      }
    });
  });
});
