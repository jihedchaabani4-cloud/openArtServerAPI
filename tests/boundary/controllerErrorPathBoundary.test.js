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

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as imageController from "../../controllers/imageController.js";
import * as videoController from "../../controllers/videoController.js";
import * as characterController from "../../controllers/characterController.js";
import { db, useCaseService, characterService } from "../../src/container.js";
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
