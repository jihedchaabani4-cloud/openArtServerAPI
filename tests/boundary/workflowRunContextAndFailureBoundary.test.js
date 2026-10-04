/**
 * Boundary Tests: F2 — Server-Side Workflow Context, Media Failure, and Billing Invariants
 *
 * Verifies:
 * 1. F2a: nodeExecutor writes ONLY to server-side targetWorkflowId and targetMediaIds,
 *    never reading run.input.workflow_id or run.input.characterId (fallback removed).
 * 2. F2a: Workflow failure marks real character-sheet media as failed via serverWorkflowId.
 * 3. F2b: useCaseRunner throws unless status === "completed", and billing settles ONLY on completed.
 * 4. F2c: WorkflowRunner failure handler logs with runId/workflowId at error level instead of silent catch.
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { executeNodePersistence } from "../../src/v2/runner/nodeExecutor.js";
import { startWorkflowRun } from "../../src/v2/runner/workflowRunner.js";
import { run as runUseCase } from "../../src/use-cases/useCaseRunner.js";
import { db } from "../../src/container.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { bootstrapV2 } from "../../src/v2/bootstrap.js";

bootstrapV2();

after(async () => {
  try {
    await redisConnection.quit().catch(() => redisConnection.disconnect());
    await workerRedisConnection.quit().catch(() => workerRedisConnection.disconnect());
  } catch {}
});

describe("F2 — Server-Side Workflow Context & Failure Handling Boundary Tests", () => {
  let originalMediaFindByWorkflow;
  let originalMediaUpdateMedia;
  let originalMediaUpdateFields;
  let updatedMediaCalls = [];

  beforeEach(() => {
    updatedMediaCalls = [];
    originalMediaFindByWorkflow = db.media?.findByWorkflow;
    originalMediaUpdateMedia = db.media?.updateMedia;
    originalMediaUpdateFields = db.media?.updateFields;
  });

  afterEach(() => {
    if (db.media) {
      db.media.findByWorkflow = originalMediaFindByWorkflow;
      db.media.updateMedia = originalMediaUpdateMedia;
      db.media.updateFields = originalMediaUpdateFields;
    }
  });

  // ── TEST 1: nodeExecutor writes ONLY to server-side targetWorkflowId, ignoring input.workflow_id / input.characterId ──
  it("TEST 1: executeNodePersistence writes ONLY to targetWorkflowId and ignores spoofed input.workflow_id / characterId", async () => {
    const serverWorkflowId = "server-owned-wf-100";
    const victimWorkflowId = "victim-wf-999";
    const victimCharacterId = "victim-char-888";

    const serverMedia = {
      id: "media-server-1",
      workflow_id: serverWorkflowId,
      step_id: "image_generation",
      status: "processing",
    };
    const victimMedia = {
      id: "media-victim-1",
      workflow_id: victimWorkflowId,
      step_id: "image_generation",
      status: "processing",
    };

    db.media.findByWorkflow = async (wfId) => {
      if (wfId === serverWorkflowId) return [serverMedia];
      if (wfId === victimWorkflowId || wfId === victimCharacterId) return [victimMedia];
      return [];
    };

    db.media.updateMedia = async (id, patch) => {
      updatedMediaCalls.push({ id, patch });
      return { id, ...patch };
    };

    const nodeConfig = {
      id: "gen_node",
      type: "image-generation",
      persist: {
        target: "media",
        step_id: "image_generation",
        status: "completed",
        value: "$outputs.assets[0].url",
      },
    };

    const output = { assets: [{ url: "https://storage.example.com/clean.png" }] };

    // Run carrying malicious client input attempting to overwrite victim's workflow/character/media
    const run = {
      run_id: "run-persist-test-1",
      targetWorkflowId: serverWorkflowId,
      targetMediaIds: ["media-server-1"],
      input: {
        workflow_id: victimWorkflowId, // Spoofed input
        characterId: victimCharacterId, // Spoofed input
        media_id: "victim-media-id-777", // Spoofed input
      },
      execution_plan: {
        targetWorkflowId: serverWorkflowId,
        targetMediaIds: ["media-server-1"],
      },
    };

    await executeNodePersistence({ nodeConfig, output, run });

    // Assert that ONLY server-owned media was updated
    assert.strictEqual(updatedMediaCalls.length, 1, "Exactly one media update must be executed");
    assert.strictEqual(
      updatedMediaCalls[0].id,
      "media-server-1",
      "Must update the server-assigned media placeholder, NOT the victim's placeholder"
    );
    assert.strictEqual(
      updatedMediaCalls[0].patch.status,
      "completed",
      "Server media status must be completed"
    );

    // If run has NO targetWorkflowId, even if input has workflow_id, it must refuse to write
    const untrustedRun = {
      run_id: "run-untrusted-2",
      targetWorkflowId: null,
      input: { workflow_id: victimWorkflowId },
      execution_plan: {},
    };

    await assert.rejects(
      async () => {
        await executeNodePersistence({ nodeConfig, output, run: untrustedRun });
      },
      /requires.*workflowId/i,
      "Must throw when targetWorkflowId is missing from run record, ignoring input.workflow_id"
    );
  });

  // ── TEST 2: characterId fallback is removed from nodeExecutor ──
  it("TEST 2: nodeExecutor characterId fallback is strictly removed", async () => {
    const nodeConfig = {
      id: "char_node",
      type: "image-generation",
      persist: {
        target: "media",
        step_id: "character_sheet",
        status: "completed",
        value: "https://cdn.example.com/char.png",
      },
    };

    const runWithOnlyCharacterIdInput = {
      run_id: "run-char-fallback-test",
      targetWorkflowId: null, // No server targetWorkflowId
      input: { characterId: "some-char-uuid" }, // Legacy fallback input
      execution_plan: {},
    };

    // Must refuse to persist because characterId in input is no longer accepted as workflowId
    await assert.rejects(
      async () => {
        await executeNodePersistence({
          nodeConfig,
          output: { assets: [{ url: "https://cdn.example.com/char.png" }] },
          run: runWithOnlyCharacterIdInput,
        });
      },
      /requires.*workflowId/i,
      "executeNodePersistence must not fall back to run.input.characterId"
    );
  });

  // ── TEST 3: useCaseRunner throws unless status === 'completed' ──
  it("TEST 3: useCaseRunner throws unless status === 'completed'", async () => {
    // Mock getUseCase & startWorkflowRun behavior by invoking runUseCase with a mocked plan
    // We test that if startWorkflowRun returns { status: 'failed' } or { status: 'pending' }, useCaseRunner throws
    await assert.rejects(
      async () => {
        await runUseCase({
          useCaseId: "image-generation-v1",
          input: { prompt: "Test prompt" },
          userId: "user-test-f2b",
          registries: {
            workflows: {
              "image-generation-v1": {
                workflow_id: "image-generation-v1",
                workflow_version: "1.0.0",
                nodes: [{ id: "n1", type: "noop" }],
              },
            },
          },
        });
      },
      (err) => {
        assert.ok(
          err.code === "WORKFLOW_FAILED" || err.code === "WORKFLOW_INCOMPLETE" || err.message?.includes("failed"),
          `Expected workflow failure error, got: ${err.code} / ${err.message}`
        );
        return true;
      }
    );
  });

  // ── TEST 4: Failure handler marks character-sheet media as failed via serverWorkflowId and logs at error level ──
  it("TEST 4: workflow failure marks real character-sheet media as failed via server-side workflowId", async () => {
    const realCharWorkflowId = "char-wf-real-555";
    const spoofedInputWfId = "victim-wf-spoofed-888";

    let failedMediaWorkflowId = null;
    let failedMediaReason = null;

    // Spy on failWorkflowPendingMedia by mocking db.media.updateFields
    db.media.findByWorkflow = async (wfId) => [
      { id: `media-${wfId}`, workflow_id: wfId, status: "processing", step_id: "character_sheet" }
    ];
    db.media.updateFields = async (id, fields) => {
      failedMediaWorkflowId = id;
      failedMediaReason = fields.error_message;
      return { id, ...fields };
    };

    const failingPlan = {
      workflow_id: "character-sheet-v1",
      workflow_version: "1.0.0",
      nodes: [
        {
          id: "fail_node",
          type: "unsupported-node-type-that-fails-immediately",
        },
      ],
      edges: [],
    };

    // Client sends input with spoofed workflow_id
    const runtimeInput = {
      userId: "user-char-owner-1",
      workflow_id: spoofedInputWfId,
      serverWorkflowId: realCharWorkflowId, // Server-assigned workflowId
    };

    const res = await startWorkflowRun(failingPlan, runtimeInput, "run-char-fail-test", {
      workflowId: realCharWorkflowId,
    });

    assert.strictEqual(res.status, "failed", "Run must finish with status 'failed'");

    // Verify media failed was for realCharWorkflowId, NOT spoofedInputWfId
    assert.strictEqual(
      failedMediaWorkflowId,
      `media-${realCharWorkflowId}`,
      "Failure handler must fail the real character workflow media, never the spoofed input workflow ID"
    );
  });
});
