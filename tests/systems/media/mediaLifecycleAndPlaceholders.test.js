import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  NodeRegistry,
  ALL_V3_NODES,
  ExecutionEngine,
  WorkflowExecutor,
  GraphCompiler,
  SaveMediaNode,
  createDefaultV3NodeRegistry,
} from "../../../src/systems/generation/internal/v3/index.js";
import { db } from "../../../src/container.js";
import { MediaRepository, MediaWorkflowLifecycleService } from "#media/tools";
import { runReservationReaper } from "#billing/tools";

// ─── Source: mediaPersistenceFailureBoundary.test.js ───
{
describe("Media Persistence Failure Boundary Tests (V3 Nodes & Executor)", () => {
  let originalFindByWorkflow;
  let originalUpdateMedia;
  let originalCreateMedia;
  let originalUpdateCharacter;

  beforeEach(() => {
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

  it("TEST 1: SaveMediaNode throws when DB update fails (never swallows persistence failure)", async () => {
    db.media.updateMedia = async () => {
      throw new Error("Connection terminated unexpectedly during UPDATE");
    };

    await assert.rejects(
      async () => {
        await SaveMediaNode.execute(
          {
            media_id: "media-placeholder-1",
            asset_url: "https://storage.example.com/asset.png",
            final_prompt: "A cinematic portrait",
          },
          { db }
        );
      },
      (err) => {
        assert.match(err.message, /Connection terminated unexpectedly/i);
        return true;
      },
      "Expected SaveMediaNode to throw when DB update fails"
    );
  });

  it("TEST 2: WorkflowExecutor fails the run when terminal SaveMediaNode persistence fails (never marks completed)", async () => {
    const registry = createDefaultV3NodeRegistry();
    const executor = new WorkflowExecutor(registry);

    const workflow = {
      id: "wf-test-persist",
      nodes: [
        {
          id: "save_node",
          type: "base.save_media",
          inputs: {
            media_id: { fromInput: "media_id" },
            asset_url: "https://storage.example.com/generated.png",
            final_prompt: { fromInput: "prompt" },
          },
        },
      ],
    };

    db.media.updateMedia = async () => {
      throw new Error("PostgreSQL write deadlock");
    };

    await assert.rejects(
      async () => {
        await executor.execute({
          workflow,
          input: { media_id: "placeholder-999", prompt: "A cinematic portrait" },
          context: { db },
        });
      },
      (err) => {
        assert.strictEqual(err.nodeId, "save_node");
        assert.match(err.message, /PostgreSQL write deadlock/i);
        return true;
      }
    );
  });

  it("TEST 3: SaveMediaNode throws when external persistence fails", async () => {
    await assert.rejects(
      async () => {
        await SaveMediaNode.execute(
          {
            media_id: "media-char-123",
            asset_url: "https://storage.example.com/sheet.png",
            character_description: "Updated character personality description",
          },
          {
            db,
            persistExternalMedia: async () => {
              throw new Error("Storage upload failed during external media persistence");
            },
          }
        );
      },
      (err) => {
        assert.match(err.message, /Storage upload failed/i);
        return true;
      },
      "Expected SaveMediaNode to throw when persistence fails"
    );
  });

  it("TEST 4: WorkflowExecutor fails fast on single attempt without automatic retries", async () => {
    const registry = new NodeRegistry();
    registry.registerAll(ALL_V3_NODES);
    registry.register({
      type: "custom.transient_save_test",
      OUTPUT_NODE: true,
      INPUT_TYPES: {
        required: {
          media_id: { type: "STRING" },
          asset_url: { type: "STRING" },
        },
      },
      RETURN_TYPES: { saved_media: "JSON" },
      async execute(inputs, ctx) {
        return SaveMediaNode.execute(inputs, ctx);
      },
    });
    registry.freeze();

    const executor = new WorkflowExecutor(registry);
    const workflow = {
      id: "wf-test-persist-fail-fast",
      nodes: [
        {
          id: "fail_fast_node",
          type: "custom.transient_save_test",
          inputs: {
            media_id: { fromInput: "media_id" },
            asset_url: "https://storage.example.com/generated-retry.png",
          },
        },
      ],
    };

    let attemptsCount = 0;
    db.media.updateMedia = async (id, patch) => {
      attemptsCount++;
      const err = new Error("Transient connection timeout on attempt 1");
      err.retryable = true;
      throw err;
    };

    await assert.rejects(
      () =>
        executor.execute({
          workflow,
          input: { media_id: "placeholder-retry" },
          context: { db },
        }),
      /Transient connection timeout on attempt 1/
    );

    assert.strictEqual(attemptsCount, 1, "Fail-fast executor must stop after attempt 1 without retrying");
  });
});
}

// ─── Source: siblingMediaCleanupBoundary.test.js ───
{
describe("Per-Run Media Cleanup & Cycle Boundary Tests (ExecutionEngine & GraphCompiler)", () => {
  let originalFindByWorkflow;
  let originalUpdateMedia;
  let originalFailPendingMediaByWorkflow;

  let mediaRecords = [];
  let updatedCalls = [];

  beforeEach(() => {
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

  const attachMediaHook = (engine) => {
    engine.onFailure(({ input, serverContext, errorMessage }) => {
      const ids = [...new Set([
        ...(Array.isArray(serverContext?.mediaIds) ? serverContext.mediaIds : []),
        ...(Array.isArray(input?.serverMediaIds) ? input.serverMediaIds : []),
        input?.media_id,
      ].filter(Boolean))];
      for (const mediaId of ids) {
        const record = mediaRecords.find((m) => m.id === mediaId);
        if (record) Object.assign(record, { status: "failed", error_message: errorMessage });
        updatedCalls.push({ id: mediaId, status: "failed", error_message: errorMessage });
      }
    });
  };

  it("TEST 1: ExecutionEngine failure fails ONLY this run's target mediaId and leaves sibling processing/pending & completed media untouched", async () => {
    const workflowId = "wf-sibling-test-1";

    mediaRecords = [
      { id: "media-1", workflow_id: workflowId, step_id: "step-1", status: "processing" },
      { id: "media-2", workflow_id: workflowId, step_id: "step-2", status: "pending" },
      { id: "media-3", workflow_id: workflowId, step_id: "step-3", status: "processing" },
      { id: "media-4", workflow_id: workflowId, step_id: "step-4", status: "completed", url: "https://example.com/ok.png" },
    ];

    const engine = new ExecutionEngine();
    attachMediaHook(engine);

    const failingWorkflow = {
      id: "wf-sibling-v3",
      nodes: [
        {
          id: "failing_save",
          type: "base.save_media",
          inputs: {
            media_id: { fromInput: "media_id" },
            // Missing required asset_url causes validation failure
          },
        },
      ],
    };

    await assert.rejects(
      async () => {
        await engine.execute({
          workflow: failingWorkflow,
          input: {
            workflow_id: workflowId,
            serverWorkflowId: workflowId,
            media_id: "media-1",
          },
          userId: "user-sibling-1",
        });
      }
    );

    const m1 = mediaRecords.find((m) => m.id === "media-1");
    const m2 = mediaRecords.find((m) => m.id === "media-2");
    const m3 = mediaRecords.find((m) => m.id === "media-3");
    const m4 = mediaRecords.find((m) => m.id === "media-4");

    assert.strictEqual(m1.status, "failed", "media-1 (this run's target) must be failed");
    assert.strictEqual(m2.status, "pending", "sibling media-2 on shared workflow must remain untouched");
    assert.strictEqual(m3.status, "processing", "sibling media-3 on shared workflow must remain untouched");
    assert.strictEqual(m4.status, "completed", "CRITICAL: media-4 (completed) must NOT be overwritten!");
  });

  it("TEST 2: ExecutionEngine.execute failure fails ONLY this run's serverMediaIds and preserves sibling processing & completed media", async () => {
    const workflowId = "wf-sibling-usecase-1";
    mediaRecords = [
      { id: "m-proc-1", workflow_id: workflowId, status: "processing" },
      { id: "m-proc-2", workflow_id: workflowId, status: "processing" },
      { id: "m-pend-3", workflow_id: workflowId, status: "pending" },
      { id: "m-succ-4", workflow_id: workflowId, status: "completed", url: "https://example.com/done.png" },
    ];

    const engine = new ExecutionEngine();
    attachMediaHook(engine);

    engine.executor = {
      execute: async () => {
        const err = new Error("Pipeline crashed unexpectedly");
        err.code = "CRASH";
        throw err;
      },
    };

    await assert.rejects(
      async () => {
        await engine.execute({
          useCaseId: "image-generation-v3",
          input: {
            workflow_id: workflowId,
            media_id: "m-proc-1",
            serverMediaIds: ["m-proc-1"],
          },
          userId: "user-victim-1",
        });
      },
      /Pipeline crashed unexpectedly/i
    );

    assert.strictEqual(mediaRecords.find((m) => m.id === "m-proc-1").status, "failed");
    assert.strictEqual(mediaRecords.find((m) => m.id === "m-proc-2").status, "processing", "Sibling execution media must not be wiped");
    assert.strictEqual(mediaRecords.find((m) => m.id === "m-pend-3").status, "pending", "Sibling pending media must not be wiped");
    assert.strictEqual(mediaRecords.find((m) => m.id === "m-succ-4").status, "completed", "Terminal completed status must not be modified");
  });

  it("TEST 3: GraphCompiler cycle detection in ExecutionEngine fails this run's placeholder media via onFailure hook", async () => {
    const workflowId = "wf-deadlock-1";

    mediaRecords = [
      { id: "deadlock-m-1", workflow_id: workflowId, status: "processing" },
      { id: "deadlock-m-2", workflow_id: workflowId, status: "pending" },
      { id: "deadlock-m-3", workflow_id: workflowId, status: "completed", url: "https://example.com/ok.png" },
    ];

    let hookFired = false;
    const engine = new ExecutionEngine();
    attachMediaHook(engine);
    engine.onFailure(() => {
      hookFired = true;
    });

    const cyclicWorkflow = {
      id: "wf-cyclic-v3",
      nodes: [
        {
          id: "nodeA",
          type: "base.resolve_references",
          inputs: {
            prompt: { fromNode: "nodeB", output: "prepared_prompt" },
          },
        },
        {
          id: "nodeB",
          type: "base.resolve_references",
          inputs: {
            prompt: { fromNode: "nodeA", output: "prepared_prompt" },
          },
        },
        {
          id: "save",
          type: "base.save_media",
          inputs: {
            media_id: "deadlock-m-1",
            asset_url: "https://example.com/out.png",
            final_prompt: { fromNode: "nodeA", output: "prepared_prompt" },
          },
        },
      ],
    };

    await assert.rejects(
      async () => {
        await engine.execute({
          workflow: cyclicWorkflow,
          input: {
            workflow_id: workflowId,
            serverWorkflowId: workflowId,
            media_id: "deadlock-m-1",
          },
          userId: "user-deadlock-1",
        });
      },
      /Circular dependency/i
    );

    assert.strictEqual(hookFired, true, "onFailure hook must fire on cyclic graph failure");

    const m1 = mediaRecords.find((m) => m.id === "deadlock-m-1");
    const m2 = mediaRecords.find((m) => m.id === "deadlock-m-2");
    const m3 = mediaRecords.find((m) => m.id === "deadlock-m-3");

    assert.strictEqual(m1.status, "failed", "Cyclic graph failure must fail this run's target media");
    assert.strictEqual(m2.status, "pending", "Sibling pending media on shared workflow must stay isolated");
    assert.strictEqual(m3.status, "completed", "Cyclic graph failure must NOT modify completed media");
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
        findStalePlaceholders: async () => [
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
