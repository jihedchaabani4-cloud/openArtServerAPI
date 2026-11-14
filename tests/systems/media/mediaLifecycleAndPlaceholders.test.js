import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { executeNodeJob, executeNodePersistence, RunRepository, startWorkflowRun, executeOrchestration, UseCaseService } from "#generation/tools";
import { db } from "../../../src/container.js";
import { MediaRepository, MediaWorkflowLifecycleService } from "#media/tools";
import { runReservationReaper } from "#billing/tools";

// ─── Source: mediaPersistenceFailureBoundary.test.js ───
{
describe("Media Persistence Failure Boundary Tests (Task T7 / BUG-02)", () => {
  let runRepo;
  let originalFindByWorkflow;
  let originalUpdateMedia;
  let originalCreateMedia;
  let originalUpdateCharacter;


  beforeEach(() => {
    runRepo = new RunRepository();
    originalFindByWorkflow = db.media?.findByWorkflow;
    originalUpdateMedia = db.media?.updateMedia;
    originalCreateMedia = db.media?.createMedia;
    originalUpdateCharacter = db.characters?.updateCharacter;
  });

  afterEach(() => {
    if (db.media) {
      db.media.findByWorkflow = originalFindByWorkflow;
      db.media.updateMedia = originalUpdateMedia;
      db.media.createMedia = originalCreateMedia;
    }
    if (db.characters) {
      db.characters.updateCharacter = originalUpdateCharacter;
    }
  });

  it("TEST 1: executeNodePersistence must throw normalized PERSISTENCE_FAILED when DB update fails", async () => {
    // Inject DB failure into updateMedia
    db.media.findByWorkflow = async () => [
      { id: "media-placeholder-1", step_id: "image_generation", status: "processing" },
    ];
    db.media.updateMedia = async () => {
      throw new Error("Connection terminated unexpectedly during UPDATE");
    };

    const nodeConfig = {
      id: "gen_node",
      type: "image-generation",
      persist: {
        target: "media",
        step_id: "image_generation",
        value: "$outputs.assets[0].url",
      },
    };
    const output = { assets: [{ url: "https://storage.example.com/asset.png" }] };
    const run = {
      run_id: "run-test-persist-1",
      targetWorkflowId: "wf-persist-1",
      targetMediaIds: ["media-placeholder-1"],
      input: { workflow_id: "wf-persist-1", media_id: "media-placeholder-1" },
    };

    // On unpatched code, executeNodePersistence catches and swallows the error (returns void without throwing)
    await assert.rejects(
      async () => {
        await executeNodePersistence({ nodeConfig, output, run });
      },
      (err) => {
        assert.strictEqual(err.code, "PERSISTENCE_FAILED");
        assert.strictEqual(err.category, "SERVER_FAULT");
        assert.match(err.message, /persistence failed/i);
        return true;
      },
      "Expected executeNodePersistence to throw normalized PERSISTENCE_FAILED error when DB update fails"
    );
  });

  it("TEST 2: executeNodeJob marks node as failed when persistence fails (never marks completed)", async () => {
    const runId = "run-test-persist-nodejob";
    const nodeId = "gen_node";

    // Setup run and node in runRepo
    const plan = {
      workflow_id: "wf-test-persist",
      nodes: [
        {
          id: nodeId,
          type: "prompt-builder",
          inputs: {
            prompt: "${input.prompt}",
          },
          persist: {
            target: "media",
            step_id: "prompt_media",
            value: "https://storage.example.com/generated.png",
          },
          retry_policy: { max_attempts: 1 },
        },
      ],
      edges: [],
      outputs: {},
    };

    await runRepo.createRun({
      run_id: runId,
      workflow_id: "wf-test-persist",
      status: "running",
      v1_workflow_id: "wf-test-persist",
      target_media_ids: ["placeholder-999"],
      input: { workflow_id: "wf-test-persist", media_id: "placeholder-999", prompt: "A cinematic portrait" },
      execution_plan: plan,
    });

    await runRepo.createNodeRun({
      run_id: runId,
      node_id: nodeId,
      node_type: "prompt-builder",
      status: "pending",
      attempt: 1,
    });

    // Simulate DB failure when attempting to persist media
    db.media.findByWorkflow = async () => [
      { id: "placeholder-999", step_id: "prompt_media", status: "processing" },
    ];
    db.media.updateMedia = async () => {
      throw new Error("PostgreSQL write deadlock");
    };

    await executeNodeJob(runId, nodeId);

    const nodeRun = await runRepo.getNodeRun(runId, nodeId);

    // On unpatched code, nodeRun.status is "completed" because persistence failure was swallowed!
    assert.strictEqual(
      nodeRun.status,
      "failed",
      "CRITICAL: Node run must be marked 'failed' when persistence fails, NOT 'completed'!"
    );
    assert.strictEqual(
      nodeRun.error?.code,
      "PERSISTENCE_FAILED",
      "Node error code must be PERSISTENCE_FAILED"
    );
  });

  it("TEST 3: executeNodePersistence throws when target character update fails", async () => {
    db.characters.updateCharacter = async () => {
      throw new Error("Character row locked by another transaction");
    };

    const nodeConfig = {
      id: "llm_enrich",
      type: "llm",
      persist: {
        target: "character",
        field: "description",
        value: "$output.text",
      },
    };
    const output = { text: "Updated character personality description" };
    const run = {
      run_id: "run-test-char-persist",
      input: { characterId: "char-123", workflow_id: "char-123" },
    };

    await assert.rejects(
      async () => {
        await executeNodePersistence({ nodeConfig, output, run });
      },
      (err) => {
        assert.strictEqual(err.code, "PERSISTENCE_FAILED");
        assert.strictEqual(err.category, "SERVER_FAULT");
        return true;
      },
      "Expected executeNodePersistence to throw when character persistence fails"
    );
  });

  it("TEST 4: executeNodeJob retries transient persistence failure when retry_policy allows", async () => {
    const runId = "run-test-persist-retry";
    const nodeId = "retry_node";

    const plan = {
      workflow_id: "wf-test-persist-retry",
      nodes: [
        {
          id: nodeId,
          type: "prompt-builder",
          inputs: {
            prompt: "${input.prompt}",
          },
          persist: {
            target: "media",
            step_id: "prompt_media",
            value: "https://storage.example.com/generated-retry.png",
          },
          retry_policy: { max_attempts: 2 },
        },
      ],
      edges: [],
      outputs: {},
    };

    await runRepo.createRun({
      run_id: runId,
      workflow_id: "wf-test-persist-retry",
      status: "running",
      v1_workflow_id: "wf-test-persist-retry",
      target_media_ids: ["placeholder-retry"],
      input: { workflow_id: "wf-test-persist-retry", media_id: "placeholder-retry", prompt: "Retry test prompt" },
      execution_plan: plan,
    });

    await runRepo.createNodeRun({
      run_id: runId,
      node_id: nodeId,
      node_type: "prompt-builder",
      status: "pending",
      attempt: 1,
    });

    let attemptsCount = 0;
    db.media.findByWorkflow = async () => [
      { id: "placeholder-retry", step_id: "prompt_media", status: "processing" },
    ];
    db.media.updateMedia = async (id, patch) => {
      attemptsCount++;
      if (attemptsCount === 1) {
        throw new Error("Transient connection timeout on attempt 1");
      }
      return { id, ...patch };
    };

    await executeNodeJob(runId, nodeId);

    const finalNodeRun = await runRepo.getNodeRun(runId, nodeId);
    assert.strictEqual(attemptsCount, 2, "Persistence should have been retried on attempt 2");
    assert.strictEqual(finalNodeRun.attempt, 2, "Final attempt count should be 2");
    assert.strictEqual(finalNodeRun.status, "completed", "Node should succeed after retry");
  });
});
}

