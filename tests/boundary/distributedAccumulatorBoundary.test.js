/**
 * Boundary tests: BUG-09 — in-memory activeAccumulators not shared across processes
 *
 * The bug: getRunBillingAccumulator(runId) returns null when called from a
 * fresh module context (simulating a separate worker process or a crash/restart).
 * Billing entries are lost because they exist only in the process-local Map.
 *
 * Fix: Persist billing entries to run metadata via runRepo.updateRun so that
 * any worker process can reconstruct the accumulator from DB.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// ── Force in-memory mode (no Supabase required) ───────────────────────────────
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";

import { RunRepository } from "../../src/v2/runner/runRepository.js";
RunRepository.useMemoryFallback = true;

import {
  startWorkflowRun,
  getRunBillingAccumulator,
  initializeGateways,
} from "../../src/v2/runner/workflowRunner.js";

// ── Minimal stub gateways ─────────────────────────────────────────────────────
const stubBilling = {
  reserve: async () => ({ referenceId: "ref-stub", amount: 0, status: "held" }),
  settle: async () => ({ status: "settled" }),
  rollback: async () => ({ status: "voided" }),
  extendHold: async () => ({ status: "extended" }),
};

const stubStorage = { upload: async () => ({ url: "https://example.com/img" }) };
const stubEvents = { record: () => {} };

before(() => {
  initializeGateways({ billing: stubBilling, storage: stubStorage, events: stubEvents });
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function makeMinimalPlan(overrides = {}) {
  return {
    workflow_id: "wf-test",
    workflow_version: "1",
    nodes: [],
    edges: [],
    ...overrides,
  };
}

// ── TEST SUITE ─────────────────────────────────────────────────────────────────
describe("BUG-09 — distributed accumulator persistence", () => {
  /**
   * TEST 1: getRunBillingAccumulator must not return null for a run whose
   * DB record exists but whose in-memory Map entry was cleared (simulating
   * a fresh process or crash/restart).
   *
   * Before the fix: activeAccumulators.get(runId) returns undefined → null.
   * After the fix: function reconstructs accumulator from run metadata.
   */
  it("T1 — reconstructs accumulator from DB metadata after in-memory map is cleared", async () => {
    // Arrange: create a run record directly in the repo
    const runRepo = new RunRepository();
    const runId = "run-dist-001";
    await runRepo.createRun({
      run_id: runId,
      workflow_id: "wf-test",
      workflow_version: "1",
      status: "running",
      input: {},
      execution_plan: {},
    });

    // Seed billing entries into metadata (simulating a previous worker's writes)
    const existingEntries = [
      { nodeId: "node-a", nodeType: "llm", model: "gemini", amount: 10, kind: "CHARGEABLE", recordedAt: new Date().toISOString() },
    ];
    const run = await runRepo.getRun(runId);
    await runRepo.updateRun(runId, {
      metadata: { ...(run.metadata || {}), billingAccumulator: existingEntries },
    });

    // Act: call getRunBillingAccumulator — in-memory Map does NOT have this runId
    const accumulator = await getRunBillingAccumulator(runId);

    // Assert: must NOT be null; must expose the persisted entries
    assert.ok(accumulator !== null, "accumulator must not be null when run metadata exists");
    const breakdown = await accumulator.getBreakdown();
    assert.equal(breakdown.length, 1, "must reconstruct 1 entry from DB metadata");
    assert.equal(breakdown[0].nodeId, "node-a");
    const total = await accumulator.getTotalCost();
    assert.equal(total, 10, "must reconstruct total cost from DB metadata");
  });

  /**
   * TEST 2: record() on the accumulator must persist entries to run metadata,
   * not just update the in-memory Map.
   *
   * Before the fix: entries are only in BillingAccumulator.entries[] — a
   * process crash loses them.
   * After the fix: each record() call writes to runRepo.updateRun.
   */
  it("T2 — record() persists billing entry to run metadata", async () => {
    const runRepo = new RunRepository();
    const runId = "run-dist-002";
    await runRepo.createRun({
      run_id: runId,
      workflow_id: "wf-test",
      workflow_version: "1",
      status: "running",
      input: {},
      execution_plan: {},
    });

    // Get the accumulator (set up during startWorkflowRun normally)
    // For this test we set it manually via the module to avoid a full run
    const accumulator = await getRunBillingAccumulator(runId);
    // accumulator may be null initially (no in-memory entry) or a fresh reconstructed one
    // The fix must allow us to record directly against the runId

    // Act: record a billing entry — after the fix, this must persist to DB
    await accumulator.record({
      nodeId: "node-b",
      nodeType: "image-generation",
      model: "wavespeed",
      amount: 25,
      kind: "CHARGEABLE",
    });

    // Assert: verify the entry appears in DB metadata
    const stored = await runRepo.getRun(runId);
    const storedEntries = stored?.metadata?.billingAccumulator || [];
    assert.ok(storedEntries.length >= 1, "entry must be persisted to run metadata");
    const entry = storedEntries.find((e) => e.nodeId === "node-b");
    assert.ok(entry, "node-b entry must be in metadata");
    assert.equal(entry.amount, 25);
  });

  /**
   * TEST 3: Two simulated "worker processes" (fresh getRunBillingAccumulator
   * calls on the same runId, without a shared in-memory Map) must see
   * consistent accumulated totals.
   *
   * Before the fix: second call returns null (no Map entry).
   * After the fix: both calls return the same DB-backed totals.
   */
  it("T3 — two independent accumulator reads on same runId see consistent totals", async () => {
    const runRepo = new RunRepository();
    const runId = "run-dist-003";
    await runRepo.createRun({
      run_id: runId,
      workflow_id: "wf-test",
      workflow_version: "1",
      status: "running",
      input: {},
      execution_plan: {},
    });

    // Worker-1 writes 2 entries
    await runRepo.updateRun(runId, {
      metadata: {
        billingAccumulator: [
          { nodeId: "n1", amount: 5, kind: "CHARGEABLE", recordedAt: new Date().toISOString() },
          { nodeId: "n2", amount: 15, kind: "CHARGEABLE", recordedAt: new Date().toISOString() },
        ],
      },
    });

    // Worker-2 reads accumulator (no in-memory Map entry)
    const acc = await getRunBillingAccumulator(runId);
    assert.ok(acc !== null, "worker-2 must get a non-null accumulator");
    const total = await acc.getTotalCost();
    assert.equal(total, 20, "worker-2 must see combined total of 20 from DB");
    const breakdown = await acc.getBreakdown();
    assert.equal(breakdown.length, 2, "worker-2 must see 2 entries");
  });

  /**
   * TEST 4: Crash simulation — accumulator initialized but process "restarts"
   * (in-memory Map is cleared by simulated restart). New process must
   * reconstruct correct breakdown for settlement.
   *
   * Before the fix: getRunBillingAccumulator returns null → settlement uses 0.
   * After the fix: settlement reconstructs from DB, totalCost = correct value.
   */
  it("T4 — crash recovery: new process reconstructs breakdown from DB for settlement", async () => {
    const runRepo = new RunRepository();
    const runId = "run-dist-004";
    await runRepo.createRun({
      run_id: runId,
      workflow_id: "wf-test",
      workflow_version: "1",
      status: "running",
      input: {},
      execution_plan: {},
    });

    // Simulate: previous worker wrote these entries to DB before crashing
    await runRepo.updateRun(runId, {
      metadata: {
        billingAccumulator: [
          { nodeId: "nodeX", amount: 50, kind: "CHARGEABLE", recordedAt: new Date().toISOString() },
          { nodeId: "nodeY", amount: 0, kind: "NO_CHARGE", recordedAt: new Date().toISOString() },
          { nodeId: "nodeZ", amount: 30, kind: "CHARGEABLE", recordedAt: new Date().toISOString() },
        ],
      },
    });

    // New process: no in-memory Map entry for this runId
    const acc = await getRunBillingAccumulator(runId);
    assert.ok(acc !== null, "recovered accumulator must not be null");

    const total = await acc.getTotalCost();
    assert.equal(total, 80, "crash-recovered total must be 80 (50+30 chargeable)");

    const breakdown = await acc.getBreakdown();
    assert.equal(breakdown.length, 3, "must recover all 3 entries");
    assert.ok(breakdown.some((e) => e.nodeId === "nodeX"), "nodeX must be in breakdown");
    assert.ok(breakdown.some((e) => e.nodeId === "nodeZ"), "nodeZ must be in breakdown");
  });

  after(async () => {
    try {
      const { redisConnection, workerRedisConnection } = await import("../../src/queue/redis.js");
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
  });
});


