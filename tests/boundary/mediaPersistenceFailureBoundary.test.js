import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { executeNodeJob, executeNodePersistence } from "../../src/v2/runner/nodeExecutor.js";
import { RunRepository } from "../../src/v2/runner/runRepository.js";
import { startWorkflowRun } from "../../src/v2/runner/workflowRunner.js";
import { db } from "../../src/container.js";

describe("Media Persistence Failure Boundary Tests (Task T7 / BUG-02)", () => {
  let runRepo;
  let originalFindByWorkflow;
  let originalUpdateMedia;
  let originalCreateMedia;
  let originalUpdateCharacter;

  after(() => {
    setTimeout(() => process.exit(0), 100);
  });

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