// ─── Source: siblingMediaCleanupBoundary.test.js ───
{
describe("Sibling Media Cleanup & Deadlock Boundary Tests (Task T8 / BUG-08)", () => {
  let runRepo;
  let originalFindByWorkflow;
  let originalUpdateMedia;
  let originalFailPendingMediaByWorkflow;

  let mediaRecords = [];
  let updatedCalls = [];


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
      v1_workflow_id: workflowId,
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
    const capturedTables = [];
    let capturedUpdates = null;
    let capturedEq = [];
    let capturedIn = [];

    const mockSupabase = {
      from: (table) => {
        capturedTables.push(table);
        if (table === "workflow_media") {
          return {
            select: () => ({
              eq: async (col, val) => {
                capturedEq.push({ col, val });
                return {
                  data: [{ media_id: "m1" }, { media_id: "m2" }],
                  error: null,
                };
              },
            }),
          };
        }
        return {
          update: (fields) => {
            capturedUpdates = fields;
            const chain = {
              in: (inCol, inVals) => {
                capturedIn.push({ inCol, inVals });
                return chain;
              },
              select: async () => ({
                data: [{ id: "m1", status: "failed" }, { id: "m2", status: "failed" }],
                error: null,
              }),
            };
            return chain;
          },
        };
      },
    };

    const repo = new MediaRepository();
    repo.client = () => mockSupabase;

    const result = await repo.failPendingMediaByWorkflow("wf-atomic-1", "Generation timed out");

    assert.deepStrictEqual(capturedTables, ["workflow_media", "media"]);
    assert.strictEqual(capturedUpdates.status, "failed");
    assert.strictEqual(capturedUpdates.error_message, "Generation timed out");
    assert.deepStrictEqual(capturedEq, [{ col: "workflow_id", val: "wf-atomic-1" }]);
    assert.deepStrictEqual(capturedIn, [
      { inCol: "id", inVals: ["m1", "m2"] },
      { inCol: "status", inVals: ["processing", "pending"] },
    ]);
    assert.strictEqual(result.length, 2);
  });
});
}

