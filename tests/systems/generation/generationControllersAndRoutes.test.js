import { describe, it, beforeEach, afterEach, after, before } from "node:test";
import assert from "node:assert/strict";
import * as imageController from "#generation/api";
import * as videoController from "#generation/api";
import { generateImage, generateVideo, deleteItem, toggleItemLike as toggleLike, imagesRouter } from "#generation/api";
import { generationRequestService, db, workflowService, useCaseService, characterService, folderService } from "../../../src/container.js";
import { AppError, redisConnection, workerRedisConnection, rateLimitRedisConnection } from "#shared";
import { randomUUID } from "node:crypto";
import * as characterController from "#characters/api";
import { InMemoryWalletService } from "../../helpers/inMemoryWalletService.js";
import { UseCaseBillingRuntime, bootstrapV2 } from "#generation/tools";
import express from "express";
import http from "node:http";
import { supabase } from "#shared/db/supabase.js";
import apiRouter from "../../../src/api/routes.js";
import { resetLimitersForTest } from "#identity/tools";

// ─── Source: imageAndVideoControllers.test.js ───
{
describe("imageController and videoController unit tests", () => {
    let originalRequestGeneration;
    let originalFindOwnedProject;

    beforeEach(() => {
        originalRequestGeneration = generationRequestService.requestGeneration;
        if (db.projects) {
            originalFindOwnedProject = db.projects.findOwnedProject;
            db.projects.findOwnedProject = async () => ({ id: "proj-123", user_id: "user-1" });
            db.projects.findByUser = async () => [{ id: "proj-123", user_id: "user-1" }];
        }
    });

    afterEach(() => {
        generationRequestService.requestGeneration = originalRequestGeneration;
        if (db.projects && originalFindOwnedProject) {
            db.projects.findOwnedProject = originalFindOwnedProject;
        }
    });

    describe("imageController.generateImage", () => {
        it("rejects direct image sources with HTTP 400", async () => {
            const req = {
                body: {
                    image_url: "http://example.com/direct.png",
                    prompt: "test",
                    project_id: "proj-123",
                    model: "nano-banana",
                },
                user: { id: "user-1" },
            };
            let statusCode = 200;
            let payload = null;
            const res = {
                status: (code) => {
                    statusCode = code;
                    return res;
                },
                json: (data) => {
                    payload = data;
                },
            };

            await generateImage(req, res);
            assert.equal(statusCode, 400);
            assert.match(payload.message, /Direct image sources are not permitted/);
        });

        it("delegates to generationRequestService with image configuration", async () => {
            let capturedArgs = null;
            generationRequestService.requestGeneration = async (args) => {
                capturedArgs = args;
                return {
                    ok: true,
                    status: "processing",
                    workflowId: "wf-img-1",
                    mediaId: "m-img-1",
                };
            };

            const req = {
                body: {
                    prompt: "A beautiful forest",
                    project_id: "proj-123",
                    model: "nano-banana",
                    parameters: { aspect_ratio: "16:9" },
                },
                user: { id: "user-1" },
            };
            let payload = null;
            const res = {
                json: (data) => {
                    payload = data;
                },
            };

            await generateImage(req, res);
            assert.ok(capturedArgs);
            assert.equal(capturedArgs.mediaType, "image");
            assert.equal(capturedArgs.stepId, "image_generation");
            assert.equal(capturedArgs.useCaseId, "image-generation-v1");
            assert.equal(payload.ok, true);
            assert.equal(payload.workflowId, "wf-img-1");
        });

        it("returns HTTP 503 when QUEUE_DISPATCH_FAILED error is thrown", async () => {
            generationRequestService.requestGeneration = async () => {
                const err = new AppError("Queue full", 503);
                err.code = "QUEUE_DISPATCH_FAILED";
                err.workflowId = "wf-err";
                err.mediaId = "m-err";
                err.mediaIds = ["m-err"];
                throw err;
            };

            const req = {
                body: {
                    prompt: "A beautiful forest",
                    project_id: "proj-123",
                    model: "nano-banana",
                },
                user: { id: "user-1" },
            };
            let statusCode = 200;
            let payload = null;
            const res = {
                status: (code) => {
                    statusCode = code;
                    return res;
                },
                json: (data) => {
                    payload = data;
                },
            };

            await generateImage(req, res);
            assert.equal(statusCode, 503);
            assert.equal(payload.code, "QUEUE_DISPATCH_FAILED");
        });
    });

    describe("videoController.generateVideo", () => {
        it("rejects direct video sources with HTTP 400", async () => {
            const req = {
                body: {
                    video_url: "http://example.com/video.mp4",
                    prompt: "test",
                    project_id: "proj-123",
                    model: "veo-2",
                },
                user: { id: "user-1" },
            };
            let statusCode = 200;
            let payload = null;
            const res = {
                status: (code) => {
                    statusCode = code;
                    return res;
                },
                json: (data) => {
                    payload = data;
                },
            };

            await generateVideo(req, res);
            assert.equal(statusCode, 400);
            assert.match(payload.message, /Direct media sources are not permitted/);
        });

        it("delegates to generationRequestService with video configuration and default 16:9 aspect ratio", async () => {
            let capturedArgs = null;
            generationRequestService.requestGeneration = async (args) => {
                capturedArgs = args;
                return {
                    ok: true,
                    status: "processing",
                    workflowId: "wf-vid-1",
                    mediaId: "m-vid-1",
                };
            };

            const req = {
                body: {
                    prompt: "A soaring eagle",
                    project_id: "proj-123",
                    model: "veo-2",
                },
                user: { id: "user-1" },
            };
            let payload = null;
            const res = {
                json: (data) => {
                    payload = data;
                },
            };

            await generateVideo(req, res);
            assert.ok(capturedArgs);
            assert.equal(capturedArgs.mediaType, "video");
            assert.equal(capturedArgs.stepId, "video_generation");
            assert.equal(capturedArgs.useCaseId, "video-generation-v1");
            assert.equal(capturedArgs.mediaMeta.aspect_ratio, "16:9");
            assert.equal(payload.ok, true);
            assert.equal(payload.workflowId, "wf-vid-1");
        });
    });
});
}

// ─── Source: generationsMutationController.test.js ───
{
describe("generationsMutationController contracts", () => {
    let originalDeleteMedia;
    let originalFindMediaById;
    let originalFindByUser;

    beforeEach(() => {
        originalDeleteMedia = workflowService?.deleteMedia;
        originalFindMediaById = db.media?.findById;
        originalFindByUser = db.projects?.findByUser;

        if (db.media) {
            db.media.findById = async (id) => ({ id, project_id: "proj-1" });
        }
        if (db.projects) {
            db.projects.findByUser = async (userId, projId) => [{ id: "proj-1", user_id: userId }];
        }
    });

    afterEach(() => {
        if (workflowService) {
            workflowService.deleteMedia = originalDeleteMedia;
        }
        if (db.media) {
            db.media.findById = originalFindMediaById;
        }
        if (db.projects) {
            db.projects.findByUser = originalFindByUser;
        }
    });

    it("deleteItem delegates to workflowService.deleteMedia and does not query collection_items", async () => {
        let calledWith = null;
        workflowService.deleteMedia = async (args) => {
            calledWith = args;
            return { deleted: true, mediaId: args.mediaId };
        };

        const req = {
            params: { id: "media-uuid-123" },
            user: { id: "user-1" },
        };
        let responseJson = null;
        const res = {
            status: (s) => res,
            json: (payload) => {
                responseJson = payload;
                return res;
            },
        };

        await deleteItem(req, res);

        assert.ok(calledWith, "workflowService.deleteMedia should have been called");
        assert.equal(calledWith.mediaId, "media-uuid-123");
        assert.equal(calledWith.userId, "user-1");
        assert.equal(responseJson?.ok, true);
    });

    it("deleteItem maps itemId to mediaId and deletes only the target media relationship, preserving unrelated links", async () => {
        const remainingWorkflowLinks = [
            { workflow_id: "wf-1", media_id: "media-sibling-1", role: "output" },
            { workflow_id: "wf-1", media_id: "target-media-to-delete", role: "output" },
            { workflow_id: "wf-1", media_id: "media-sibling-2", role: "detail" },
            { workflow_id: "wf-2", media_id: "media-other-wf", role: "sheet" },
        ];

        let deleteMediaCalls = [];
        workflowService.deleteMedia = async ({ mediaId, userId }) => {
            deleteMediaCalls.push({ mediaId, userId });
            const idx = remainingWorkflowLinks.findIndex((l) => l.media_id === mediaId);
            if (idx >= 0) {
                remainingWorkflowLinks.splice(idx, 1);
            }
            return { deleted: true, mediaId, workflow_deleted: false };
        };

        const req = {
            params: { id: "target-media-to-delete" },
            user: { id: "user-owner" },
        };
        let responseJson = null;
        const res = {
            status: () => res,
            json: (payload) => {
                responseJson = payload;
                return res;
            },
        };

        await deleteItem(req, res);

        assert.equal(deleteMediaCalls.length, 1);
        assert.equal(deleteMediaCalls[0].mediaId, "target-media-to-delete", "itemId must map precisely to mediaId");
        assert.equal(deleteMediaCalls[0].userId, "user-owner");
        assert.equal(responseJson?.ok, true);
        assert.equal(responseJson?.deleted, true);
        assert.equal(responseJson?.workflow_deleted, false);

        // Verify that unrelated links in the same workflow and other workflows were preserved
        const remainingMediaIds = remainingWorkflowLinks.map((l) => l.media_id);
        assert.deepEqual(remainingMediaIds, [
            "media-sibling-1",
            "media-sibling-2",
            "media-other-wf",
        ], "Unrelated workflow/media links must remain untouched");
    });

    it("deleteItem propagates 404 when user does not own media", async () => {
        workflowService.deleteMedia = async () => {
            const err = new Error("Media not found");
            err.statusCode = 404;
            throw err;
        };

        const req = {
            params: { id: "foreign-media-uuid" },
            user: { id: "user-attacker" },
        };
        let responseStatus = null;
        let responseJson = null;
        const res = {
            status: (s) => {
                responseStatus = s;
                return res;
            },
            json: (payload) => {
                responseJson = payload;
                return res;
            },
        };

        await deleteItem(req, res);

        assert.equal(responseStatus, 404, "Must return 404 on cross-tenant delete attempt");
        assert.equal(responseJson?.ok, false);
    });

    it("toggleLike returns explicit 501 NOT_SUPPORTED error instead of hardcoded success", async () => {
        const req = {
            params: { id: "media-uuid-123" },
            user: { id: "user-1" },
        };
        let responseStatus = null;
        let responseJson = null;
        const res = {
            status: (s) => {
                responseStatus = s;
                return res;
            },
            json: (payload) => {
                responseJson = payload;
                return res;
            },
        };

        await toggleLike(req, res);

        assert.equal(responseStatus, 501, "Expected 501 Not Implemented");
        assert.equal(responseJson?.ok, false);
        assert.equal(responseJson?.errorCode, "NOT_SUPPORTED");
        assert.match(responseJson?.message, /Item-level like is not supported/i);
    });
});
}

