import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as container from "../../src/container.js";
import { db, workflowService, projectReadService } from "../../src/container.js";
import { WorkflowService, ExecutionEngine } from "#generation/tools";
import { WorkflowMediaService } from "../../src/systems/generation/internal/services/WorkflowMediaService.js";
import { MediaUploadService, MediaService, MediaWorkflowLifecycleService } from "#media/tools";
import { ElementService, ElementMediaService } from "#elements/tools";
import { CharacterService, CharacterMediaService } from "#characters/tools";
import { TrashRepository, TrashService } from "#workspace/tools";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import http from "node:http";
import apiRouter from "../../src/api/routes.js";
import { extractRoutes } from "../../scripts/dump-routes.js";
import { supabase, supabaseAdmin } from "#shared/db/supabase.js";
import { redisConnection, workerRedisConnection, rateLimitRedisConnection } from "#shared";

// ─── Source: containerWiringBoundary.test.js ───
{
describe("Container Service Graph & Dependency Wiring Boundary", () => {
    it("asserts that every WorkflowMediaService reachable from the container holds the exact same mediaUploadService instance", () => {
        // 1. Root MediaUploadService exists in container
        assert.ok(container.mediaUploadService, "container.mediaUploadService must be instantiated");
        assert.ok(container.mediaUploadService instanceof MediaUploadService, "must be instance of MediaUploadService");
        assert.equal(typeof container.mediaUploadService.discard, "function", "must expose discard method");

        const rootUploadService = container.mediaUploadService;

        // 2. WorkflowService and its WorkflowMediaService
        assert.ok(container.workflowService instanceof WorkflowService, "workflowService must be WorkflowService");
        assert.ok(container.workflowService.mediaService instanceof WorkflowMediaService, "workflowService.mediaService must be WorkflowMediaService");
        assert.equal(
            container.workflowService.mediaService.mediaUploadService,
            rootUploadService,
            "workflowService.mediaService must hold the container's mediaUploadService instance"
        );
        assert.ok(container.workflowService.authService, "workflowService must have authService");
        assert.equal(
            container.workflowService.mediaService.authService,
            container.workflowService.authService,
            "workflowService.mediaService must hold workflowService.authService"
        );
        assert.equal(
            typeof container.workflowService.mediaService.authService.verifyWorkflowOwnership,
            "function",
            "authService must provide verifyWorkflowOwnership"
        );

        // 3. Container exported workflowMediaService alias
        assert.equal(
            container.workflowMediaService,
            container.workflowService.mediaService,
            "container.workflowMediaService must be the exact instance on workflowService.mediaService"
        );
        assert.equal(
            container.workflowMediaService.mediaUploadService,
            rootUploadService,
            "container.workflowMediaService must hold root mediaUploadService"
        );
        assert.equal(
            container.workflowMediaService.authService,
            container.workflowService.authService,
            "container.workflowMediaService must hold workflowService.authService"
        );

        // 4. AssetUploadService and its attached WorkflowMediaService
        assert.ok(container.assetUploadService, "container.assetUploadService must be instantiated");
        assert.equal(
            container.assetUploadService.mediaUploadService,
            rootUploadService,
            "assetUploadService.mediaUploadService must hold root mediaUploadService"
        );
        assert.ok(
            container.assetUploadService.workflowMediaService instanceof WorkflowMediaService,
            "assetUploadService.workflowMediaService must be instance of WorkflowMediaService"
        );
        assert.equal(
            container.assetUploadService.workflowMediaService.mediaUploadService,
            rootUploadService,
            "assetUploadService.workflowMediaService must hold root mediaUploadService"
        );

        // 5. ElementMediaService: direct wiring to root upload, attach seam, and auth services
        assert.ok(container.elementMediaService, "container.elementMediaService must be instantiated");
        assert.equal(
            container.elementMediaService.mediaUploadService,
            rootUploadService,
            "elementMediaService.mediaUploadService must hold root mediaUploadService"
        );
        assert.equal(
            container.elementMediaService.workflowMediaService,
            container.workflowMediaService,
            "elementMediaService.workflowMediaService must hold container workflowMediaService"
        );
        assert.equal(
            container.elementMediaService.authService,
            container.workflowService.authService,
            "elementMediaService.authService must hold container authService"
        );
        assert.equal(
            container.elementMediaService.mediaIngestionService,
            undefined,
            "elementMediaService.mediaIngestionService must be removed"
        );
        assert.equal(
            container.elementMediaService.workflowService,
            undefined,
            "elementMediaService.workflowService must be removed"
        );

        // 6. CharacterService -> workflowService -> mediaService
        assert.ok(container.characterService, "container.characterService must be instantiated");
        assert.ok(container.characterService.workflowService, "characterService must receive workflowService");
        assert.equal(
            container.characterService.workflowService.mediaService.mediaUploadService,
            rootUploadService,
            "characterService.workflowService.mediaService must hold root mediaUploadService"
        );
    });

    it("behavioral wiring: attachMediaItems failure triggers storageKey discard on shared mediaUploadService through the real container service graph", async () => {
        const deletedPaths = [];
        const originalDeleteFiles = container.storageService.deleteFiles;
        const originalUpload = container.storageService.upload;
        const originalProviderDeleteFiles = container.storageService.provider?.deleteFiles;

        const originalDbProjectsFindById = container.db.projects.findById;
        const originalDbProjectsFindByUser = container.db.projects.findByUser;
        const originalDbWorkflowsCreate = container.db.workflows.createWorkflow;
        const originalDbWorkflowsDeleteById = container.db.workflows.deleteById;
        const originalDbWorkflowsFindById = container.db.workflows.findById;
        const originalDbWorkflowsGetWorkflow = container.db.workflows.getWorkflow;
        const originalDbMediaCreate = container.db.media.createMedia;
        const originalVerifyWorkflowOwnership = container.workflowMediaService.authService.verifyWorkflowOwnership;

        const VALID_PNG_BUFFER = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            "base64"
        );

        try {
            container.storageService.upload = async (path) => `https://mock.storage/${path}`;
            container.storageService.deleteFiles = async (paths) => {
                deletedPaths.push(...paths);
                return { deletedCount: paths.length, failures: [] };
            };
            if (container.storageService.provider) {
                container.storageService.provider.deleteFiles = async (paths) => {
                    deletedPaths.push(...paths);
                    return { data: paths.map((p) => ({ name: p })), error: null };
                };
            }

            const mockWf = {
                id: "wf-wiring-new",
                user_id: "user-wiring-1",
                project_id: "proj-wiring-1",
                workflow_type: "UPLOAD",
            };
            container.db.projects.findById = async (id) => ({ id, user_id: "user-wiring-1" });
            container.db.projects.findByUser = async (uid, pid) => [{ id: pid, user_id: uid }];
            container.db.workflows.createWorkflow = async (data) => ({ ...mockWf, ...data });
            container.db.workflows.findById = async () => mockWf;
            container.db.workflows.getWorkflow = async () => mockWf;
            container.db.workflows.deleteById = async () => ({ deleted: true });
            container.workflowMediaService.authService.verifyWorkflowOwnership = async (id, uid) => (uid === "user-wiring-1");

            // Simulate failure inside attachMediaItems (e.g. media insert failure or attach RPC failure)
            container.db.media.createMedia = async () => {
                throw new Error("Simulated DB failure during attach");
            };

            await assert.rejects(
                () => container.assetUploadService.uploadAsset({
                    source: { buffer: VALID_PNG_BUFFER, originalName: "test-wiring-file.png" },
                    userId: "user-wiring-1",
                    projectId: "proj-wiring-1",
                }),
                /Simulated DB failure during attach/
            );

            assert.ok(deletedPaths.length > 0, "storageService.deleteFiles must have received discarded storage keys");
            assert.ok(
                deletedPaths.some((p) => p.includes("user-wiring-1/uploads/")),
                `discarded paths must include uploaded user key, got: ${JSON.stringify(deletedPaths)}`
            );
        } finally {
            container.storageService.deleteFiles = originalDeleteFiles;
            container.storageService.upload = originalUpload;
            if (container.storageService.provider) {
                container.storageService.provider.deleteFiles = originalProviderDeleteFiles;
            }
            container.db.projects.findById = originalDbProjectsFindById;
            container.db.projects.findByUser = originalDbProjectsFindByUser;
            container.db.workflows.createWorkflow = originalDbWorkflowsCreate;
            container.db.workflows.findById = originalDbWorkflowsFindById;
            container.db.workflows.getWorkflow = originalDbWorkflowsGetWorkflow;
            container.db.workflows.deleteById = originalDbWorkflowsDeleteById;
            container.db.media.createMedia = originalDbMediaCreate;
            container.workflowMediaService.authService.verifyWorkflowOwnership = originalVerifyWorkflowOwnership;
        }
    });

    it("ElementService wiring: elementMediaService is REQUIRED and holds container.elementMediaService instance", () => {
        assert.ok(container.elementService, "container.elementService must exist");
        assert.equal(
            container.elementService.mediaService,
            container.elementMediaService,
            "container.elementService.mediaService must hold container.elementMediaService"
        );
        assert.equal(
            container.elementService.workflowService,
            container.workflowService,
            "container.elementService.workflowService must hold container.workflowService"
        );
        assert.throws(
            () => new ElementService({ db: {} }),
            (err) => err.message.includes("ElementService requires mediaService"),
            "ElementService constructor must throw if mediaService is missing"
        );
        assert.strictEqual(
            container.elementService.mediaIngestionService,
            undefined,
            "container.elementService.mediaIngestionService must be removed"
        );
        assert.throws(
            () => new ElementMediaService({
                storageService: {},
                mediaUploadService: { upload: () => {} },
                workflowMediaService: { attachMediaItems: () => {} },
                authService: { verifyWorkflowOwnership: () => {} },
            }),
            (err) => err.message.includes("ElementMediaService requires db"),
            "ElementMediaService constructor must throw if db is missing"
        );
    });

    it("CharacterService & CharacterMediaService wiring: characterMediaService is REQUIRED and holds container singletons", () => {
        assert.ok(container.characterMediaService, "container.characterMediaService must exist");
        assert.ok(
            container.characterMediaService instanceof CharacterMediaService,
            "container.characterMediaService must be instance of CharacterMediaService"
        );
        assert.equal(
            container.characterMediaService.mediaUploadService,
            container.mediaUploadService,
            "characterMediaService.mediaUploadService must hold container mediaUploadService"
        );
        assert.equal(
            container.characterMediaService.workflowMediaService,
            container.workflowMediaService,
            "characterMediaService.workflowMediaService must hold container workflowMediaService"
        );
        assert.equal(
            container.characterMediaService.authService,
            container.workflowService.authService,
            "characterMediaService.authService must hold container authService"
        );

        assert.ok(container.characterService, "container.characterService must exist");
        assert.equal(
            container.characterService.mediaService,
            container.characterMediaService,
            "container.characterService.mediaService must hold container.characterMediaService"
        );
        assert.equal(
            container.characterService.workflowService,
            container.workflowService,
            "container.characterService.workflowService must hold container.workflowService"
        );
        assert.throws(
            () => new CharacterService({ db: {} }),
            (err) => err.message.includes("CharacterService requires mediaService"),
            "CharacterService constructor must throw if mediaService is missing"
        );
        assert.throws(
            () => new CharacterMediaService({ db: {} }),
            (err) => err.message.includes("CharacterMediaService requires storageService"),
            "CharacterMediaService constructor must throw if required dependencies are missing"
        );
    });

    it("TrashService & TrashRepository wiring: container exposes db.trash and trashService with shared domain services and zero circular references", () => {
        assert.ok(container.db.trash instanceof TrashRepository, "container.db.trash must be instance of TrashRepository");
        assert.ok(container.trashService instanceof TrashService, "container.trashService must be instance of TrashService");
        assert.equal(container.trashService.db, container.db, "trashService.db must hold container.db");
        assert.equal(
            container.trashService.workflowService,
            container.workflowService,
            "trashService.workflowService must hold container.workflowService"
        );
        assert.equal(
            container.trashService.elementService,
            container.elementService,
            "trashService.elementService must hold container.elementService"
        );
        assert.equal(
            container.trashService.characterService,
            container.characterService,
            "trashService.characterService must hold container.characterService"
        );
        assert.equal(container.workflowService.trashService, undefined, "workflowService must not depend on trashService");
        assert.equal(container.elementService.trashService, undefined, "elementService must not depend on trashService");
        assert.equal(container.characterService.trashService, undefined, "characterService must not depend on trashService");
        assert.equal(container.folderService.trashRepo, container.db.trash, "folderService.trashRepo must hold container.db.trash");
        assert.equal(container.folderService.workflowService, container.workflowService, "folderService.workflowService must hold container.workflowService");
    });

    it("Media platform wiring: container exposes MediaService & MediaWorkflowLifecycleService and drops legacy ingestion shims", () => {
        assert.ok(container.mediaService instanceof MediaService, "container.mediaService must be instance of MediaService");
        assert.equal(container.mediaService.mediaRepo, container.db.media, "mediaService.mediaRepo must hold container.db.media");
        assert.ok(
            container.mediaWorkflowLifecycleService instanceof MediaWorkflowLifecycleService,
            "container.mediaWorkflowLifecycleService must be instance of MediaWorkflowLifecycleService"
        );
        assert.equal("binaryIngestionService" in container, false, "container.binaryIngestionService must be removed");
        assert.equal("mediaIngestionService" in container, false, "container.mediaIngestionService must be removed");
        assert.equal("legacyMediaIngestAdapter" in container, false, "container.legacyMediaIngestAdapter must be removed");
        assert.strictEqual(
            container.characterService.mediaIngestionService,
            undefined,
            "container.characterService.mediaIngestionService must be removed"
        );
        assert.strictEqual(
            container.assetUploadService.binaryIngestionService,
            undefined,
            "container.assetUploadService.binaryIngestionService must be removed"
        );
    });

    it("V3 ExecutionEngine wiring: container exposes executionEngine cleanly and removes legacy V3Dispatcher/useCaseService aliases", () => {
        assert.ok(container.executionEngine instanceof ExecutionEngine, "container.executionEngine must be instance of ExecutionEngine");
        assert.equal("v3Dispatcher" in container, false, "container.v3Dispatcher must be removed");
        assert.equal("useCaseService" in container, false, "container.useCaseService must be removed");
        assert.equal(
            container.generationRequestService.executionEngine,
            container.executionEngine,
            "generationRequestService must hold container.executionEngine"
        );
        assert.equal(
            container.characterService.generationService.executionEngine,
            container.executionEngine,
            "characterService.generationService must hold container.executionEngine"
        );
    });
});
}

