import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { executeNodeJob } from "../../src/v2/runner/nodeExecutor.js";
import { executeOrchestration } from "../../src/v2/runner/workflowRunner.js";
import { RunRepository } from "../../src/v2/runner/runRepository.js";
import { UseCaseService } from "../../src/services/useCaseService.js";
import { MediaRepository } from "../../src/db/MediaRepository.js";
import { db } from "../../src/container.js";

describe("Sibling Media Cleanup & Deadlock Boundary Tests (Task T8 / BUG-08)", () => {
  let runRepo;
  let originalFindByWorkflow;
  let originalUpdateMedia;
  let originalFailPendingMediaByWorkflow;

  let mediaRecords = [];
  let updatedCalls = [];

  after(() => {
    setTimeout(() => process.exit(0), 100);
  });

  beforeEach(() => {
    runRepo = new RunRepository();
    mediaRecords = [];
    updatedCalls = [];

    originalFindByWorkflow = db.media?.findByWorkflow;
    originalUpdateMedia = db.media?.updateMedia;
    originalFailPendingMediaByWorkflow = db.media?.failPendingMediaByWorkflow;
  });

  afterEach(() => {
    if (db.media) {
      db.media.findByWorkflow = originalFindByWorkflow;
      db.media.updateMedia = originalUpdateMedia;
      db.media.failPendingMediaByWorkflow = originalFailPendingMediaByWorkflow;
    }
  });

  it("TEST 1: Node failure fails ALL sibling processing/pending media and preserves completed media", async () => {
    const workflowId = "wf-sibling-test-1";
    const runId = "run-sibling-test-1";
    const nodeId = "failing_node";

    // Setup 4 media records: 2 processing, 1 pending, 1 completed (already successful)
    mediaRecords = [
      { id: "media-1", workflow_id: workflowId, step_id: "step-1", status: "processing" },
      { id: "media-2", workflow_id: workflowId, step_id: "step-2", status: "pending" },
      { id: "media-3", workflow_id: workflowId, step_id: "step-3", status: "processing" },
      { id: "media-4", workflow_id: workflowId, step_id: "step-4", status: "completed", url: "https://example.com/ok.png" },
    ];

    db.media.findByWorkflow = async (wfId) => mediaRecords.filter((m) => m.workflow_id === wfId);
    db.media.updateMedia = async (id, patch) => {
      const record = mediaRecords.find((m) => m.id === id);
      if (record) {
        Object.assign(record, patch);
      }
      updatedCalls.push({ id, ...patch });
      return record;
    };

    const plan = {
      workflow_id: workflowId,
      nodes: [
        {
          id: nodeId,
          type: "prompt-builder",
          inputs: {}, // Missing required 'prompt' causes node to fail validation
          retry_policy: { max_attempts: 1 },
        },
      ],
      edges: [],
      outputs: {},
    };

    await runRepo.createRun({
      run_id: runId,
      workflow_id: workflowId,
      status: "running",
      input: { workflow_id: workflowId },
      execution_plan: plan,
    });

    await runRepo.createNodeRun({
      run_id: runId,
      node_id: nodeId,
      node_type: "prompt-builder",
      status: "pending",
      attempt: 1,
    });

    // Execute failing node
    await executeNodeJob(runId, nodeId);

    // Assertions:
    // With BUG-08, only media-1 was failed, media-2 and media-3 stayed stuck in processing/pending!
    const m1 = mediaRecords.find((m) => m.id === "media-1");
    const m2 = mediaRecords.find((m) => m.id === "media-2");
    const m3 = mediaRecords.find((m) => m.id === "media-3");
    const m4 = mediaRecords.find((m) => m.id === "media-4");

    assert.strictEqual(m1.status, "failed", "media-1 (processing) must be failed");
    assert.strictEqual(m2.status, "failed", "media-2 (pending) must be failed");
    assert.strictEqual(m3.status, "failed", "media-3 (processing) must be failed");
    assert.strictEqual(m4.status, "completed", "CRITICAL: media-4 (completed) must NOT be overwritten!");
  });

  it("TEST 2: UseCaseService failure fails ALL sibling processing media and preserves completed media", async () => {
    const workflowId = "wf-sibling-usecase-1";
    mediaRecords = [
      { id: "m-proc-1", workflow_id: workflowId, status: "processing" },
      { id: "m-proc-2", workflow_id: workflowId, status: "processing" },
      { id: "m-pend-3", workflow_id: workflowId, status: "pending" },
      { id: "m-succ-4", workflow_id: workflowId, status: "completed", url: "https://example.com/done.png" },
    ];

    const mockMediaDb = {
      findByWorkflow: async (wfId) => mediaRecords.filter((m) => m.workflow_id === wfId),
      updateMedia: async (id, patch) => {
        const item = mediaRecords.find((m) => m.id === id);
        if (item) Object.assign(item, patch);
        return item;
      },
    };

    const mockBillingRuntime = {
      rollbackUseCase: async () => ({ rolledBack: true }),
      settleUseCase: async () => ({ settled: true }),
    };

    const ucService = new UseCaseService({
      billingRuntime: mockBillingRuntime,
      db: { media: mockMediaDb },
    });

    ucService.runUseCase = async () => {
      const err = new Error("Pipeline crashed unexpectedly");
      err.code = "CRASH";
      throw err;
    };

    await assert.rejects(
      async () => {
        await ucService.executeQueuedUseCase({
          useCaseId: "image-generation-v1",
          input: {
            workflow_id: workflowId,
            billing_hold_id: "hold-sibling-1",
            billing_status: "reserved",
            reserved_credits: 10,
          },
          userId: "user-victim-1",
          billingHoldId: "hold-sibling-1",
        });
      },
      /Pipeline crashed unexpectedly/i
    );

    assert.strictEqual(mediaRecords.find((m) => m.id === "m-proc-1").status, "failed");
    assert.strictEqual(mediaRecords.find((m) => m.id === "m-proc-2").status, "failed");
    assert.strictEqual(mediaRecords.find((m) => m.id === "m-pend-3").status, "failed");
    assert.strictEqual(mediaRecords.find((m) => m.id === "m-succ-4").status, "completed", "Terminal completed status must not be modified");
  });

  it("TEST 3: Deadlock branch in executeOrchestration fails pending media placeholders", async () => {
    const workflowId = "wf-deadlock-1";
    const runId = "run-deadlock-1";

    mediaRecords = [
      { id: "deadlock-m-1", workflow_id: workflowId, status: "processing" },
      { id: "deadlock-m-2", workflow_id: workflowId, status: "pending" },
      { id: "deadlock-m-3", workflow_id: workflowId, status: "completed", url: "https://example.com/ok.png" },
    ];

    db.media.findByWorkflow = async (wfId) => mediaRecords.filter((m) => m.workflow_id === wfId);
    db.media.updateMedia = async (id, patch) => {
      const r = mediaRecords.find((m) => m.id === id);
      if (r) Object.assign(r, patch);
      return r;
    };

    // Plan with unresolvable circular dependency: nodeA depends on nodeB, nodeB depends on nodeA
    const plan = {
      workflow_id: workflowId,
      nodes: [
        { id: "nodeA", type: "prompt-builder" },
        { id: "nodeB", type: "prompt-builder" },
      ],
      edges: [
        { from: "nodeA", to: "nodeB" },
        { from: "nodeB", to: "nodeA" },
      ],
      outputs: {},
    };

    await runRepo.createRun({
      run_id: runId,
      workflow_id: workflowId,
      status: "running",
      input: { workflow_id: workflowId },
      execution_plan: plan,
    });

    await runRepo.createNodeRun({
      run_id: runId,
      node_id: "nodeA",
      node_type: "prompt-builder",
      status: "pending",
      attempt: 1,
    });
    await runRepo.createNodeRun({
      run_id: runId,
      node_id: "nodeB",
      node_type: "prompt-builder",
      status: "pending",
      attempt: 1,
    });

    // Run orchestration - this enters the deadlock branch because no node is running and neither can be enqueued
    await executeOrchestration(runId);

    const savedRun = await runRepo.getRun(runId);
    assert.strictEqual(savedRun?.status, "failed");
    assert.strictEqual(savedRun?.error?.code, "ORCHESTRATION_DEADLOCK");

    // On unpatched code, deadlock branch fails the run but NEVER touches media!
    const m1 = mediaRecords.find((m) => m.id === "deadlock-m-1");
    const m2 = mediaRecords.find((m) => m.id === "deadlock-m-2");
    const m3 = mediaRecords.find((m) => m.id === "deadlock-m-3");

    assert.strictEqual(m1.status, "failed", "Deadlock branch must fail processing media");
    assert.strictEqual(m2.status, "failed", "Deadlock branch must fail pending media");
    assert.strictEqual(m3.status, "completed", "Deadlock branch must NOT modify completed media");
  });

  it("TEST 4: MediaRepository.failPendingMediaByWorkflow constructs atomic SQL query with status filter", async () => {
    let capturedTable = null;
    let capturedUpdates = null;
    let capturedEq = [];
    let capturedIn = [];

    const mockSupabase = {
      from: (table) => {
        capturedTable = table;
        return {
          update: (fields) => {
            capturedUpdates = fields;
            return {
              eq: (col, val) => {
                capturedEq.push({ col, val });
                return {
                  in: (inCol, inVals) => {
                    capturedIn.push({ inCol, inVals });
                    return {
                      select: async () => ({
                        data: [{ id: "m1", status: "failed" }, { id: "m2", status: "failed" }],
                        error: null,
                      }),
                    };
                  },
                };
              },
            };
          },
        };
      },
    };

    const repo = new MediaRepository();
    repo.client = () => mockSupabase;

    const result = await repo.failPendingMediaByWorkflow("wf-atomic-1", "Generation timed out");

    assert.strictEqual(capturedTable, "media");
    assert.strictEqual(capturedUpdates.status, "failed");
    assert.strictEqual(capturedUpdates.error_message, "Generation timed out");
    assert.deepStrictEqual(capturedEq, [{ col: "workflow_id", val: "wf-atomic-1" }]);
    assert.deepStrictEqual(capturedIn, [{ inCol: "status", inVals: ["processing", "pending"] }]);
    assert.strictEqual(result.length, 2);
  });
});