// ─── Source: staleProcessingMediaReaper.test.js ───
{
describe("Ticket 05: Stale processing media reaper", () => {
  it("MediaWorkflowLifecycleService.sweepStalePlaceholders sweeps placeholders older than cutoff", async () => {
    const updatedMedia = [];
    const mockDb = {
      media: {
        findStalePlaceholders: async (cutoff) => [
          { id: "m-stale-1", status: "processing", create_time: "2026-01-01T00:00:00Z" },
          { id: "m-stale-2", status: "processing", create_time: "2026-01-01T01:00:00Z" },
        ],
        updateFields: async (id, fields) => {
          updatedMedia.push({ id, fields });
          return { id, ...fields };
        },
      },
    };

    const service = new MediaWorkflowLifecycleService({ db: mockDb });
    const swept = await service.sweepStalePlaceholders({ maxAgeMinutes: 30 });

    assert.equal(swept, 2, "Should sweep 2 stale placeholders");
    assert.equal(updatedMedia.length, 2);
    assert.equal(updatedMedia[0].id, "m-stale-1");
    assert.equal(updatedMedia[0].fields.status, "failed");
    assert.match(updatedMedia[0].fields.error_message, /timed out/i);
  });

  it("runReservationReaper invokes sweepStalePlaceholders when available", async () => {
    let sweepCalled = false;
    const mockWallet = {
      reapExpiredHolds: async () => [],
    };
    const mockLifecycle = {
      failForExpiredHold: async () => true,
      sweepStalePlaceholders: async () => {
        sweepCalled = true;
        return 1;
      },
    };

    await runReservationReaper({
      walletService: mockWallet,
      lifecycleService: mockLifecycle,
    });

    assert.equal(sweepCalled, true, "runReservationReaper must call sweepStalePlaceholders");
  });
});
}
after(() => {
  setTimeout(() => process.exit(0), 100);
});