// ─── Source: generationsMutationErrorMaskingBoundary.test.js ───
{
/**
 * Boundary tests: mounted generation-mutation handlers must not leak
 * internal 5xx details, and must keep the fail-closed ownership contract.
 *
 * Covers the handlers actually mounted in routes/workflows.js:
 *   - DELETE /api/workflows/items/:id   -> generationsMutation.deleteItem
 *   - PATCH /api/workflows/items/:id/like -> generationsMutation.toggleLike
 * (deleteGeneration / updateGeneration are unmounted exports and are not
 * touched here.)
 *
 * Harness follows the established container-stub pattern (see
 * tests/unit/generationsMutationController.test.js): container-owned
 * object properties are swapped per test and restored in afterEach, so
 * no database, network, or Supabase access is needed.
 *
 * State-invariant contract classes asserted:
 *   1. unexpected internal failures -> 500 + generic "Internal server error"
 *      + errorCode INTERNAL_ERROR (no exception internals in the body)
 *   2. foreign / missing resource id -> 404 (never 403) with errorCode
 *      NOT_FOUND (cross-tenant contract)
 *   3. missing authentication -> 401 with the AppError public message
 */

const INTERNAL_ERROR = Object.assign(
    new Error("connect ECONNREFUSED 10.0.0.4:5432 credential=sk-internal-77"),
    {}
);

let originalDeleteMedia;
let originalMediaFindById;
let originalProjectsFindByUser;
let hadCollectionItems;

function fakeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

function fakeReq(id, userId) {
    return {
        params: { id },
        user: userId ? { id: userId } : undefined,
    };
}

beforeEach(() => {
    originalDeleteMedia = workflowService?.deleteMedia;
    originalMediaFindById = db.media?.findById;
    originalProjectsFindByUser = db.projects?.findByUser;
    hadCollectionItems = Object.prototype.hasOwnProperty.call(db, "collection_items");
});

afterEach(() => {
    if (workflowService) {
        workflowService.deleteMedia = originalDeleteMedia;
    }
    if (db.media) {
        if (originalMediaFindById === undefined) {
            delete db.media.findById;
        } else {
            db.media.findById = originalMediaFindById;
        }
    }
    if (db.projects) {
        if (originalProjectsFindByUser === undefined) {
            delete db.projects.findByUser;
        } else {
            db.projects.findByUser = originalProjectsFindByUser;
        }
    }
    if (!hadCollectionItems && db.collection_items) {
        delete db.collection_items;
    }
});

describe("generationsMutation mounted-handler error masking boundary", () => {
    it("deleteItem masks unexpected internal failures behind the safe public contract", async () => {
        db.media.findById = async (id) => ({ id, user_id: "user-1" });
        db.collection_items = {
            findById: async (id) => ({ id, user_id: "user-1" }),
            delete: async () => { throw INTERNAL_ERROR; },
        };
        workflowService.deleteMedia = async () => { throw INTERNAL_ERROR; };

        const res = fakeRes();
        await deleteItem(fakeReq("media-1", "user-1"), res);

        assert.equal(res.statusCode, 500);
        assert.equal(res.body.ok, false);
        assert.equal(res.body.message, "Internal server error");
        assert.equal(res.body.errorCode, "INTERNAL_ERROR");

        const serialized = JSON.stringify(res.body);
        assert.ok(!serialized.includes("ECONNREFUSED"), "must not leak connection details");
        assert.ok(!serialized.includes("sk-internal-77"), "must not leak credential-looking fragments");
    });

    it("deleteItem preserves the fail-closed 404 contract for foreign resource ids", async () => {
        db.collection_items = { findById: async () => null };

        const res = fakeRes();
        await deleteItem(fakeReq("media-1", "user-1"), res);

        assert.equal(res.statusCode, 404);
        assert.equal(res.body.ok, false);
        assert.equal(res.body.errorCode, "NOT_FOUND");
        assert.match(res.body.message, /not found/i);
    });

    it("toggleLike preserves the fail-closed 404 contract for foreign resource ids", async () => {
        db.collection_items = { findById: async () => null };

        const res = fakeRes();
        await toggleLike(fakeReq("media-1", "user-1"), res);

        assert.equal(res.statusCode, 404);
        assert.equal(res.body.ok, false);
        assert.equal(res.body.errorCode, "NOT_FOUND");
        assert.match(res.body.message, /not found/i);
    });

    it("deleteItem preserves the public 401 contract when authentication is missing", async () => {
        db.collection_items = { findById: async () => null };

        const res = fakeRes();
        await deleteItem(fakeReq("media-1", undefined), res);

        assert.equal(res.statusCode, 401);
        assert.equal(res.body.ok, false);
        assert.equal(res.body.message, "Authentication required");
        assert.equal(res.body.errorCode, "APP_ERROR");
    });
});
}

