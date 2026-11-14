import { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { ProjectService, ProjectReadService, ProjectRepository } from "#workspace/tools";
import { getAll, create, update, remove, projectsRouter } from "#workspace/api";
import { projectService } from "../../../src/container.js";
import { AppError, redisConnection, workerRedisConnection, rateLimitRedisConnection } from "#shared";
import express from "express";
import http from "node:http";
import { supabase } from "#shared/db/supabase.js";

// ─── Source: projectServiceAndRepository.test.js ───
{
describe("Slice B: ProjectService & Repository isolation", () => {
    it("ProjectService.listUserProjects delegates to projectRepo and maps name/thumbnail", async () => {
        const mockProjects = [
            { id: "p1", project_name: "Project One", user_id: "u1", media: [{ url: "https://cdn.example.com/thumb.png" }] },
            { id: "p2", project_name: "Project Two", user_id: "u1", media: [] },
        ];
        const mockRepo = {
            findProjectsWithThumbnails: async (userId) => {
                assert.equal(userId, "u1");
                return mockProjects;
            },
        };
        const service = new ProjectService({ projectRepo: mockRepo });
        const result = await service.listUserProjects("u1");

        assert.equal(result.length, 2);
        assert.equal(result[0].name, "Project One");
        assert.equal(result[0].thumbnail_url, "https://cdn.example.com/thumb.png");
        assert.equal(result[1].name, "Project Two");
        assert.equal(result[1].thumbnail_url, null);
    });

    it("ProjectService.createProject generates default name if none supplied and inserts via repo", async () => {
        let insertedPayload = null;
        const mockRepo = {
            insertProject: async ({ projectName, userId }) => {
                insertedPayload = { projectName, userId };
                return { id: "p-new", project_name: projectName, user_id: userId };
            },
        };
        const service = new ProjectService({ projectRepo: mockRepo });
        const result = await service.createProject({ userId: "u1" });

        assert.ok(insertedPayload);
        assert.equal(insertedPayload.userId, "u1");
        assert.ok(insertedPayload.projectName.length > 0);
        assert.equal(result.name, insertedPayload.projectName);
    });

    it("ProjectService.updateProject enforces ownership and throws 404 for foreign access", async () => {
        const mockRepo = {
            findOwnedProject: async (id, userId) => null, // foreign or missing
            updateProjectName: async () => assert.fail("Should not reach update"),
        };
        const service = new ProjectService({ projectRepo: mockRepo });

        await assert.rejects(
            async () => service.updateProject({ id: "p-foreign", userId: "u1", name: "Hacked" }),
            (err) => {
                assert.equal(err.statusCode, 404);
                assert.match(err.message, /not found/i);
                return true;
            }
        );
    });

    it("ProjectService.deleteProject enforces ownership and throws 404 for foreign access", async () => {
        const mockRepo = {
            findOwnedProject: async (id, userId) => null,
            deleteOwnedProject: async () => assert.fail("Should not reach delete"),
        };
        const service = new ProjectService({ projectRepo: mockRepo });

        await assert.rejects(
            async () => service.deleteProject({ id: "p-foreign", userId: "u1" }),
            (err) => {
                assert.equal(err.statusCode, 404);
                assert.match(err.message, /not found/i);
                return true;
            }
        );
    });

    it("ProjectReadService.getProjectData queries strictly through injected db repositories", async () => {
        let queriedProjects = false;
        let queriedMedia = false;
        let queriedElements = false;
        let queriedCharacters = false;
        let queriedWorkflowMedia = false;

        const mockDb = {
            projects: {
                findById: async (id) => {
                    queriedProjects = true;
                    return { id, project_name: "Repo Clean Project", user_id: "user-1" };
                },
            },
            workflows: {
                findByProject: async () => [
                    { id: "wf-1", display_name: "Workflow 1", create_time: "2026-01-01T00:00:00Z", workflow_type: "GENERATION" },
                ],
            },
            media: {
                findByProjectAll: async (projectId) => {
                    queriedMedia = true;
                    return [];
                },
            },
            elements: {
                findByWorkflowIds: async (ids) => {
                    queriedElements = true;
                    return [];
                },
            },
            characters: {
                findByProjectOrWorkflowIds: async ({ projectId, workflowIds }) => {
                    queriedCharacters = true;
                    return [];
                },
            },
            workflowMedia: {
                findRelationsByWorkflowIds: async (ids) => {
                    queriedWorkflowMedia = true;
                    return [];
                },
            },
        };

        const readService = new ProjectReadService({ db: mockDb });
        const data = await readService.getProjectData({ projectId: "proj-1", userId: "user-1" });

        assert.ok(queriedProjects, "Must query projects repository");
        assert.ok(queriedMedia, "Must query media repository");
        assert.ok(queriedElements, "Must query elements repository");
        assert.ok(queriedCharacters, "Must query characters repository");
        assert.ok(queriedWorkflowMedia, "Must query workflowMedia repository");
        assert.equal(data.projectName, "Repo Clean Project");
    });
});
}

// ─── Source: projectRepositoryMostRecent.test.js ───
{
process.env.NODE_ENV = "test";


/**
 * Minimal fake of the Supabase query builder at the repository's client()
 * seam. Records the shape of the query (ordering/limit) and resolves the
 * terminal call with the configured result.
 */
function makeRepo({ result, error, onOrder } = {}) {
    const repo = new ProjectRepository();
    const builder = {};
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.order = (column, opts) => {
        if (onOrder) onOrder(column, opts);
        return builder;
    };
    builder.limit = () => builder;
    builder.maybeSingle = async () => ({ data: result ?? null, error: error || null });
    repo.client = () => ({ from: () => builder });
    return repo;
}

describe("ProjectRepository.findMostRecentForUser", () => {
    it("queries the most recent project explicitly by create_time descending", async () => {
        let recorded;
        const repo = makeRepo({
            result: { id: "p-latest-2", user_id: "u1" },
            onOrder: (column, opts) => {
                recorded = { column, opts };
            },
        });

        const project = await repo.findMostRecentForUser("u1");

        assert.equal(project.id, "p-latest-2");
        assert.deepEqual(recorded, { column: "create_time", opts: { ascending: false } });
    });

    it("returns null when the user has no projects", async () => {
        const repo = makeRepo({ result: null });
        assert.equal(await repo.findMostRecentForUser("u1"), null);
    });

    it("propagates repository errors to the caller", async () => {
        const repo = makeRepo({ error: new Error("supabase unavailable") });
        await assert.rejects(
            async () => repo.findMostRecentForUser("u1"),
            /supabase unavailable/
        );
    });
});
}

// ─── Source: projectsController.test.js ───
{
describe("projectsController unit tests", () => {
    let originalListUserProjects;
    let originalCreateProject;
    let originalUpdateProject;
    let originalDeleteProject;

    beforeEach(() => {
        originalListUserProjects = projectService.listUserProjects;
        originalCreateProject = projectService.createProject;
        originalUpdateProject = projectService.updateProject;
        originalDeleteProject = projectService.deleteProject;
    });

    afterEach(() => {
        projectService.listUserProjects = originalListUserProjects;
        projectService.createProject = originalCreateProject;
        projectService.updateProject = originalUpdateProject;
        projectService.deleteProject = originalDeleteProject;
    });

    it("getAll calls projectService.listUserProjects and returns data", async () => {
        projectService.listUserProjects = async (userId) => [
            { id: "p1", name: "P1", thumbnail_url: "http://example.com/1.png" },
        ];

        const req = { user: { id: "user-abc" } };
        let sent = null;
        const res = {
            json: (payload) => {
                sent = payload;
            },
        };

        await getAll(req, res);
        assert.deepEqual(sent, {
            ok: true,
            data: [{ id: "p1", name: "P1", thumbnail_url: "http://example.com/1.png" }],
        });
    });

    it("create passes name and userId to projectService.createProject", async () => {
        let calledWith = null;
        projectService.createProject = async (args) => {
            calledWith = args;
            return { id: "new-p", name: args.name, user_id: args.userId };
        };

        const req = { user: { id: "user-abc" }, body: { name: "My New Canvas" } };
        let sent = null;
        const res = {
            json: (payload) => {
                sent = payload;
            },
        };

        await create(req, res);
        assert.deepEqual(calledWith, { userId: "user-abc", name: "My New Canvas" });
        assert.equal(sent.ok, true);
        assert.equal(sent.data.id, "new-p");
    });

    it("update returns 404 when projectService throws AppError(404)", async () => {
        projectService.updateProject = async () => {
            throw new AppError("Project not found", 404);
        };

        const req = { params: { id: "p-other" }, user: { id: "user-abc" }, body: { name: "Renamed" } };
        let statusCode = 200;
        let sent = null;
        const res = {
            status: (code) => {
                statusCode = code;
                return res;
            },
            json: (payload) => {
                sent = payload;
            },
        };

        await update(req, res);
        assert.equal(statusCode, 404);
        assert.equal(sent.ok, false);
        assert.equal(sent.message, "Project not found");
    });

    it("remove returns 200 on success", async () => {
        let deletedId = null;
        projectService.deleteProject = async ({ id }) => {
            deletedId = id;
            return true;
        };

        const req = { params: { id: "p-del" }, user: { id: "user-abc" } };
        let sent = null;
        const res = {
            json: (payload) => {
                sent = payload;
            },
        };

        await remove(req, res);
        assert.equal(deletedId, "p-del");
        assert.deepEqual(sent, { ok: true });
    });
});
}

// ─── Source: projectCascadeFoldersBoundary.test.js ───
{
process.env.NODE_ENV = "test";

describe("Project Deletion with Folders Boundary & Cascade (7.7 & Acceptance Check 7)", () => {
  let server;
  let baseUrl;
  let origGetUser;
  let origFrom;

  let projects = [];
  let folders = [];
  let workflows = [];

  before(async () => {
    origGetUser = supabase.auth.getUser;
    supabase.auth.getUser = async (token) => {
      if (token === "token-user-A") return { data: { user: { id: "user-A" } }, error: null };
      if (token === "token-user-B") return { data: { user: { id: "user-B" } }, error: null };
      return { data: { user: null }, error: new Error("Invalid token") };
    };

    origFrom = supabase.from;
    supabase.from = (table) => {
      if (table === "project") {
        return {
          select: () => ({
            eq: (col, val) => ({
              single: async () => {
                const p = projects.find((item) => item[col] === val);
                if (!p) return { data: null, error: { message: "Not found" } };
                return { data: p, error: null };
              },
            }),
          }),
          delete: () => ({
            eq: (col1, val1) => ({
              eq: async (col2, val2) => {
                const idx = projects.findIndex((p) => p[col1] === val1 && p[col2] === val2);
                if (idx === -1) {
                  return { error: { message: "Not found" } };
                }
                const deletedProject = projects.splice(idx, 1)[0];
                // Simulate DB CASCADE deletion on child folders and workflows
                folders = folders.filter((f) => f.project_id !== deletedProject.id);
                workflows = workflows.filter((w) => w.project_id !== deletedProject.id);
                return { error: null };
              },
            }),
          }),
        };
      }
      return origFrom?.(table);
    };

    const app = express();
    app.use(express.json());
    app.use("/api/projects", projectsRouter);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    supabase.auth.getUser = origGetUser;
    supabase.from = origFrom;
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
    projects = [
      { id: "00000000-0000-0000-0000-000000000001", user_id: "user-A", name: "User A Project" },
      { id: "00000000-0000-0000-0000-000000000002", user_id: "user-B", name: "User B Project" },
    ];
    folders = [
      {
        id: "00000000-0000-0000-0000-000000000010",
        project_id: "00000000-0000-0000-0000-000000000001",
        user_id: "user-A",
        name: "Scene 1",
      },
      {
        id: "00000000-0000-0000-0000-000000000011",
        project_id: "00000000-0000-0000-0000-000000000001",
        user_id: "user-A",
        name: "Scene 2",
      },
    ];
    workflows = [
      {
        id: "00000000-0000-0000-0000-000000000020",
        project_id: "00000000-0000-0000-0000-000000000001",
        user_id: "user-A",
        folder_id: "00000000-0000-0000-0000-000000000010",
      },
    ];
  });

  it("deleting a project with child folders succeeds and cleans up folder records without error", async () => {
    const res = await fetch(`${baseUrl}/api/projects/00000000-0000-0000-0000-000000000001`, {
      method: "DELETE",
      headers: { Authorization: "Bearer token-user-A" },
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);

    // Verify project deleted and child folders/workflows cascaded
    assert.equal(projects.some((p) => p.id === "00000000-0000-0000-0000-000000000001"), false);
    assert.equal(folders.filter((f) => f.project_id === "00000000-0000-0000-0000-000000000001").length, 0);
    assert.equal(workflows.filter((w) => w.project_id === "00000000-0000-0000-0000-000000000001").length, 0);
  });

  it("foreign user cannot delete another user's project that contains folders (returns 404)", async () => {
    const res = await fetch(`${baseUrl}/api/projects/00000000-0000-0000-0000-000000000001`, {
      method: "DELETE",
      headers: { Authorization: "Bearer token-user-B" },
    });

    assert.equal(res.status, 404);
    assert.equal(projects.some((p) => p.id === "00000000-0000-0000-0000-000000000001"), true);
  });
});
}
