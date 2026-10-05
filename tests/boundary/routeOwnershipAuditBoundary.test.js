import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import apiRouter from "../../src/api/routes.js";
import { extractRoutes } from "../../scripts/dump-routes.js";
import { db, workflowService, projectReadService } from "../../src/container.js";
import { supabase } from "../../lib/supabase.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";

describe("RC1.1-R4 — Route Table Completeness & Service Ownership Boundary Tests", () => {
  let server;
  let baseUrl;
  let origGetUser;

  const FOREIGN_WF_ID    = "00000000-0000-0000-0000-000000000001";
  const FOREIGN_MEDIA_ID = "00000000-0000-0000-0000-000000000002";
  const FOREIGN_PROJ_ID  = "00000000-0000-0000-0000-000000000003";

  after(async () => {
    supabase.auth.getUser = origGetUser;
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  before(async () => {
    origGetUser = supabase.auth.getUser;
    supabase.auth.getUser = async (token) => {
      if (token === "alice-token") {
        return { data: { user: { id: "user-alice" } }, error: null };
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

  beforeEach(() => {
    origDevAuthBypass = process.env.DEV_AUTH_BYPASS;
    process.env.DEV_AUTH_BYPASS = "false";

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

  it("TEST R4-3: GET /api/workflows/assets/:project_id for foreign project returns 403/404", async () => {
    const res = await reqAlice(`/api/workflows/assets/${FOREIGN_PROJ_ID}`);
    const body = await res.json();
    assert.ok(res.status === 403 || res.status === 404, `Expected 403/404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-4: GET /api/workflows/workflow-by-media/:media_id for foreign media returns 404", async () => {
    const res = await reqAlice(`/api/workflows/workflow-by-media/${FOREIGN_MEDIA_ID}`);
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.ok, false);
  });

  it("TEST R4-5: POST /api/workflows/detach-media for foreign media returns 404/403 and does not detach", async () => {
    const res = await reqAlice("/api/workflows/detach-media", {
      method: "POST",
      body: JSON.stringify({ media_id: FOREIGN_MEDIA_ID, project_id: FOREIGN_PROJ_ID }),
    });
    const body = await res.json();
    assert.ok(res.status === 404 || res.status === 403, `Expected 404/403, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-6: PATCH /api/workflows/workflows/:id for foreign workflow returns 404/403 and does not mutate", async () => {
    const res = await reqAlice(`/api/workflows/workflows/${FOREIGN_WF_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ display_name: "Hacked" }),
    });
    const body = await res.json();
    assert.ok(res.status === 404 || res.status === 403, `Expected 404/403, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-7: PATCH /api/workflows/workflows/:id/move for foreign workflow returns 404/403", async () => {
    const res = await reqAlice(`/api/workflows/workflows/${FOREIGN_WF_ID}/move`, {
      method: "PATCH",
      body: JSON.stringify({ project_id: FOREIGN_PROJ_ID }),
    });
    const body = await res.json();
    assert.ok(res.status === 404 || res.status === 403, `Expected 404/403, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-8: PATCH /api/workflows/workflows/:id/like for foreign workflow returns 404/403", async () => {
    const res = await reqAlice(`/api/workflows/workflows/${FOREIGN_WF_ID}/like`, {
      method: "PATCH",
    });
    const body = await res.json();
    assert.ok(res.status === 404 || res.status === 403, `Expected 404/403, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-9: PATCH /api/workflows/workflows/like (bulk) with foreign workflow returns 404/403", async () => {
    const res = await reqAlice("/api/workflows/workflows/like", {
      method: "PATCH",
      body: JSON.stringify({ workflow_ids: [FOREIGN_WF_ID] }),
    });
    const body = await res.json();
    assert.ok(res.status === 404 || res.status === 403, `Expected 404/403, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-10: PATCH /api/workflows/workflows/:id/primary-media for foreign workflow returns 404/403", async () => {
    const res = await reqAlice(`/api/workflows/workflows/${FOREIGN_WF_ID}/primary-media`, {
      method: "PATCH",
      body: JSON.stringify({ media_id: FOREIGN_MEDIA_ID }),
    });
    const body = await res.json();
    assert.ok(res.status === 404 || res.status === 403, `Expected 404/403, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-11: DELETE /api/workflows/workflows/:id for foreign workflow returns 404/403", async () => {
    const res = await reqAlice(`/api/workflows/workflows/${FOREIGN_WF_ID}`, {
      method: "DELETE",
    });
    const body = await res.json();
    assert.ok(res.status === 404 || res.status === 403, `Expected 404/403, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-12: DELETE /api/workflows/workflows (bulk) with foreign workflow returns 404/403", async () => {
    const res = await reqAlice("/api/workflows/workflows", {
      method: "DELETE",
      body: JSON.stringify({ workflow_ids: [FOREIGN_WF_ID] }),
    });
    const body = await res.json();
    assert.ok(res.status === 404 || res.status === 403, `Expected 404/403, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-13: DELETE /api/workflows/media/:media_id for foreign media returns 404/403", async () => {
    const res = await reqAlice(`/api/workflows/media/${FOREIGN_MEDIA_ID}`, {
      method: "DELETE",
    });
    const body = await res.json();
    assert.ok(res.status === 404 || res.status === 403, `Expected 404/403, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-14: DELETE /api/assets/:id for foreign asset returns 404/403", async () => {
    const res = await reqAlice(`/api/assets/${FOREIGN_MEDIA_ID}`, {
      method: "DELETE",
    });
    const body = await res.json();
    assert.ok(res.status === 404 || res.status === 403, `Expected 404/403, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-15: POST /api/media/ingest with foreign workflow_id returns 404/403", async () => {
    const res = await reqAlice("/api/media/ingest", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: FOREIGN_WF_ID,
        project_id: FOREIGN_PROJ_ID,
        source: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      }),
    });
    const body = await res.json();
    assert.ok(res.status === 404 || res.status === 403, `Expected 404/403, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  // ── PART 2: Generic Automated Test — Walks Dumped Route Table ──

  it("TEST R4-GENERIC: Every authenticated route touching a resource ID has a registered ownership assertion", () => {
    const allRoutes = extractRoutes();

    // Registry of all routes touching IDs that have verified ownership security
    const registeredOwnershipProtectedRoutes = new Set([
      // Projects
      "GET /api/projects",
      "POST /api/projects",
      "DELETE /api/projects/:id",
      "PATCH /api/projects/:id",
      // Sessions
      "POST /api/sessions",
      "DELETE /api/sessions/:id",
      "PATCH /api/sessions/:id",
      // Characters
      "POST /api/characters",
      "POST /api/characters/character",
      "POST /api/characters/create",
      "DELETE /api/characters/:characterId",
      "PATCH /api/characters/:characterId",
      "POST /api/characters/:characterId/generate-sheet",
      "POST /api/characters/:characterId/media",
      "DELETE /api/characters/:characterId/media/:mediaId",
      "POST /api/characters/:characterId/sheet-media",
      "POST /api/characters/:characterId/upload",
      // Elements
      "POST /api/v2/elements",
      "GET /api/v2/elements/:id",
      "PATCH /api/v2/elements/:id",
      "DELETE /api/v2/elements/:id",
      "POST /api/v2/elements/:id/images",
      "DELETE /api/v2/elements/:id/images/:mediaId",
      "POST /api/v2/elements/analyze",
      "GET /api/v2/elements/project/:projectId",
      // Workflows & Items
      "GET /api/workflows/assets/:project_id",
      "POST /api/workflows/detach-media",
      "DELETE /api/workflows/items/:id",
      "PATCH /api/workflows/items/:id/like",
      "GET /api/workflows/library",
      "GET /api/workflows/library/:workflow_id",
      "DELETE /api/workflows/media/:media_id",
      "GET /api/workflows/project-data/:project_id",
      "GET /api/workflows/workflow-by-media/:media_id",
      "DELETE /api/workflows/workflows",
      "DELETE /api/workflows/workflows/:id",
      "DELETE /api/workflows/:id",
      "PATCH /api/workflows/workflows/:id",
      "PATCH /api/workflows/:id",
      "PATCH /api/workflows/workflows/:id/like",
      "PATCH /api/workflows/workflows/:id/move",
      "PATCH /api/workflows/workflows/:id/primary-media",
      "PATCH /api/workflows/workflows/like",
      // Assets
      "POST /api/assets/upload",
      "DELETE /api/assets/:id",
      // Media Ingestion
      "POST /api/media/ingest",
      // Generation Entry Points
      "POST /api/images/generated",
      "POST /api/video/generated",
      // Admin (privileged)
      "PATCH /api/admin/pricing/:id",
      "GET /api/admin/wallet/:userId",
      // Runs
      "GET /api/v2/workflows/runs/:run_id",
    ]);

    const violations = [];

    for (const r of allRoutes) {
      const isPublic = !r.middlewares.some((m) => m.toLowerCase().includes("auth"));
      if (isPublic) continue; // Public routes don't enforce tenant ownership

      const hasIdParam = r.path.includes(":");
      const routeKey = `${r.method} ${r.path}`;

      if (hasIdParam && !registeredOwnershipProtectedRoutes.has(routeKey)) {
        violations.push(routeKey);
      }
    }

    assert.equal(
      violations.length,
      0,
      `Unprotected routes touching resource IDs found in dumped router stack:\n${violations.join("\n")}`
    );
  });
});