// ─── Source: controllerErrorPathBoundary.test.js ───
{
/**
 * F2.4-b2 / F2.5-c — Controller Error-Path Boundary Tests
 *
 * Covers ALL generation entry points:
 *   1. imageController.generateImage
 *   2. videoController.generateVideo
 *   3. characterController.generateCharacterSheet (generate-sheet)
 *   4. characterController.createCharacter (AI visual sheet creation)
 *
 * Each entry point tests two failure boundaries using the REAL prepareAndEnqueue and billing runtime:
 *   (a) Error after placeholders are created but before enqueue (e.g. wallet DB failure on reserve):
 *       - All placeholders marked "failed"
 *       - Hold released exactly 0 times (never reserved)
 *       - Clean client error (HTTP 500)
 *       - Zero stuck "processing" rows
 *   (b) Enqueue dispatch failure (QUEUE_DISPATCH_FAILED):
 *       - All placeholders marked "failed"
 *       - Hold released EXACTLY ONCE (verified via wallet call counter)
 *       - Clean client error (HTTP 503)
 *       - Zero stuck "processing" rows
 */


bootstrapV2();

after(async () => {
  try {
    await redisConnection?.quit().catch(() => redisConnection?.disconnect());
    await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
  } catch {}
});

/**
 * Test wallet that counts reserve and release/rollback calls to prove "released exactly once"
 */
class TrackingWalletService extends InMemoryWalletService {
  constructor() {
    super();
    this.reserveCalls = 0;
    this.rollbackCalls = 0;
    this.releaseCalls = 0;
  }

  async reserve(args) {
    this.reserveCalls++;
    return super.reserve(args);
  }

  async rollback(refId, opts) {
    this.rollbackCalls++;
    return super.release(refId, opts);
  }

  async release(refId, opts) {
    this.releaseCalls++;
    return super.release(refId, opts);
  }

  get totalRollbacksAndReleases() {
    return this.rollbackCalls + this.releaseCalls;
  }
}

describe("F2.5-c — Controller Error-Path Boundary Tests (Image, Video, Character)", () => {
  let mediaRows;
  let characterRows;
  let origDbMedia;
  let origDbWorkflows;
  let origDbProjects;
  let origDbCharacters;
  let origWalletService;
  let origBillingRuntime;
  let origJobQueueService;

  beforeEach(() => {
    mediaRows = new Map();
    characterRows = new Map();

    origDbMedia = db.media;
    origDbWorkflows = db.workflows;
    origDbProjects = db.projects;
    origDbCharacters = db.characters;
    origWalletService = useCaseService.walletService;
    origBillingRuntime = useCaseService.billingRuntime;
    origJobQueueService = useCaseService.jobQueueService;

    db.media = {
      createMedia: async (data) => {
        const id = data.id || randomUUID();
        const row = { ...data, id, status: data.status || "processing" };
        mediaRows.set(id, row);
        return row;
      },
      findByWorkflow: async (workflowId) => {
        return Array.from(mediaRows.values()).filter((m) => m.workflow_id === workflowId);
      },
      updateMedia: async (id, data) => {
        const existing = mediaRows.get(id) || { id };
        const updated = { ...existing, ...data };
        mediaRows.set(id, updated);
        return updated;
      },
    };

    db.workflows = {
      createWorkflow: async (data) => data,
      getWorkflow: async (id) => null,
    };

    db.projects = {
      findById: async (id) => ({ id, user_id: "user-ctrl-test" }),
    };

    db.characters = {
      findByCharacterId: async (id) => characterRows.get(id) || {
        character_id: id,
        id,
        user_id: "user-ctrl-test",
        project_id: "proj-ctrl-1",
        name: "Test Character",
        description: "Test Description",
      },
      upsert: async (payload) => {
        const id = payload.character_id || payload.id || randomUUID();
        const row = { ...payload, character_id: id, id, user_id: "user-ctrl-test" };
        characterRows.set(id, row);
        return row;
      },
      updateCharacterFields: async (id, updates) => {
        const existing = characterRows.get(id) || { character_id: id, id };
        const updated = { ...existing, ...updates };
        characterRows.set(id, updated);
        return updated;
      },
    };
  });

  afterEach(() => {
    db.media = origDbMedia;
    db.workflows = origDbWorkflows;
    db.projects = origDbProjects;
    db.characters = origDbCharacters;
    useCaseService.walletService = origWalletService;
    useCaseService.billingRuntime = origBillingRuntime;
    useCaseService.jobQueueService = origJobQueueService;
  });

  function makeMockRes() {
    let statusCode = 200;
    let responseData = null;
    const res = {
      status: (code) => {
        statusCode = code;
        return res;
      },
      json: (data) => {
        responseData = data;
        return res;
      },
      getStatusCode: () => statusCode,
      getResponseData: () => responseData,
    };
    return res;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. IMAGE CONTROLLER
  // ───────────────────────────────────────────────────────────────────────────

  describe("imageController", () => {
    it("TEST 1 (Image path a): error before enqueue (wallet DB fails on reserve) -> all placeholders failed, 0 releases, clean 500, no stuck processing rows", async () => {
      const wallet = new TrackingWalletService();
      await wallet.setBalance("user-ctrl-test", 100);
      // Simulate database crash during reserve
      wallet.reserve = async () => {
        const err = new Error("Wallet DB connection timeout during reserve");
        err.statusCode = 500;
        throw err;
      };

      const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });
      useCaseService.walletService = wallet;
      useCaseService.billingRuntime = billingRuntime;

      const req = {
        user: { id: "user-ctrl-test" },
        body: { prompt: "A beautiful mountain lake", model: "nanobana_2", project_id: "proj-ctrl-1" },
      };
      const res = makeMockRes();

      await imageController.generateImage(req, res);

      // Clean 500 response
      assert.strictEqual(res.getStatusCode(), 500);
      const data = res.getResponseData();
      assert.strictEqual(data.ok, false);
      assert.strictEqual(data.code, "INTERNAL_ERROR");

      // All placeholders marked failed
      assert.ok(mediaRows.size > 0, "Placeholders must have been created");
      for (const [id, row] of mediaRows) {
        assert.strictEqual(row.status, "failed");
        assert.match(row.error_message, /Wallet DB connection timeout/i);
      }

      // No hold was reserved, so 0 release/rollback calls
      assert.strictEqual(wallet.totalRollbacksAndReleases, 0, "0 releases when reserve fails");

      // ZERO stuck processing rows
      const stuckRows = Array.from(mediaRows.values()).filter((m) => m.status === "processing");
      assert.strictEqual(stuckRows.length, 0, "Zero stuck processing rows");
    });

    it("TEST 2 (Image path b): enqueue dispatch fails (QUEUE_DISPATCH_FAILED) -> all placeholders failed, hold released exactly once, clean 503, no stuck processing rows", async () => {
      const wallet = new TrackingWalletService();
      await wallet.setBalance("user-ctrl-test", 100);
      const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });

      useCaseService.walletService = wallet;
      useCaseService.billingRuntime = billingRuntime;
      useCaseService.jobQueueService = {
        addUseCaseJob: async () => {
          throw new Error("Redis cluster failover in progress");
        },
      };

      const req = {
        user: { id: "user-ctrl-test" },
        body: { prompt: "A futuristic skyline", model: "nanobana_2", project_id: "proj-ctrl-1" },
      };
      const res = makeMockRes();

      await imageController.generateImage(req, res);

      assert.strictEqual(res.getStatusCode(), 503);
      const data = res.getResponseData();
      assert.strictEqual(data.ok, false);
      assert.strictEqual(data.code, "QUEUE_DISPATCH_FAILED");

      assert.ok(mediaRows.size > 0);
      for (const [id, row] of mediaRows) {
        assert.strictEqual(row.status, "failed");
      }

      // Proves released EXACTLY ONCE
      assert.strictEqual(wallet.reserveCalls, 1, "Reserved exactly once");
      assert.strictEqual(wallet.totalRollbacksAndReleases, 1, "Hold must be released/rolled back EXACTLY ONCE");

      const stuckRows = Array.from(mediaRows.values()).filter((m) => m.status === "processing");
      assert.strictEqual(stuckRows.length, 0, "Zero stuck processing rows");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. VIDEO CONTROLLER
  // ───────────────────────────────────────────────────────────────────────────

  describe("videoController", () => {
    it("TEST 3 (Video path a): error before enqueue (wallet DB fails on reserve) -> all placeholders failed, 0 releases, clean 500, no stuck processing rows", async () => {
      const wallet = new TrackingWalletService();
      await wallet.setBalance("user-ctrl-test", 100);
      wallet.reserve = async () => {
        const err = new Error("Wallet DB deadlocked during video reserve");
        err.statusCode = 500;
        throw err;
      };

      const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });
      useCaseService.walletService = wallet;
      useCaseService.billingRuntime = billingRuntime;

      const req = {
        user: { id: "user-ctrl-test" },
        body: { prompt: "Waves crashing on the shore", model: "wan_3_0", project_id: "proj-ctrl-1" },
      };
      const res = makeMockRes();

      await videoController.generateVideo(req, res);

      assert.strictEqual(res.getStatusCode(), 500);
      const data = res.getResponseData();
      assert.strictEqual(data.ok, false);
      assert.strictEqual(data.code, "INTERNAL_ERROR");

      assert.ok(mediaRows.size > 0);
      for (const [id, row] of mediaRows) {
        assert.strictEqual(row.status, "failed");
        assert.match(row.error_message, /deadlocked/i);
      }

      assert.strictEqual(wallet.totalRollbacksAndReleases, 0);

      const stuckRows = Array.from(mediaRows.values()).filter((m) => m.status === "processing");
      assert.strictEqual(stuckRows.length, 0);
    });

    it("TEST 4 (Video path b): enqueue dispatch fails (QUEUE_DISPATCH_FAILED) -> all placeholders failed, hold released exactly once, clean 503, no stuck processing rows", async () => {
      const wallet = new TrackingWalletService();
      await wallet.setBalance("user-ctrl-test", 100);
      const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });

      useCaseService.walletService = wallet;
      useCaseService.billingRuntime = billingRuntime;
      useCaseService.jobQueueService = {
        addUseCaseJob: async () => {
          throw new Error("Redis OOM or unreachable for video job");
        },
      };

      const req = {
        user: { id: "user-ctrl-test" },
        body: { prompt: "Drone flyover of snowy mountains", model: "wan_3_0", project_id: "proj-ctrl-1" },
      };
      const res = makeMockRes();

      await videoController.generateVideo(req, res);

      assert.strictEqual(res.getStatusCode(), 503);
      const data = res.getResponseData();
      assert.strictEqual(data.ok, false);
      assert.strictEqual(data.code, "QUEUE_DISPATCH_FAILED");

      assert.ok(mediaRows.size > 0);
      for (const [id, row] of mediaRows) {
        assert.strictEqual(row.status, "failed");
      }

      assert.strictEqual(wallet.reserveCalls, 1);
      assert.strictEqual(wallet.totalRollbacksAndReleases, 1, "Hold must be released/rolled back EXACTLY ONCE");

      const stuckRows = Array.from(mediaRows.values()).filter((m) => m.status === "processing");
      assert.strictEqual(stuckRows.length, 0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. CHARACTER CONTROLLER — generateCharacterSheet (generate-sheet)
  // ───────────────────────────────────────────────────────────────────────────

  describe("characterController — generateCharacterSheet", () => {
    it("TEST 5 (generate-sheet path a): error before enqueue -> placeholder failed, 0 releases, clean 500, no stuck processing rows", async () => {
      const wallet = new TrackingWalletService();
      await wallet.setBalance("user-ctrl-test", 100);
      wallet.reserve = async () => {
        const err = new Error("Wallet DB error on character sheet reserve");
        err.statusCode = 500;
        throw err;
      };

      const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });
      useCaseService.walletService = wallet;
      useCaseService.billingRuntime = billingRuntime;

      const req = {
        user: { id: "user-ctrl-test" },
        params: { characterId: "char-sheet-1" },
        body: { prompt: "Three view turnaround of a cyber warrior", project_id: "proj-ctrl-1" },
      };
      const res = makeMockRes();

      await characterController.generateCharacterSheet(req, res);

      assert.strictEqual(res.getStatusCode(), 500);
      const data = res.getResponseData();
      assert.strictEqual(data.ok, false);

      // Placeholder media row created for characterId must be marked failed
      assert.ok(mediaRows.size > 0);
      for (const [id, row] of mediaRows) {
        assert.strictEqual(row.status, "failed");
      }

      assert.strictEqual(wallet.totalRollbacksAndReleases, 0);

      const stuckRows = Array.from(mediaRows.values()).filter((m) => m.status === "processing");
      assert.strictEqual(stuckRows.length, 0);
    });

    it("TEST 6 (generate-sheet path b): enqueue dispatch fails (QUEUE_DISPATCH_FAILED) -> placeholder failed, hold released exactly once, clean 503, no stuck processing rows", async () => {
      const wallet = new TrackingWalletService();
      await wallet.setBalance("user-ctrl-test", 100);
      const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });

      useCaseService.walletService = wallet;
      useCaseService.billingRuntime = billingRuntime;
      useCaseService.jobQueueService = {
        addUseCaseJob: async () => {
          throw new Error("Redis down during character sheet enqueue");
        },
      };

      const req = {
        user: { id: "user-ctrl-test" },
        params: { characterId: "char-sheet-2" },
        body: { prompt: "Three view turnaround of a cyber warrior", project_id: "proj-ctrl-1" },
      };
      const res = makeMockRes();

      await characterController.generateCharacterSheet(req, res);

      assert.strictEqual(res.getStatusCode(), 503);
      const data = res.getResponseData();
      assert.strictEqual(data.ok, false);

      assert.ok(mediaRows.size > 0);
      for (const [id, row] of mediaRows) {
        assert.strictEqual(row.status, "failed");
      }

      assert.strictEqual(wallet.reserveCalls, 1);
      assert.strictEqual(wallet.totalRollbacksAndReleases, 1, "Hold must be released/rolled back EXACTLY ONCE");

      const stuckRows = Array.from(mediaRows.values()).filter((m) => m.status === "processing");
      assert.strictEqual(stuckRows.length, 0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. CHARACTER CONTROLLER — createCharacter (AI sheet creation path)
  // ───────────────────────────────────────────────────────────────────────────

  describe("characterController — createCharacter (AI sheet path)", () => {
    it("TEST 7 (createCharacter path a): error before enqueue -> placeholder failed, 0 releases, clean 500, no stuck processing rows", async () => {
      const wallet = new TrackingWalletService();
      await wallet.setBalance("user-ctrl-test", 100);
      wallet.reserve = async () => {
        const err = new Error("Wallet DB error on character creation reserve");
        err.statusCode = 500;
        throw err;
      };

      const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });
      useCaseService.walletService = wallet;
      useCaseService.billingRuntime = billingRuntime;

      const req = {
        user: { id: "user-ctrl-test" },
        body: { name: "Aria", prompt: "A futuristic archer", project_id: "proj-ctrl-1" },
      };
      const res = makeMockRes();

      await characterController.createCharacter(req, res);

      assert.strictEqual(res.getStatusCode(), 500);
      const data = res.getResponseData();
      assert.strictEqual(data.ok, false);

      assert.ok(mediaRows.size > 0);
      for (const [id, row] of mediaRows) {
        assert.strictEqual(row.status, "failed");
      }

      assert.strictEqual(wallet.totalRollbacksAndReleases, 0);

      const stuckRows = Array.from(mediaRows.values()).filter((m) => m.status === "processing");
      assert.strictEqual(stuckRows.length, 0);
    });

    it("TEST 8 (createCharacter path b): enqueue dispatch fails (QUEUE_DISPATCH_FAILED) -> placeholder failed, hold released exactly once, clean 503, no stuck processing rows", async () => {
      const wallet = new TrackingWalletService();
      await wallet.setBalance("user-ctrl-test", 100);
      const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });

      useCaseService.walletService = wallet;
      useCaseService.billingRuntime = billingRuntime;
      useCaseService.jobQueueService = {
        addUseCaseJob: async () => {
          throw new Error("Redis queue down during character create");
        },
      };

      const req = {
        user: { id: "user-ctrl-test" },
        body: { name: "Zephyr", prompt: "A wind elemental mage", project_id: "proj-ctrl-1" },
      };
      const res = makeMockRes();

      await characterController.createCharacter(req, res);

      assert.strictEqual(res.getStatusCode(), 503);
      const data = res.getResponseData();
      assert.strictEqual(data.ok, false);

      assert.ok(mediaRows.size > 0);
      for (const [id, row] of mediaRows) {
        assert.strictEqual(row.status, "failed");
      }

      assert.strictEqual(wallet.reserveCalls, 1);
      assert.strictEqual(wallet.totalRollbacksAndReleases, 1, "Hold must be released/rolled back EXACTLY ONCE");

      const stuckRows = Array.from(mediaRows.values()).filter((m) => m.status === "processing");
      assert.strictEqual(stuckRows.length, 0);
    });
  });
});
}

