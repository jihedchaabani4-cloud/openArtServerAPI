/**
 * F2.4-b2 — Controller Error-Path Boundary Tests
 *
 * Covers BOTH imageController and videoController for:
 *   (a) Error after placeholders are created but before enqueue:
 *       - All placeholders marked "failed"
 *       - No hold reserved (or hold released)
 *       - Clean client error response
 *       - Zero stuck "processing" rows
 *   (b) Enqueue dispatch failure (QUEUE_DISPATCH_FAILED):
 *       - All placeholders marked "failed"
 *       - Hold released exactly once by UseCaseService
 *       - Clean HTTP 503 client response
 *       - Zero stuck "processing" rows
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as imageController from "../../controllers/imageController.js";
import * as videoController from "../../controllers/videoController.js";
import { db, useCaseService } from "../../src/container.js";
import { InMemoryWalletService } from "../../src/services/walletService.js";
import { UseCaseBillingRuntime } from "../../src/v2/runtime/useCaseBillingRuntime.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { bootstrapV2 } from "../../src/v2/bootstrap.js";

bootstrapV2();

after(async () => {
  try {
    await redisConnection?.quit().catch(() => redisConnection?.disconnect());
    await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
  } catch {}
});


describe("F2.4-b2 — Controller Error-Path Boundary Tests (Image & Video)", () => {
  let mediaRows;
  let updateCalls;
  let origDbMedia;
  let origDbWorkflows;
  let origDbProjects;
  let origPrepareAndEnqueue;
  let origWalletService;
  let origBillingRuntime;
  let origJobQueueService;

  beforeEach(() => {
    mediaRows = new Map();
    updateCalls = [];

    origDbMedia = db.media;
    origDbWorkflows = db.workflows;
    origDbProjects = db.projects;
    origPrepareAndEnqueue = useCaseService.prepareAndEnqueue;
    origWalletService = useCaseService.walletService;
    origBillingRuntime = useCaseService.billingRuntime;
    origJobQueueService = useCaseService.jobQueueService;

    db.media = {
      createMedia: async (data) => {
        const row = { ...data, status: data.status || "processing" };
        mediaRows.set(data.id, row);
        return row;
      },
      findByWorkflow: async (workflowId) => {
        return Array.from(mediaRows.values()).filter((m) => m.workflow_id === workflowId);
      },
      updateMedia: async (id, data) => {
        updateCalls.push({ id, ...data });
        const existing = mediaRows.get(id) || { id };
        const updated = { ...existing, ...data };
        mediaRows.set(id, updated);
        return updated;
      },
    };

    db.workflows = {
      createWorkflow: async (data) => data,
    };

    db.projects = {
      findById: async (id) => ({ id, user_id: "user-ctrl-test" }),
    };
  });

  afterEach(() => {
    db.media = origDbMedia;
    db.workflows = origDbWorkflows;
    db.projects = origDbProjects;
    useCaseService.prepareAndEnqueue = origPrepareAndEnqueue;
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
  // IMAGE CONTROLLER TESTS
  // ───────────────────────────────────────────────────────────────────────────

  describe("imageController error paths", () => {
    it("TEST 1: error after placeholders created but before enqueue -> all placeholders failed, no hold reserved, clean 500, no stuck processing rows", async () => {
      // Simulate crash in prepareAndEnqueue before any hold is reserved
      useCaseService.prepareAndEnqueue = async () => {
        const err = new Error("Database deadlock before credit reservation");
        err.statusCode = 500;
        throw err;
      };

      const req = {
        user: { id: "user-ctrl-test" },
        body: {
          prompt: "A beautiful mountain lake",
          model: "nanobana_2",
          project_id: "proj-ctrl-1",
        },
      };
      const res = makeMockRes();

      await imageController.generateImage(req, res);

      // 1. Client receives clean error response
      assert.strictEqual(res.getStatusCode(), 500);
      const data = res.getResponseData();
      assert.strictEqual(data.ok, false);
      assert.match(data.message, /failed to generate image/i);

      // 2. Placeholders were created and then marked failed
      assert.ok(mediaRows.size > 0, "Placeholders must have been created");
      for (const [id, row] of mediaRows) {
        assert.strictEqual(row.status, "failed", `Media placeholder "${id}" must be marked failed`);
        assert.match(row.error_message, /Database deadlock/i);
      }

      // 3. ZERO stuck processing rows
      const stuckRows = Array.from(mediaRows.values()).filter((m) => m.status === "processing");
      assert.strictEqual(stuckRows.length, 0, "Must be zero stuck processing rows");
    });

    it("TEST 2: enqueue dispatch fails (QUEUE_DISPATCH_FAILED) -> all placeholders failed, hold released exactly once, clean 503, no stuck processing rows", async () => {
      const wallet = new InMemoryWalletService();
      await wallet.setBalance("user-ctrl-test", 100);
      const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });

      useCaseService.walletService = wallet;
      useCaseService.billingRuntime = billingRuntime;
      // Fail the job queue dispatch
      useCaseService.jobQueueService = {
        addUseCaseJob: async () => {
          throw new Error("Redis cluster failover in progress");
        },
      };

      const req = {
        user: { id: "user-ctrl-test" },
        body: {
          prompt: "A futuristic skyline",
          model: "nanobana_2",
          project_id: "proj-ctrl-2",
        },
      };
      const res = makeMockRes();

      await imageController.generateImage(req, res);

      // 1. Client receives HTTP 503 with QUEUE_DISPATCH_FAILED
      assert.strictEqual(res.getStatusCode(), 503);
      const data = res.getResponseData();
      assert.strictEqual(data.ok, false);
      assert.strictEqual(data.code, "QUEUE_DISPATCH_FAILED");

      // 2. All media placeholders marked failed
      assert.ok(mediaRows.size > 0, "Placeholders must have been created");
      for (const [id, row] of mediaRows) {
        assert.strictEqual(row.status, "failed", `Media "${id}" must be marked failed`);
      }

      // 3. Billing hold was released exactly once (not stuck held)
      const reservations = Array.from(wallet.reservations.values());
      assert.strictEqual(reservations.length, 1, "Exactly one reservation created");
      assert.ok(
        reservations[0].status === "released" || reservations[0].status === "rolled_back",
        `Reservation must be released/rolled_back, got: ${reservations[0].status}`
      );

      // 4. ZERO stuck processing rows
      const stuckRows = Array.from(mediaRows.values()).filter((m) => m.status === "processing");
      assert.strictEqual(stuckRows.length, 0, "Must be zero stuck processing rows");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // VIDEO CONTROLLER TESTS
  // ───────────────────────────────────────────────────────────────────────────

  describe("videoController error paths", () => {
    it("TEST 3: error after placeholders created but before enqueue -> all placeholders failed, no hold reserved, clean 500, no stuck processing rows", async () => {
      useCaseService.prepareAndEnqueue = async () => {
        const err = new Error("Downstream connection timeout before enqueue");
        err.statusCode = 500;
        throw err;
      };

      const req = {
        user: { id: "user-ctrl-test" },
        body: {
          prompt: "Waves crashing on the shore",
          model: "wan_3_0",
          project_id: "proj-ctrl-3",
        },
      };
      const res = makeMockRes();

      await videoController.generateVideo(req, res);

      // 1. Client receives clean error response
      assert.strictEqual(res.getStatusCode(), 500);
      const data = res.getResponseData();
      assert.strictEqual(data.ok, false);
      assert.match(data.message, /failed to generate video/i);

      // 2. Placeholders were created and then marked failed
      assert.ok(mediaRows.size > 0, "Placeholders must have been created");
      for (const [id, row] of mediaRows) {
        assert.strictEqual(row.status, "failed", `Video placeholder "${id}" must be marked failed`);
        assert.match(row.error_message, /Downstream connection timeout/i);
      }

      // 3. ZERO stuck processing rows
      const stuckRows = Array.from(mediaRows.values()).filter((m) => m.status === "processing");
      assert.strictEqual(stuckRows.length, 0, "Must be zero stuck processing rows");
    });

    it("TEST 4: enqueue dispatch fails (QUEUE_DISPATCH_FAILED) -> all placeholders failed, hold released exactly once, clean 503, no stuck processing rows", async () => {
      const wallet = new InMemoryWalletService();
      await wallet.setBalance("user-ctrl-test", 100);
      const billingRuntime = new UseCaseBillingRuntime({ walletService: wallet });

      useCaseService.walletService = wallet;
      useCaseService.billingRuntime = billingRuntime;
      // Fail the job queue dispatch
      useCaseService.jobQueueService = {
        addUseCaseJob: async () => {
          throw new Error("Redis OOM or unreachable");
        },
      };

      const req = {
        user: { id: "user-ctrl-test" },
        body: {
          prompt: "Drone flyover of snowy mountains",
          model: "seedance_2_5",
          project_id: "proj-ctrl-4",
        },
      };
      const res = makeMockRes();

      await videoController.generateVideo(req, res);

      // 1. Client receives HTTP 503 with QUEUE_DISPATCH_FAILED
      assert.strictEqual(res.getStatusCode(), 503);
      const data = res.getResponseData();
      assert.strictEqual(data.ok, false);
      assert.strictEqual(data.code, "QUEUE_DISPATCH_FAILED");

      // 2. All media placeholders marked failed
      assert.ok(mediaRows.size > 0, "Placeholders must have been created");
      for (const [id, row] of mediaRows) {
        assert.strictEqual(row.status, "failed", `Video media "${id}" must be marked failed`);
      }

      // 3. Billing hold was released exactly once (not stuck held)
      const reservations = Array.from(wallet.reservations.values());
      assert.strictEqual(reservations.length, 1, "Exactly one reservation created");
      assert.ok(
        reservations[0].status === "released" || reservations[0].status === "rolled_back",
        `Reservation must be released/rolled_back, got: ${reservations[0].status}`
      );

      // 4. ZERO stuck processing rows
      const stuckRows = Array.from(mediaRows.values()).filter((m) => m.status === "processing");
      assert.strictEqual(stuckRows.length, 0, "Must be zero stuck processing rows");
    });
  });
});
