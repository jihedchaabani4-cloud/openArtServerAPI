import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import projectsRouter from "../../routes/projects.js";
import { supabase } from "../../lib/supabase.js";
import { redisConnection, workerRedisConnection, rateLimitRedisConnection } from "../../src/queue/redis.js";

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