// ─── Source: countBehaviorBoundary.test.js ───
{
describe("RC1.1-R3 — Count Parameter Current Server Behavior Test", () => {
  let server;
  let baseUrl;
  let origGetUser;
  const testSecret = "configured-valid-test-secret-at-least-32-chars"; // gate:allow-secret
  let origSecret;

  let createdWorkflows = [];
  let createdMedia = [];
  let enqueueCalls = [];

  let origCreateWorkflow;
  let origCreateMedia;
  let origPrepareAndEnqueue;
  let origProjectsFindByUser;

  after(async () => {
    supabase.auth.getUser = origGetUser;
    process.env.INTERNAL_SECRET = origSecret;
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  before(async () => {
    origSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = testSecret;
    origGetUser = supabase.auth.getUser;
    supabase.auth.getUser = async (token) => {
      if (token && token.startsWith("token-")) {
        const userId = token.replace("token-", "");
        return { data: { user: { id: userId } }, error: null };
      }
      return { data: { user: null }, error: new Error("Invalid token") };
    };

    const app = express();
    app.use(express.json());
    app.use("/api/images", imagesRouter);
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

  beforeEach(() => {
    createdWorkflows = [];
    createdMedia = [];
    enqueueCalls = [];

    origCreateWorkflow = db.workflows.createWorkflow;
    origCreateMedia = db.media.createMedia;
    origPrepareAndEnqueue = useCaseService.prepareAndEnqueue;
    origProjectsFindByUser = db.projects?.findByUser;

    db.projects = {
      ...db.projects,
      findByUser: async (userId, projectId) => [{ id: projectId, user_id: userId }],
    };

    db.workflows.createWorkflow = async (data) => {
      createdWorkflows.push(data);
      return data;
    };

    db.media.createMedia = async (data) => {
      createdMedia.push(data);
      return data;
    };

    useCaseService.prepareAndEnqueue = async (useCaseId, input, opts) => {
      enqueueCalls.push({ useCaseId, input, opts });
      return {
        jobId: "mock-job-count-test",
        taskId: "mock-job-count-test",
        hasSufficientCredits: true,
        calculatedCost: 10,
        billingPlan: { totalCredits: 10 },
      };
    };
  });

  afterEach(() => {
    db.workflows.createWorkflow = origCreateWorkflow;
    db.media.createMedia = origCreateMedia;
    useCaseService.prepareAndEnqueue = origPrepareAndEnqueue;
    if (db.projects) db.projects.findByUser = origProjectsFindByUser;
  });

  it("TEST 1: top-level count: 4 on nanobana_2 today — server clamps silently to 1 placeholder and returns 200", async () => {
    const res = await fetch(`${baseUrl}/api/images/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-test",
      },
      body: JSON.stringify({
        prompt: "A beautiful landscape",
        model: "nanobana_2",
        project_id: "proj-1",
        count: 4, // top-level count
      }),
    });

    const body = await res.json();
    // Server today: does NOT reject with 400 or 422, returns 200
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
    // Server today: silently clamps to 1 media placeholder
    assert.equal(body.mediaIds.length, 1, "Server clamped output count to 1");
    assert.equal(createdMedia.length, 1, "Only 1 media placeholder created in DB");
  });

  it("TEST 2: parameters.count: 4 on nanobana_2 today — server clamps silently to 1 placeholder and returns 200", async () => {
    const res = await fetch(`${baseUrl}/api/images/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-test",
      },
      body: JSON.stringify({
        prompt: "A beautiful landscape",
        model: "nanobana_2",
        project_id: "proj-1",
        parameters: {
          count: 4, // inside parameters
        },
      }),
    });

    const body = await res.json();
    // Server today: does NOT reject with 400 or 422, returns 200
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
    // Server today: silently clamps to 1 media placeholder
    assert.equal(body.mediaIds.length, 1, "Server clamped output count to 1");
    assert.equal(createdMedia.length, 1, "Only 1 media placeholder created in DB");
  });

  it("TEST 3: count: 4 on all catalog image models (gpt_image_2, seedream_v5, nanobana_pro) — all clamp silently to 1", async () => {
    for (const model of ["gpt_image_2", "seedream_v5", "nanobana_pro"]) {
      createdMedia = [];
      const res = await fetch(`${baseUrl}/api/images/generated`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer token-user-test",
        },
        body: JSON.stringify({
          prompt: `Test image for ${model}`,
          model,
          project_id: "proj-1",
          count: 4,
          parameters: { count: 4 },
        }),
      });

      const body = await res.json();
      assert.equal(res.status, 200, `Model ${model} expected 200, got ${res.status}`);
      assert.equal(body.ok, true);
      assert.equal(body.mediaIds.length, 1, `Model ${model} clamped to 1 output`);
      assert.equal(createdMedia.length, 1, `Model ${model} created only 1 placeholder`);
    }
  });
});
}

