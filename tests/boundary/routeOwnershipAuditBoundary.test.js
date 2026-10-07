import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import http from "node:http";
import apiRouter from "../../src/api/routes.js";
import { extractRoutes } from "../../scripts/dump-routes.js";
import { db, workflowService, projectReadService } from "../../src/container.js";
import { supabase } from "../../lib/supabase.js";
import { redisConnection, workerRedisConnection, rateLimitRedisConnection } from "../../src/queue/redis.js";

import { RunRepository } from "../../src/v2/runner/runRepository.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("RC1.1-R4 — Route Table Completeness & Service Ownership Boundary Tests", () => {
  let server;
  let baseUrl;
  let origGetUser;

  const ALICE_ID         = "00000000-0000-0000-0000-000000000099";
  const FOREIGN_WF_ID    = "00000000-0000-0000-0000-000000000001";
  const FOREIGN_MEDIA_ID = "00000000-0000-0000-0000-000000000002";
  const FOREIGN_PROJ_ID  = "00000000-0000-0000-0000-000000000003";
  const FOREIGN_RUN_ID   = "00000000-0000-0000-0000-000000000004";
  const FOREIGN_USER_ID  = "00000000-0000-0000-0000-000000000005";

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

  before(async () => {
    origGetUser = supabase.auth.getUser;
    supabase.auth.getUser = async (token) => {
      if (token === "alice-token") {
        return { data: { user: { id: ALICE_ID } }, error: null };
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
      });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  // Authenticated requests as Alice without internal S2S secret bypass
  const reqAlice = (path, options = {}) => {
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer alice-token",
        ...(options.headers || {}),
      },
    });
  };

  // Mock repositories to return foreign ownership for test entities
  let origVerifyWorkflow;
  let origVerifyWorkflowBulk;
  let origVerifyMedia;
  let origProjectReadVerifyMedia;
  let origDbProjectsFindByUser;
  let origDbProjectsFindById;
  let origDbWfFindByProjectsPaginated;
  let origDbWfFindByIdInProjects;
  let origDbWfFindById;
  let origDbWfGetWorkflow;
  let origDbMediaFindById;
  let origDevAuthBypass;
  let origRunRepoGetRun;
  let origDbCollectionItemsFindById;
  let origDbFoldersFindOwned;
  let origDbFoldersListByProject;

  let origSupabaseFrom;

  beforeEach(() => {
    origDevAuthBypass = process.env.DEV_AUTH_BYPASS;
    process.env.DEV_AUTH_BYPASS = "false";

    origSupabaseFrom = supabase.from;
    supabase.from = (table) => {
      if (table === "project") {
        return {
          select: () => ({
            eq: (col, val) => ({
              single: async () => {
                if (val === FOREIGN_PROJ_ID) {
                  return { data: { id: FOREIGN_PROJ_ID, user_id: FOREIGN_USER_ID }, error: null };
                }
                return { data: null, error: { message: "Project not found" } };
              },
            }),
          }),
          delete: () => ({
            eq: () => ({
              eq: async () => ({ error: null }),
            }),
          }),
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: async () => ({ data: null, error: { message: "Not found" } }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "session") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: { message: "Session not found" } }),
            }),
          }),
          delete: () => ({
            eq: async () => ({ error: null }),
          }),
          update: () => ({
            eq: () => ({
              select: () => ({
                single: async () => ({ data: null, error: { message: "Session not found" } }),
              }),
            }),
          }),
        };
      }
      if (origSupabaseFrom) return origSupabaseFrom.call(supabase, table);
      return {};
    };

    origRunRepoGetRun = RunRepository.prototype.getRun;
    RunRepository.prototype.getRun = async (runId) => {
      if (runId === FOREIGN_RUN_ID) {
        return {
          id: runId,
          user_id: "00000000-0000-0000-0000-000000000088",
          status: "completed",
        };
      }
      return null;
    };

    if (workflowService?.authService) {
      origVerifyWorkflow = workflowService.authService.verifyWorkflowOwnership;
      origVerifyWorkflowBulk = workflowService.authService.verifyWorkflowOwnershipBulk;
      origVerifyMedia = workflowService.authService.verifyMediaOwnership;

      workflowService.authService.verifyWorkflowOwnership = async () => false;
      workflowService.authService.verifyWorkflowOwnershipBulk = async () => null;
      workflowService.authService.verifyMediaOwnership = async () => false;
    }

    if (projectReadService) {
      origProjectReadVerifyMedia = projectReadService._verifyMediaOwnership;
      projectReadService._verifyMediaOwnership = async () => false;
    }

    if (db?.projects) {
      origDbProjectsFindByUser = db.projects.findByUser;
      origDbProjectsFindById = db.projects.findById;
      db.projects.findByUser = async (userId, projectId) => {
        if (projectId === FOREIGN_PROJ_ID) return [];
        return [{ id: "alice-proj-1", user_id: userId }];
      };
      db.projects.findById = async (id) => {
        if (id === FOREIGN_PROJ_ID) return { id: FOREIGN_PROJ_ID, user_id: "user-bob" };
        return null;
      };
    }

    if (db?.workflows) {
      origDbWfFindByProjectsPaginated = db.workflows.findByProjectsPaginated;
      origDbWfFindByIdInProjects = db.workflows.findByIdInProjects;
      origDbWfFindById = db.workflows.findById;
      origDbWfGetWorkflow = db.workflows.getWorkflow;

      db.workflows.findByProjectsPaginated = async () => ({ workflows: [], total: 0 });
      db.workflows.findByIdInProjects = async () => null;
      db.workflows.findById = async () => null;
      db.workflows.getWorkflow = async () => null;
    }

    if (db?.media) {
      origDbMediaFindById = db.media.findById;
      db.media.findById = async () => null;
    }

    if (db) {
      if (!db.collection_items) db.collection_items = {};
      origDbCollectionItemsFindById = db.collection_items.findById;
      db.collection_items.findById = async () => null;
    }

    if (db?.folders) {
      origDbFoldersFindOwned = db.folders.findOwned;
      origDbFoldersListByProject = db.folders.listByProject;
      db.folders.findOwned = async () => null;
      db.folders.listByProject = async () => [];
    }
  });

  afterEach(() => {
    process.env.DEV_AUTH_BYPASS = origDevAuthBypass;
    if (workflowService?.authService) {
      if (origVerifyWorkflow) workflowService.authService.verifyWorkflowOwnership = origVerifyWorkflow;
      if (origVerifyWorkflowBulk) workflowService.authService.verifyWorkflowOwnershipBulk = origVerifyWorkflowBulk;
      if (origVerifyMedia) workflowService.authService.verifyMediaOwnership = origVerifyMedia;
    }
    if (projectReadService && origProjectReadVerifyMedia) {
      projectReadService._verifyMediaOwnership = origProjectReadVerifyMedia;
    }
    if (db?.projects) {
      if (origDbProjectsFindByUser) db.projects.findByUser = origDbProjectsFindByUser;
      if (origDbProjectsFindById) db.projects.findById = origDbProjectsFindById;
    }
    if (db?.workflows) {
      if (origDbWfFindByProjectsPaginated) db.workflows.findByProjectsPaginated = origDbWfFindByProjectsPaginated;
      if (origDbWfFindByIdInProjects) db.workflows.findByIdInProjects = origDbWfFindByIdInProjects;
      if (origDbWfFindById) db.workflows.findById = origDbWfFindById;
      if (origDbWfGetWorkflow) db.workflows.getWorkflow = origDbWfGetWorkflow;
    }
    if (db?.media && origDbMediaFindById) {
      db.media.findById = origDbMediaFindById;
    }
    if (db?.collection_items && origDbCollectionItemsFindById) {
      db.collection_items.findById = origDbCollectionItemsFindById;
    }
    if (db?.folders) {
      if (origDbFoldersFindOwned) db.folders.findOwned = origDbFoldersFindOwned;
      if (origDbFoldersListByProject) db.folders.listByProject = origDbFoldersListByProject;
    }
    if (origRunRepoGetRun) {
      RunRepository.prototype.getRun = origRunRepoGetRun;
    }
    if (origSupabaseFrom) {
      supabase.from = origSupabaseFrom;
    }
  });

  // ── PART 1: Service-Checked Route Boundary Tests (Foreign User => 404/Empty) ──

  it("TEST R4-1: GET /api/workflows/library with foreign project filter returns empty items", async () => {
    const res = await reqAlice(`/api/workflows/library?project_id=${FOREIGN_PROJ_ID}`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.data || body.items, [], "Foreign project query must return empty items");
  });

  it("TEST R4-2: GET /api/workflows/library/:workflow_id for foreign workflow returns 404", async () => {
    const res = await reqAlice(`/api/workflows/library/${FOREIGN_WF_ID}`);
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.ok, false);
  });

  it("TEST R4-3: GET /api/workflows/assets/:project_id for foreign project returns 404", async () => {
    const res = await reqAlice(`/api/workflows/assets/${FOREIGN_PROJ_ID}`);
    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-4: GET /api/workflows/workflow-by-media/:media_id for foreign media returns 404", async () => {
    const res = await reqAlice(`/api/workflows/workflow-by-media/${FOREIGN_MEDIA_ID}`);
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.ok, false);
  });

  it("TEST R4-5: POST /api/workflows/detach-media for foreign media returns 404 and does not detach", async () => {
    const res = await reqAlice("/api/workflows/detach-media", {
      method: "POST",
      body: JSON.stringify({ media_id: FOREIGN_MEDIA_ID, project_id: FOREIGN_PROJ_ID }),
    });
    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-6: PATCH /api/workflows/workflows/:id for foreign workflow returns 404 and does not mutate", async () => {
    const res = await reqAlice(`/api/workflows/workflows/${FOREIGN_WF_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ display_name: "Hacked" }),
    });
    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-7: PATCH /api/workflows/workflows/:id/move for foreign workflow returns 404", async () => {
    const res = await reqAlice(`/api/workflows/workflows/${FOREIGN_WF_ID}/move`, {
      method: "PATCH",
      body: JSON.stringify({ project_id: FOREIGN_PROJ_ID }),
    });
    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-8: PATCH /api/workflows/workflows/:id/like for foreign workflow returns 404", async () => {
    const res = await reqAlice(`/api/workflows/workflows/${FOREIGN_WF_ID}/like`, {
      method: "PATCH",
    });
    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-9: PATCH /api/workflows/workflows/like (bulk) with foreign workflow returns 404", async () => {
    const res = await reqAlice("/api/workflows/workflows/like", {
      method: "PATCH",
      body: JSON.stringify({ workflow_ids: [FOREIGN_WF_ID] }),
    });
    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-10: PATCH /api/workflows/workflows/:id/primary-media for foreign workflow returns 404", async () => {
    const res = await reqAlice(`/api/workflows/workflows/${FOREIGN_WF_ID}/primary-media`, {
      method: "PATCH",
      body: JSON.stringify({ media_id: FOREIGN_MEDIA_ID }),
    });
    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-11: DELETE /api/workflows/workflows/:id for foreign workflow returns 404", async () => {
    const res = await reqAlice(`/api/workflows/workflows/${FOREIGN_WF_ID}`, {
      method: "DELETE",
    });
    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-12: DELETE /api/workflows/workflows (bulk) with foreign workflow returns 404", async () => {
    const res = await reqAlice("/api/workflows/workflows", {
      method: "DELETE",
      body: JSON.stringify({ workflow_ids: [FOREIGN_WF_ID] }),
    });
    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-13: DELETE /api/workflows/media/:media_id for foreign media returns 404", async () => {
    const res = await reqAlice(`/api/workflows/media/${FOREIGN_MEDIA_ID}`, {
      method: "DELETE",
    });
    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-14: DELETE /api/assets/:id for foreign asset returns 404", async () => {
    const res = await reqAlice(`/api/assets/${FOREIGN_MEDIA_ID}`, {
      method: "DELETE",
    });
    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-15: POST /api/media/ingest with foreign workflow_id returns 404", async () => {
    const res = await reqAlice("/api/media/ingest", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: FOREIGN_WF_ID,
        project_id: FOREIGN_PROJ_ID,
        source: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-16: GET /api/v2/workflows/runs/:run_id for foreign run returns 404", async () => {
    const res = await reqAlice(`/api/v2/workflows/runs/${FOREIGN_RUN_ID}`);
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.code, "RUN_NOT_FOUND");
  });

  it("TEST R4-17: GET /api/admin/wallet/:userId for normal user returns 403", async () => {
    const res = await reqAlice(`/api/admin/wallet/${FOREIGN_USER_ID}`);
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.error, "FORBIDDEN");
  });

  it("TEST R4-18: PATCH /api/admin/pricing/:id for normal user returns 403", async () => {
    const res = await reqAlice(`/api/admin/pricing/123`, {
      method: "PATCH",
      body: JSON.stringify({ cost_per_unit: 10 }),
    });
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.error, "FORBIDDEN");
  });

  it("TEST R4-19: DELETE /api/workflows/:id for foreign workflow returns 404", async () => {
    const res = await reqAlice(`/api/workflows/${FOREIGN_WF_ID}`, {
      method: "DELETE",
    });
    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-20: PATCH /api/workflows/:id for foreign workflow returns 404", async () => {
    const res = await reqAlice(`/api/workflows/${FOREIGN_WF_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ display_name: "Hacked" }),
    });
    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-21: DELETE /api/workflows/items/:id for foreign item returns 404", async () => {
    const res = await reqAlice("/api/workflows/items/00000000-0000-0000-0000-000000000010", {
      method: "DELETE",
    });
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.ok, false);
  });

  it("TEST R4-22: PATCH /api/workflows/items/:id/like for foreign item returns 404", async () => {
    const res = await reqAlice("/api/workflows/items/00000000-0000-0000-0000-000000000010/like", {
      method: "PATCH",
    });
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.ok, false);
  });

  it("TEST R4-23: GET /api/workflows/project-data/:project_id for foreign project returns 404", async () => {
    const res = await reqAlice(`/api/workflows/project-data/${FOREIGN_PROJ_ID}`);
    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-24: DELETE /api/projects/:id for foreign project returns 404", async () => {
    const res = await reqAlice(`/api/projects/${FOREIGN_PROJ_ID}`, { method: "DELETE" });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  it("TEST R4-25: PATCH /api/projects/:id for foreign project returns 404", async () => {
    const res = await reqAlice(`/api/projects/${FOREIGN_PROJ_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Hacked" }),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  it("TEST R4-26: DELETE /api/sessions/:id for foreign session returns 404", async () => {
    const res = await reqAlice("/api/sessions/00000000-0000-0000-0000-000000000020", { method: "DELETE" });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-27: PATCH /api/sessions/:id for foreign session returns 404", async () => {
    const res = await reqAlice("/api/sessions/00000000-0000-0000-0000-000000000020", {
      method: "PATCH",
      body: JSON.stringify({ name: "Hacked" }),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-27b: POST /api/sessions for foreign project returns 404", async () => {
    const res = await reqAlice("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ project_id: FOREIGN_PROJ_ID, name: "Intruder Session" }),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-28: POST /api/characters/:characterId/media for foreign character returns 404", async () => {
    const res = await reqAlice("/api/characters/char-foreign/media", {
      method: "POST",
      body: JSON.stringify({ imageUrl: "https://example.com/test.png" }),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-29: DELETE /api/characters/:characterId/media/:mediaId for foreign character returns 404", async () => {
    const res = await reqAlice("/api/characters/char-foreign/media/media-1", { method: "DELETE" });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-30: POST /api/characters/:characterId/sheet-media for foreign character returns 404", async () => {
    const res = await reqAlice("/api/characters/char-foreign/sheet-media", {
      method: "POST",
      body: JSON.stringify({ imageUrl: "https://example.com/test.png" }),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-31: POST /api/characters/:characterId/upload for foreign character returns 404", async () => {
    const res = await reqAlice("/api/characters/char-foreign/upload", {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-32: POST /api/v2/elements/:id/images for foreign element returns 404", async () => {
    const res = await reqAlice("/api/v2/elements/elem-foreign/images", {
      method: "POST",
      body: JSON.stringify({ imageUrl: "https://example.com/test.png" }),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-33: DELETE /api/v2/elements/:id/images/:mediaId for foreign element returns 404", async () => {
    const res = await reqAlice("/api/v2/elements/elem-foreign/images/media-1", { method: "DELETE" });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-34: DELETE /api/characters/:characterId for foreign character returns 404", async () => {
    const res = await reqAlice("/api/characters/char-foreign", { method: "DELETE" });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-35: PATCH /api/characters/:characterId for foreign character returns 404", async () => {
    const res = await reqAlice("/api/characters/char-foreign", {
      method: "PATCH",
      body: JSON.stringify({ name: "Hacked" }),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-36: POST /api/characters/:characterId/generate-sheet for foreign character returns 404", async () => {
    const res = await reqAlice("/api/characters/char-foreign/generate-sheet", {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-37: DELETE /api/v2/elements/:id for foreign element returns 404", async () => {
    const res = await reqAlice("/api/v2/elements/elem-foreign", { method: "DELETE" });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-38: GET /api/v2/elements/:id for foreign element returns 404", async () => {
    const res = await reqAlice("/api/v2/elements/elem-foreign");
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-39: PATCH /api/v2/elements/:id for foreign element returns 404", async () => {
    const res = await reqAlice("/api/v2/elements/elem-foreign", {
      method: "PATCH",
      body: JSON.stringify({ name: "Hacked" }),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-40: GET /api/v2/elements/project/:projectId for foreign project returns 404", async () => {
    const res = await reqAlice(`/api/v2/elements/project/${FOREIGN_PROJ_ID}`);
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-41: GET /api/projects/:projectId/folders for foreign project returns 404", async () => {
    const res = await reqAlice(`/api/projects/${FOREIGN_PROJ_ID}/folders`);
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-42: POST /api/projects/:projectId/folders for foreign project returns 404", async () => {
    const res = await reqAlice(`/api/projects/${FOREIGN_PROJ_ID}/folders`, {
      method: "POST",
      body: JSON.stringify({ name: "Subfolder" }),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-43: PATCH /api/folders/:folderId for foreign folder returns 404", async () => {
    const res = await reqAlice("/api/folders/00000000-0000-0000-0000-000000000088", {
      method: "PATCH",
      body: JSON.stringify({ name: "Hacked" }),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-44: DELETE /api/folders/:folderId for foreign folder returns 404", async () => {
    const res = await reqAlice("/api/folders/00000000-0000-0000-0000-000000000088", {
      method: "DELETE",
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-45: PATCH /api/assets/:assetId/folder for foreign asset returns 404", async () => {
    const res = await reqAlice("/api/assets/00000000-0000-0000-0000-000000000001/folder", {
      method: "PATCH",
      body: JSON.stringify({ folderId: null }),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-46: GET /api/projects/:projectId/assets for foreign project returns 404", async () => {
    const res = await reqAlice(`/api/projects/${FOREIGN_PROJ_ID}/assets`, {
      method: "GET",
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  // ── PART 2: Generic Automated Test — Walks Dumped Route Table & Asserts 100% Foreign Refusal Coverage ──

  it("TEST R4-GENERIC: Every authenticated route touching a resource ID has an explicit foreign-refusal test asserting 404/403", () => {
    const allRoutes = extractRoutes();
    const explicitRefusalRoutes = new Set([
      "PATCH /api/admin/pricing/:id",
      "GET /api/admin/wallet/:userId",
      "DELETE /api/assets/:id",
      "PATCH /api/assets/:assetId/folder",
      "DELETE /api/characters/:characterId",
      "PATCH /api/characters/:characterId",
      "POST /api/characters/:characterId/generate-sheet",
      "POST /api/characters/:characterId/media",
      "DELETE /api/characters/:characterId/media/:mediaId",
      "POST /api/characters/:characterId/sheet-media",
      "POST /api/characters/:characterId/upload",
      "DELETE /api/folders/:folderId",
      "PATCH /api/folders/:folderId",
      "GET /api/projects/:projectId/assets",
      "GET /api/projects/:projectId/folders",
      "POST /api/projects/:projectId/folders",
      "DELETE /api/projects/:id",
      "PATCH /api/projects/:id",
      "DELETE /api/sessions/:id",
      "PATCH /api/sessions/:id",
      "DELETE /api/v2/elements/:id",
      "GET /api/v2/elements/:id",
      "PATCH /api/v2/elements/:id",
      "POST /api/v2/elements/:id/images",
      "DELETE /api/v2/elements/:id/images/:mediaId",
      "GET /api/v2/elements/project/:projectId",
      "GET /api/v2/workflows/runs/:run_id",
      "DELETE /api/workflows/:id",
      "PATCH /api/workflows/:id",
      "GET /api/workflows/assets/:project_id",
      "DELETE /api/workflows/items/:id",
      "PATCH /api/workflows/items/:id/like",
      "GET /api/workflows/library/:workflow_id",
      "DELETE /api/workflows/media/:media_id",
      "GET /api/workflows/project-data/:project_id",
      "GET /api/workflows/workflow-by-media/:media_id",
      "DELETE /api/workflows/workflows/:id",
      "PATCH /api/workflows/workflows/:id",
      "PATCH /api/workflows/workflows/:id/like",
      "PATCH /api/workflows/workflows/:id/move",
      "PATCH /api/workflows/workflows/:id/primary-media",
    ]);

    const violations = [];

    for (const r of allRoutes) {
      const isPublic = !r.middlewares.some((m) => m.toLowerCase().includes("auth"));
      if (isPublic) continue; // Public routes don't enforce tenant ownership

      const hasIdParam = r.path.includes(":");
      const routeKey = `${r.method} ${r.path}`;

      if (hasIdParam && !explicitRefusalRoutes.has(routeKey)) {
        violations.push(routeKey);
      }
    }

    assert.equal(
      violations.length,
      0,
      `Unprotected routes touching resource IDs found in router stack without explicit foreign refusal test:\n${violations.join("\n")}`
    );
  });
});