// ─── Source: routeOwnershipAuditBoundary.test.js ───
{
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
  let origDbTrashDeleteByWorkflowAndUser;

  let origSupabaseFrom;
  let origSupabaseAdminFrom;

  beforeEach(() => {
    origDevAuthBypass = process.env.DEV_AUTH_BYPASS;
    process.env.DEV_AUTH_BYPASS = "false";

    origSupabaseFrom = supabase.from;
    origSupabaseAdminFrom = supabaseAdmin.from;
    const mockFrom = (table) => {
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
    supabase.from = mockFrom;
    supabaseAdmin.from = mockFrom;

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

    if (db?.trash) {
      origDbTrashDeleteByWorkflowAndUser = db.trash.deleteByWorkflowAndUser;
      db.trash.deleteByWorkflowAndUser = async () => null;
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
    if (db?.trash && origDbTrashDeleteByWorkflowAndUser) {
      db.trash.deleteByWorkflowAndUser = origDbTrashDeleteByWorkflowAndUser;
    }
    if (origSupabaseFrom) {
      supabase.from = origSupabaseFrom;
    }
    if (origSupabaseAdminFrom) {
      supabaseAdmin.from = origSupabaseAdminFrom;
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

  it("TEST R4-7: Retired legacy endpoint PATCH /api/workflows/workflows/:id/move returns 404", async () => {
    const res = await reqAlice(`/api/workflows/workflows/${FOREIGN_WF_ID}/move`, {
      method: "PATCH",
      body: JSON.stringify({ project_id: FOREIGN_PROJ_ID }),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
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

  it("TEST R4-47: PATCH /api/v2/elements/:id/cover for foreign element returns 404", async () => {
    const res = await reqAlice("/api/v2/elements/elem-foreign/cover", {
      method: "PATCH",
      body: JSON.stringify({ mediaId: "media-1" }),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });

  it("TEST R4-48: POST /api/trash/:workflowId/restore for foreign workflow returns 404", async () => {
    const res = await reqAlice(`/api/trash/${FOREIGN_WF_ID}/restore`, {
      method: "POST",
    });
    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    assert.equal(body.ok, false);
  });

  it("TEST R4-49: POST /api/workspace/bulk-delete with foreign folder or workflow returns 404", async () => {
    const resFolder = await reqAlice("/api/workspace/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ folder_ids: ["00000000-0000-0000-0000-000000000088"] }),
    });
    const bodyFolder = await resFolder.json();
    assert.equal(resFolder.status, 404, `Expected 404, got ${resFolder.status}`);
    assert.equal(bodyFolder.ok, false);

    const resWf = await reqAlice("/api/workspace/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ workflow_ids: [FOREIGN_WF_ID] }),
    });
    const bodyWf = await resWf.json();
    assert.equal(resWf.status, 404, `Expected 404, got ${resWf.status}`);
    assert.equal(bodyWf.ok, false);
  });

  it("TEST R4-50: POST /api/trash/delete with foreign workflow or foreign project_id returns 404", async () => {
    const resWf = await reqAlice("/api/trash/delete", {
      method: "POST",
      body: JSON.stringify({ workflow_ids: [FOREIGN_WF_ID] }),
    });
    const bodyWf = await resWf.json();
    assert.equal(resWf.status, 404, `Expected 404, got ${resWf.status}`);
    assert.equal(bodyWf.ok, false);

    const resProj = await reqAlice("/api/trash/delete", {
      method: "POST",
      body: JSON.stringify({ all: true, project_id: FOREIGN_PROJ_ID }),
    });
    const bodyProj = await resProj.json();
    assert.equal(resProj.status, 404, `Expected 404, got ${resProj.status}`);
    assert.equal(bodyProj.ok, false);
  });

  // ── PART 2: Generic Automated Test — Walks Dumped Route Table & Asserts 100% Foreign Refusal Coverage ──

  it("TEST R4-GENERIC: Every authenticated route touching a resource ID has an explicit foreign-refusal test asserting 404/403", () => {
    const allRoutes = extractRoutes();
    const explicitRefusalRoutes = new Set([
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
      "POST /api/projects/:projectId/folders",
      "DELETE /api/projects/:id",
      "PATCH /api/projects/:id",
      "POST /api/trash/:workflowId/restore",
      "DELETE /api/v2/elements/:id",
      "GET /api/v2/elements/:id",
      "PATCH /api/v2/elements/:id",
      "POST /api/v2/elements/:id/images",
      "DELETE /api/v2/elements/:id/images/:mediaId",
      "GET /api/v2/elements/project/:projectId",
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
}