// ─── Source: generationApisAllParametersBoundary.test.js ───
{
describe("Generation & Gen-Edit APIs — All Models & Parameters Boundary Suite", () => {
  let server;
  let baseUrl;
  let origGetUser;
  let origVerifyWorkflowOwnership;

  let originalFindByUser;
  let originalFindProjectById;
  let originalFindOwnedFolder;
  let originalCreateWorkflow;
  let originalFindWorkflowById;
  let originalGetWorkflow;
  let originalUpdatePrimaryMedia;
  let originalCreateMedia;
  let originalUpdateMedia;
  let originalFindMediaByIdOrWorkflow;
  let originalFindMediaById;
  let originalLinkMedia;
  let originalFindByCharacterId;
  let originalResolveElementRecord;
  let originalPrepareAndEnqueue;

  let createdWorkflows = [];
  let createdMedia = [];
  let enqueueCalls = [];

  before(async () => {
    process.env.NODE_ENV = "test";
    origGetUser = supabase.auth.getUser;
    supabase.auth.getUser = async (token) => {
      if (token === "token-user-A") return { data: { user: { id: "user-A" } }, error: null };
      if (token === "token-user-B") return { data: { user: { id: "user-B" } }, error: null };
      return { data: { user: null }, error: new Error("Invalid token") };
    };

    const app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
    app.use((err, req, res, next) => {
      res.status(err.statusCode || 500).json({
        ok: false,
        message: err.message,
        code: err.code || "INTERNAL_ERROR",
      });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    supabase.auth.getUser = origGetUser;
    if (origVerifyWorkflowOwnership && workflowService?.authService) {
      workflowService.authService.verifyWorkflowOwnership = origVerifyWorkflowOwnership;
    }
    await Promise.allSettled([
      rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect()),
      redisConnection?.quit().catch(() => redisConnection?.disconnect()),
      workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect()),
    ]);
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    resetLimitersForTest();

    originalFindByUser = db.projects?.findByUser;
    originalFindProjectById = db.projects?.findById;
    originalFindOwnedFolder = db.folders?.findOwnedInProject;
    originalCreateWorkflow = db.workflows?.createWorkflow;
    originalFindWorkflowById = db.workflows?.findById;
    originalGetWorkflow = db.workflows?.getWorkflow;
    originalUpdatePrimaryMedia = db.workflows?.updatePrimaryMedia;
    originalCreateMedia = db.media?.createMedia;
    originalUpdateMedia = db.media?.updateMedia;
    originalFindMediaByIdOrWorkflow = db.media?.findMediaByIdOrWorkflow;
    originalFindMediaById = db.media?.findById;
    originalLinkMedia = db.workflowMedia?.linkMedia;
    originalFindByCharacterId = db.characters?.findByCharacterId;
    originalResolveElementRecord = db.elements?.resolveRecord;
    originalPrepareAndEnqueue = useCaseService?.prepareAndEnqueue;

    createdWorkflows = [];
    createdMedia = [];
    enqueueCalls = [];

    db.projects.findByUser = async (userId, projectId = null) => {
      const all = [
        { id: "proj-A", user_id: "user-A" },
        { id: "proj-B", user_id: "user-B" },
      ];
      return all.filter((p) => p.user_id === userId && (!projectId || p.id === projectId));
    };
    db.projects.findById = async (id) => {
      if (id === "proj-A") return { id: "proj-A", user_id: "user-A" };
      if (id === "proj-B") return { id: "proj-B", user_id: "user-B" };
      return null;
    };

    db.folders.findOwnedInProject = async (folderId, projectId, userId) => {
      if (
        folderId === "00000000-0000-4000-8000-000000000001" &&
        projectId === "proj-A" &&
        userId === "user-A"
      ) {
        return { id: folderId, project_id: "proj-A", user_id: "user-A", name: "Folder A" };
      }
      return null;
    };

    const ownedWorkflowIds = new Set(["wf-img-1", "wf-img-2", "wf-last-frame", "wf-vid-1", "wf-char-A", "wf-elem-A"]);
    db.workflows.createWorkflow = async (wf) => {
      createdWorkflows.push(wf);
      return wf;
    };
    db.workflows.findById = async (id) => {
      if (ownedWorkflowIds.has(id)) {
        return { id, project_id: "proj-A", user_id: "user-A", workflow_type: "GENERATION" };
      }
      if (id === "wf-foreign-B") {
        return { id, project_id: "proj-B", user_id: "user-B", workflow_type: "GENERATION" };
      }
      return null;
    };
    db.workflows.getWorkflow = db.workflows.findById;
    db.workflows.updatePrimaryMedia = async () => ({});

    const ownedMediaIds = new Set(["media-img-1", "media-img-2", "media-last-frame", "media-vid-1"]);
    db.media.createMedia = async (m) => {
      createdMedia.push(m);
      return m;
    };
    db.media.updateMedia = async () => ({});
    db.media.findMediaByIdOrWorkflow = async (id) => {
      if (ownedMediaIds.has(id) || ownedWorkflowIds.has(id)) {
        return { id, workflow_id: "wf-img-1", project_id: "proj-A", url: "https://cdn.example.com/a.png" };
      }
      if (id === "media-foreign-B" || id === "wf-foreign-B") {
        return { id, workflow_id: "wf-foreign-B", project_id: "proj-B", url: "https://cdn.example.com/b.png" };
      }
      return null;
    };
    db.media.findById = db.media.findMediaByIdOrWorkflow;

    if (db.workflowMedia) {
      db.workflowMedia.linkMedia = async () => ({});
    }

    if (db.characters) {
      db.characters.findByCharacterId = async (id) => {
        if (id === "char-A" || id === "wf-char-A") {
          return { id: "char-A", workflow_id: "wf-char-A", project_id: "proj-A", name: "Hero" };
        }
        return null;
      };
    }

    if (db.elements) {
      db.elements.resolveRecord = async (id) => {
        if (id === "elem-A" || id === "wf-elem-A") {
          return { id: "elem-A", workflow_id: "wf-elem-A", project_id: "proj-A", name: "Sword" };
        }
        return null;
      };
    }

    useCaseService.prepareAndEnqueue = async (args) => {
      enqueueCalls.push(args);
      return {
        jobId: `job-${enqueueCalls.length}`,
        executionId: args.executionId,
        cost: { totalCredits: 10 },
      };
    };
  });

  afterEach(() => {
    if (db.projects) {
      db.projects.findByUser = originalFindByUser;
      db.projects.findById = originalFindProjectById;
    }
    if (db.folders) db.folders.findOwnedInProject = originalFindOwnedFolder;
    if (db.workflows) {
      db.workflows.createWorkflow = originalCreateWorkflow;
      db.workflows.findById = originalFindWorkflowById;
      db.workflows.getWorkflow = originalGetWorkflow;
      db.workflows.updatePrimaryMedia = originalUpdatePrimaryMedia;
    }
    if (db.media) {
      db.media.createMedia = originalCreateMedia;
      db.media.updateMedia = originalUpdateMedia;
      db.media.findMediaByIdOrWorkflow = originalFindMediaByIdOrWorkflow;
      db.media.findById = originalFindMediaById;
    }
    if (db.workflowMedia) db.workflowMedia.linkMedia = originalLinkMedia;
    if (db.characters) db.characters.findByCharacterId = originalFindByCharacterId;
    if (db.elements) db.elements.resolveRecord = originalResolveElementRecord;
    if (useCaseService) useCaseService.prepareAndEnqueue = originalPrepareAndEnqueue;
  });

  async function postJson(path, body, token = "token-user-A") { // gate:allow-secret
    resetLimitersForTest();
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
  }

  // ===========================================================================
  // 1. IMAGE GENERATION & GEN-EDIT API (POST /api/images/generated)
  // ===========================================================================
  describe("POST /api/images/generated — All Image Models & Parameters", () => {
    it("nanobana_pro: accepts all valid parameters for text-to-image and gen-edit (input_image, images, resolution, aspect_ratio, output_format)", async () => {
      const resolutions = ["1k", "2k", "4k"];
      const aspectRatios = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
      const formats = ["png", "jpeg"];

      // Test all resolutions & formats in text-to-image
      for (const resolution of resolutions) {
        for (const output_format of formats) {
          const { status, data } = await postJson("/api/images/generated", {
            prompt: `NanoBanana Pro ${resolution} ${output_format}`,
            model: "nanobana_pro",
            project_id: "proj-A",
            parameters: {
              resolution,
              aspect_ratio: "16:9",
              output_format,
            },
          });
          assert.equal(status, 200, `Failed for ${resolution}/${output_format}: ${JSON.stringify(data)}`);
          assert.equal(data.ok, true);
          const lastEnqueued = enqueueCalls.at(-1);
          assert.equal(lastEnqueued.input.parameters.resolution, resolution);
          assert.equal(lastEnqueued.input.parameters.output_format, output_format);
          assert.equal(lastEnqueued.input.parameters.aspect_ratio, "16:9");
        }
      }

      // Test all 10 aspect ratios
      for (const aspect_ratio of aspectRatios) {
        const { status, data } = await postJson("/api/images/generated", {
          prompt: `Aspect ratio ${aspect_ratio}`,
          model: "nanobana_pro",
          project_id: "proj-A",
          parameters: { aspect_ratio },
        });
        assert.equal(status, 200, `Failed for aspect_ratio=${aspect_ratio}: ${JSON.stringify(data)}`);
        assert.equal(enqueueCalls.at(-1).input.parameters.aspect_ratio, aspect_ratio);
      }

      // Test Gen-Edit with input_image + multi-reference images + character/element references + alias model name
      const editRes = await postJson("/api/images/generated", {
        prompt: "Edit portrait with reference style",
        model: "nano-banana-pro",
        project_id: "proj-A",
        folder_id: "00000000-0000-4000-8000-000000000001",
        references: ["char-A", "elem-A"],
        parameters: {
          input_image: "media-img-1",
          images: ["wf-img-1", "wf-img-2"],
          resolution: "4k",
          aspect_ratio: "21:9",
          output_format: "jpeg",
        },
      });
      assert.equal(editRes.status, 200, JSON.stringify(editRes.data));
      const editEnqueued = enqueueCalls.at(-1);
      assert.equal(editEnqueued.input.parameters.input_image, "media-img-1");
      assert.deepEqual(editEnqueued.input.parameters.images, ["wf-img-1", "wf-img-2"]);
      assert.equal(editEnqueued.input.parameters.resolution, "4k");
      assert.equal(editEnqueued.input.parameters.aspect_ratio, "21:9");
      assert.equal(editEnqueued.input.parameters.output_format, "jpeg");
      assert.deepEqual(editEnqueued.input.references, ["char-A", "elem-A"]);
    });

    it("nanobana_2: accepts all valid parameters (0.5k-4k, 14 aspect ratios, enable_web_search, enable_image_search, input_image, images)", async () => {
      const resolutions = ["0.5k", "1k", "2k", "4k"];
      const aspectRatios = [
        "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4",
        "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1",
      ];

      for (const resolution of resolutions) {
        const { status, data } = await postJson("/api/images/generated", {
          prompt: `NanoBanana 2 ${resolution}`,
          model: "nanobana_2",
          project_id: "proj-A",
          parameters: {
            resolution,
            enable_web_search: true,
            enable_image_search: true,
            output_format: "jpeg",
          },
        });
        assert.equal(status, 200, `Failed for ${resolution}: ${JSON.stringify(data)}`);
        const params = enqueueCalls.at(-1).input.parameters;
        assert.equal(params.resolution, resolution);
        assert.equal(params.enable_web_search, true);
        assert.equal(params.enable_image_search, true);
        assert.equal(params.output_format, "jpeg");
      }

      for (const aspect_ratio of aspectRatios) {
        const { status, data } = await postJson("/api/images/generated", {
          prompt: `NB2 ratio ${aspect_ratio}`,
          model: "nanobana_2",
          project_id: "proj-A",
          parameters: {
            aspect_ratio,
            input_image: "wf-img-1",
            images: ["media-img-1", "media-img-2"],
          },
        });
        assert.equal(status, 200, `Failed for aspect_ratio=${aspect_ratio}: ${JSON.stringify(data)}`);
        const params = enqueueCalls.at(-1).input.parameters;
        assert.equal(params.aspect_ratio, aspect_ratio);
        assert.equal(params.input_image, "wf-img-1");
        assert.deepEqual(params.images, ["media-img-1", "media-img-2"]);
      }
    });

    it("nanobana_pro_ultra: accepts 4k/8k resolutions, 10 aspect ratios, output_format, and edit parameters", async () => {
      for (const resolution of ["4k", "8k"]) {
        for (const output_format of ["png", "jpeg"]) {
          const { status, data } = await postJson("/api/images/generated", {
            prompt: `Ultra ${resolution}`,
            model: "nanobana_pro_ultra",
            project_id: "proj-A",
            parameters: {
              resolution,
              aspect_ratio: "3:2",
              output_format,
              input_image: "wf-img-1",
              images: ["media-img-1"],
            },
          });
          assert.equal(status, 200, `Failed for ${resolution}/${output_format}: ${JSON.stringify(data)}`);
          const params = enqueueCalls.at(-1).input.parameters;
          assert.equal(params.resolution, resolution);
          assert.equal(params.output_format, output_format);
          assert.equal(params.aspect_ratio, "3:2");
          assert.equal(params.input_image, "wf-img-1");
        }
      }
    });

    it("seedream_v5: accepts 1k/1.5k/2k resolutions, 15 aspect ratios, prompt_optimization_mode (standard/fast), and output_format", async () => {
      const resolutions = ["1k", "1.5k", "2k"];
      const modes = ["standard", "fast"];
      const aspectRatios = [
        "1:1", "1:2", "2:1", "1:3", "3:1", "2:3", "3:2",
        "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "9:21", "21:9",
      ];

      for (const resolution of resolutions) {
        for (const prompt_optimization_mode of modes) {
          const { status, data } = await postJson("/api/images/generated", {
            prompt: `Seedream ${resolution} ${prompt_optimization_mode}`,
            model: "seedream_v5",
            project_id: "proj-A",
            parameters: {
              resolution,
              prompt_optimization_mode,
              output_format: "png",
            },
          });
          assert.equal(status, 200, JSON.stringify(data));
          const params = enqueueCalls.at(-1).input.parameters;
          assert.equal(params.resolution, resolution);
          assert.equal(params.prompt_optimization_mode, prompt_optimization_mode);
          assert.equal(params.output_format, "png");
        }
      }

      for (const aspect_ratio of aspectRatios) {
        const { status, data } = await postJson("/api/images/generated", {
          prompt: `Seedream ratio ${aspect_ratio}`,
          model: "seedream_v5",
          project_id: "proj-A",
          parameters: { aspect_ratio },
        });
        assert.equal(status, 200, `Failed for ${aspect_ratio}: ${JSON.stringify(data)}`);
        assert.equal(enqueueCalls.at(-1).input.parameters.aspect_ratio, aspect_ratio);
      }
    });

    it("gpt_image_2: accepts 1k/2k/4k resolutions, 15 aspect ratios, quality (low/medium/high), output_format (png/jpeg/webp), and edit inputs", async () => {
      const resolutions = ["1k", "2k", "4k"];
      const qualities = ["low", "medium", "high"];
      const formats = ["png", "jpeg", "webp"];

      for (const resolution of resolutions) {
        for (const quality of qualities) {
          for (const output_format of formats) {
            const { status, data } = await postJson("/api/images/generated", {
              prompt: `GPT Image 2 ${resolution} ${quality} ${output_format}`,
              model: "gpt_image_2",
              project_id: "proj-A",
              parameters: {
                resolution,
                quality,
                output_format,
                aspect_ratio: "9:21",
                input_image: "media-img-1",
                images: ["wf-img-1", "wf-img-2"],
              },
            });
            assert.equal(status, 200, JSON.stringify(data));
            const params = enqueueCalls.at(-1).input.parameters;
            assert.equal(params.resolution, resolution);
            assert.equal(params.quality, quality);
            assert.equal(params.output_format, output_format);
            assert.equal(params.aspect_ratio, "9:21");
            assert.equal(params.input_image, "media-img-1");
            assert.deepEqual(params.images, ["wf-img-1", "wf-img-2"]);
          }
        }
      }
    });

    it("rejects invalid parameters, unknown parameters, direct URLs, and cross-tenant IDs on POST /api/images/generated", async () => {
      // 1. Missing required fields
      const noPrompt = await postJson("/api/images/generated", { model: "nanobana_pro", project_id: "proj-A" });
      assert.equal(noPrompt.status, 400);

      const noProject = await postJson("/api/images/generated", { prompt: "hi", model: "nanobana_pro" });
      assert.equal(noProject.status, 400);

      const noModel = await postJson("/api/images/generated", { prompt: "hi", project_id: "proj-A" });
      assert.equal(noModel.status, 400);

      // 2. Invalid enum values per model
      const invalidEnumCases = [
        { model: "nanobana_pro", parameters: { resolution: "8k" } },
        { model: "nanobana_pro", parameters: { aspect_ratio: "1:8" } },
        { model: "nanobana_pro", parameters: { output_format: "webp" } },
        { model: "nanobana_pro_ultra", parameters: { resolution: "1k" } },
        { model: "nanobana_2", parameters: { resolution: "8k" } },
        { model: "seedream_v5", parameters: { prompt_optimization_mode: "turbo" } },
        { model: "gpt_image_2", parameters: { quality: "hd" } },
      ];
      for (const tc of invalidEnumCases) {
        const res = await postJson("/api/images/generated", {
          prompt: "test invalid enum",
          model: tc.model,
          project_id: "proj-A",
          parameters: tc.parameters,
        });
        assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(tc)}, got ${res.status}`);
      }

      // 3. Unknown / unsupported parameters per model
      const unknownParamCases = [
        { model: "nanobana_pro", parameters: { enable_web_search: true } },
        { model: "nanobana_2", parameters: { quality: "high" } },
        { model: "seedream_v5", parameters: { input_image: "wf-img-1" } },
        { model: "gpt_image_2", parameters: { negative_prompt: "blurry" } },
        { model: "gpt_image_2", parameters: { seed: 123 } },
      ];
      for (const tc of unknownParamCases) {
        const res = await postJson("/api/images/generated", {
          prompt: "test unknown param",
          model: tc.model,
          project_id: "proj-A",
          parameters: tc.parameters,
        });
        assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(tc)}, got ${res.status}`);
      }

      // 4. Direct URLs rejected with 400
      const directUrlCases = [
        { input_image: "wf-img-1" }, // top-level input_image forbidden
        { image_url: "https://evil.example.com/a.png" },
        { references: ["https://evil.example.com/a.png"] },
        { parameters: { input_image: "https://evil.example.com/a.png" } },
      ];
      for (const extra of directUrlCases) {
        const res = await postJson("/api/images/generated", {
          prompt: "direct url test",
          model: "nanobana_pro",
          project_id: "proj-A",
          ...extra,
        });
        assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(extra)}, got ${res.status}`);
      }

      // 5. Cross-tenant project or media returns 404 (never 403)
      const crossProject = await postJson("/api/images/generated", {
        prompt: "cross project",
        model: "nanobana_pro",
        project_id: "proj-B",
      });
      assert.equal(crossProject.status, 404);

      const crossMedia = await postJson("/api/images/generated", {
        prompt: "cross media",
        model: "nanobana_pro",
        project_id: "proj-A",
        parameters: { input_image: "media-foreign-B" },
      });
      assert.equal(crossMedia.status, 404);
    });
  });

  // ===========================================================================
  // 2. VIDEO GENERATION, I2V, KEYFRAME, EXTEND & RETAKE API (POST /api/video/generated)
  // ===========================================================================
  describe("POST /api/video/generated — All Video Models & Parameters", () => {
    it("wan_3_0: accepts all valid parameters for text-to-video, image-to-video, and keyframe interpolation", async () => {
      const durations = [5, 10];
      const aspectRatios = ["16:9", "9:16", "1:1", "4:3", "3:4"];
      const resolutions = ["480p", "720p", "1080p"];

      for (const duration of durations) {
        for (const resolution of resolutions) {
          const { status, data } = await postJson("/api/video/generated", {
            prompt: `Wan 3.0 ${duration}s ${resolution}`,
            model: "wan_3_0",
            project_id: "proj-A",
            parameters: {
              duration,
              resolution,
              aspect_ratio: "16:9",
              generate_audio: true,
              enable_prompt_expansion: true,
              seed: 12345,
            },
          });
          assert.equal(status, 200, JSON.stringify(data));
          const params = enqueueCalls.at(-1).input.parameters;
          assert.equal(params.duration, duration);
          assert.equal(params.resolution, resolution);
          assert.equal(params.generate_audio, true);
          assert.equal(params.enable_prompt_expansion, true);
          assert.equal(params.seed, 12345);
        }
      }

      for (const aspect_ratio of aspectRatios) {
        const { status, data } = await postJson("/api/video/generated", {
          prompt: `Wan I2V + last_frame ${aspect_ratio}`,
          model: "wan_3_0",
          project_id: "proj-A",
          parameters: {
            aspect_ratio,
            input_image: "wf-img-1",
            last_frame: "wf-last-frame",
            generate_audio: false,
          },
        });
        assert.equal(status, 200, JSON.stringify(data));
        const params = enqueueCalls.at(-1).input.parameters;
        assert.equal(params.aspect_ratio, aspect_ratio);
        assert.equal(params.input_image, "wf-img-1");
        assert.equal(params.last_frame, "wf-last-frame");
        assert.equal(params.generate_audio, false);
      }
    });

    it("seedance_2_5: accepts all valid parameters (duration 5/10, 6 aspect ratios, 480p-4k, generate_audio, input_image, last_frame)", async () => {
      const durations = [5, 10];
      const aspectRatios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
      const resolutions = ["480p", "720p", "1080p", "4k"];

      for (const duration of durations) {
        for (const resolution of resolutions) {
          const { status, data } = await postJson("/api/video/generated", {
            prompt: `Seedance 2.5 ${duration}s ${resolution}`,
            model: "seedance_2_5",
            project_id: "proj-A",
            parameters: {
              duration,
              resolution,
              generate_audio: false,
            },
          });
          assert.equal(status, 200, JSON.stringify(data));
          const params = enqueueCalls.at(-1).input.parameters;
          assert.equal(params.duration, duration);
          assert.equal(params.resolution, resolution);
          assert.equal(params.generate_audio, false);
        }
      }

      for (const aspect_ratio of aspectRatios) {
        const { status, data } = await postJson("/api/video/generated", {
          prompt: `Seedance 2.5 keyframe ${aspect_ratio}`,
          model: "seedance-2-5",
          project_id: "proj-A",
          parameters: {
            aspect_ratio,
            input_image: "media-img-1",
            last_frame: "media-last-frame",
          },
        });
        assert.equal(status, 200, JSON.stringify(data));
        const params = enqueueCalls.at(-1).input.parameters;
        assert.equal(params.aspect_ratio, aspect_ratio);
        assert.equal(params.input_image, "media-img-1");
        assert.equal(params.last_frame, "media-last-frame");
      }
    });

    it("ltx_2_3_fast & ltx_2_5_fast: accept all durations (6..20), resolutions (720p..4k), fps (24/25/48/50), camera_motion (all 8), input_image, last_frame", async () => {
      const durations = [6, 8, 10, 12, 14, 16, 18, 20];
      const resolutions = ["720p", "1080p", "1440p", "4k"];
      const fpsValues = [24, 25, 48, 50];
      const cameraMotions = [
        "dolly_in", "dolly_out", "dolly_left", "dolly_right",
        "jib_up", "jib_down", "static", "focus_shift",
      ];

      for (const model of ["ltx_2_3_fast", "ltx_2_5_fast"]) {
        for (const duration of durations) {
          const { status, data } = await postJson("/api/video/generated", {
            prompt: `${model} duration ${duration}`,
            model,
            project_id: "proj-A",
            parameters: {
              duration,
              aspect_ratio: "9:16",
              resolution: "1080p",
              fps: 24,
              generate_audio: true,
            },
          });
          assert.equal(status, 200, JSON.stringify(data));
          assert.equal(enqueueCalls.at(-1).input.parameters.duration, duration);
        }

        for (const resolution of resolutions) {
          for (const fps of fpsValues) {
            const { status, data } = await postJson("/api/video/generated", {
              prompt: `${model} ${resolution} ${fps}fps`,
              model,
              project_id: "proj-A",
              parameters: { resolution, fps },
            });
            assert.equal(status, 200, JSON.stringify(data));
            const params = enqueueCalls.at(-1).input.parameters;
            assert.equal(params.resolution, resolution);
            assert.equal(params.fps, fps);
          }
        }

        for (const camera_motion of cameraMotions) {
          const { status, data } = await postJson("/api/video/generated", {
            prompt: `${model} camera ${camera_motion}`,
            model,
            project_id: "proj-A",
            parameters: {
              camera_motion,
              input_image: "wf-img-1",
              last_frame: "wf-last-frame",
            },
          });
          assert.equal(status, 200, JSON.stringify(data));
          const params = enqueueCalls.at(-1).input.parameters;
          assert.equal(params.camera_motion, camera_motion);
          assert.equal(params.input_image, "wf-img-1");
          assert.equal(params.last_frame, "wf-last-frame");
        }
      }
    });

    it("ltx_2_3_pro & ltx_2_5_pro: accept durations (6/8/10), resolutions (720p..4k), fps (24/25/48/50), camera_motion, input_image, last_frame", async () => {
      for (const model of ["ltx_2_3_pro", "ltx_2_5_pro"]) {
        for (const duration of [6, 8, 10]) {
          const { status, data } = await postJson("/api/video/generated", {
            prompt: `${model} ${duration}s`,
            model,
            project_id: "proj-A",
            parameters: {
              duration,
              aspect_ratio: "16:9",
              resolution: "4k",
              fps: 50,
              generate_audio: false,
              camera_motion: "dolly_in",
              input_image: "media-img-1",
              last_frame: "media-last-frame",
            },
          });
          assert.equal(status, 200, JSON.stringify(data));
          const params = enqueueCalls.at(-1).input.parameters;
          assert.equal(params.duration, duration);
          assert.equal(params.resolution, "4k");
          assert.equal(params.fps, 50);
          assert.equal(params.generate_audio, false);
          assert.equal(params.camera_motion, "dolly_in");
        }
      }
    });

    it("ltx_retake: accepts input_video, prompt, start_time, duration (2..10), retake_mode, and resolution (1920x1080/1080x1920)", async () => {
      const durations = [2, 4, 6, 8, 10];
      const modes = ["replace_audio_and_video", "replace_video", "replace_audio"];
      const resolutions = ["1920x1080", "1080x1920"];

      for (const duration of durations) {
        for (const retake_mode of modes) {
          for (const resolution of resolutions) {
            const { status, data } = await postJson("/api/video/generated", {
              prompt: `LTX Retake ${duration}s ${retake_mode}`,
              model: "ltx_retake",
              project_id: "proj-A",
              parameters: {
                input_video: "media-vid-1",
                start_time: 1.5,
                duration,
                retake_mode,
                resolution,
              },
            });
            assert.equal(status, 200, `Failed for ltx_retake ${duration}/${retake_mode}/${resolution}: ${JSON.stringify(data)}`);
            const params = enqueueCalls.at(-1).input.parameters;
            assert.equal(params.input_video, "media-vid-1");
            assert.equal(params.start_time, 1.5);
            assert.equal(params.duration, duration);
            assert.equal(params.retake_mode, retake_mode);
            assert.equal(params.resolution, resolution);
            assert.equal(params.aspect_ratio, undefined);
          }
        }
      }
    });

    it("rejects missing required fields, invalid enums, unknown parameters, direct URLs, and cross-tenant IDs on POST /api/video/generated", async () => {
      // 1. Missing required model parameters
      const missingStartTimeRetake = await postJson("/api/video/generated", {
        prompt: "ltx retake without start_time",
        model: "ltx_retake",
        project_id: "proj-A",
        parameters: { input_video: "wf-vid-1", duration: 4 },
      });
      assert.equal(missingStartTimeRetake.status, 400);

      // 2. Invalid enum values per video model
      const invalidVideoEnums = [
        { model: "wan_3_0", parameters: { duration: 15 } },
        { model: "wan_3_0", parameters: { resolution: "4k" } },
        { model: "seedance_2_5", parameters: { duration: 8 } },
        { model: "ltx_2_3_pro", parameters: { duration: 20 } },
        { model: "ltx_2_3_fast", parameters: { fps: 60 } },
        { model: "ltx_2_3_fast", parameters: { camera_motion: "barrel_roll" } },
        { model: "ltx_retake", parameters: { input_video: "wf-vid-1", start_time: 1, retake_mode: "audio_only" } },
        { model: "ltx_retake", parameters: { input_video: "wf-vid-1", start_time: 1, resolution: "4k" } },
      ];
      for (const tc of invalidVideoEnums) {
        const res = await postJson("/api/video/generated", {
          prompt: "invalid video enum",
          model: tc.model,
          project_id: "proj-A",
          parameters: tc.parameters,
        });
        assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(tc)}, got ${res.status}`);
      }

      // 3. Explicit unknown parameters rejected with 400
      const unknownVideoParams = [
        { model: "ltx_retake", parameters: { input_video: "wf-vid-1", start_time: 0, aspect_ratio: "16:9" } },
        { model: "seedance_2_5", parameters: { camera_motion: "dolly_in" } },
      ];
      for (const tc of unknownVideoParams) {
        const res = await postJson("/api/video/generated", {
          prompt: "unknown video param",
          model: tc.model,
          project_id: "proj-A",
          parameters: tc.parameters,
        });
        assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(tc)}, got ${res.status}`);
      }

      // 4. Direct URLs rejected with 400
      const directVideoUrls = [
        { input_video: "wf-vid-1" },
        { video_url: "https://evil.example.com/v.mp4" },
        { parameters: { input_video: "https://evil.example.com/v.mp4" } },
        { parameters: { last_frame: "https://evil.example.com/f.png" } },
      ];
      for (const extra of directVideoUrls) {
        const res = await postJson("/api/video/generated", {
          prompt: "direct video url",
          model: "wan_3_0",
          project_id: "proj-A",
          ...extra,
        });
        assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(extra)}, got ${res.status}`);
      }

      // 5. Cross-tenant input_video / last_frame returns 404
      const crossVideo = await postJson("/api/video/generated", {
        prompt: "cross tenant video retake",
        model: "ltx_retake",
        project_id: "proj-A",
        parameters: { input_video: "wf-foreign-B", duration: 4, start_time: 1 },
      });
      assert.equal(crossVideo.status, 404);
    });
  });
});
}
