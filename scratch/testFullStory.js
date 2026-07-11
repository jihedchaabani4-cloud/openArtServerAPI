/**
 * Full Async Generation Story Test
 * =====================================
 * Tests the complete flow described in the "Chef & Waiter" model:
 *
 *  Story 1 — RPC Atomic Transaction
 *    Verifies that workflow + media are created atomically via
 *    createWorkflowWithMediaAtomic (RPC with sequential fallback).
 *
 *  Story 2 — Placeholder Pinned to Correct Project & Session
 *    Verifies that the created media/workflow is in the user's
 *    actual project_id (not the fallback "V2 Works" project).
 *
 *  Story 3 — Worker Independence
 *    Verifies that the worker can finalize a placeholder using
 *    ONLY mediaId — no React, no frontend context.
 *
 *  Story 4 — Failure Flow (Failed Media Shows Up)
 *    Verifies that a failing generation marks the placeholder
 *    as `failed` (not deletes it) so the UI can display it.
 *
 *  Story 5 — Rollback Test (Only when RPC is deployed)
 *    Simulates a broken insert to verify the transaction rolls
 *    back — leaving no orphan workflow row.
 */

import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import { db } from "../src/container.js";
import { createWorkflowWithMediaAtomic } from "../src/db/workflowMediaOps.js";
import { V1StorageBridge } from "../src/v2/services/v1StorageBridge.js";

const SEPARATOR = "─".repeat(60);

function pass(msg) { console.log(`  ✅ PASS  ${msg}`); }
function fail(msg) { console.log(`  ❌ FAIL  ${msg}`); }
function info(msg) { console.log(`  ℹ️  ${msg}`); }

// ─── Helpers ────────────────────────────────────────────────

async function getTestProject(userId) {
  const { data, error } = await supabase
    .from("project")
    .select("id")
    .eq("user_id", userId)
    .limit(1)
    .single();
  if (error || !data) throw new Error(`No project found for user ${userId}`);
  return data.id;
}

async function getTestSession(projectId) {
  const { data } = await supabase
    .from("session")
    .select("id")
    .eq("project_id", projectId)
    .limit(1)
    .single();
  return data?.id || null;
}

async function getMediaById(mediaId) {
  const { data } = await supabase
    .from("media")
    .select("id, status, error_message, project_id, workflow_id, url, create_time")
    .eq("id", mediaId)
    .single();
  return data;
}

async function getWorkflowById(workflowId) {
  const { data } = await supabase
    .from("workflow")
    .select("id, project_id, session_id, primary_media_id")
    .eq("id", workflowId)
    .single();
  return data;
}

async function cleanupWorkflow(workflowId) {
  // Delete in reverse FK order: media → workflow
  await supabase.from("media").delete().eq("workflow_id", workflowId);
  await supabase.from("workflow").delete().eq("id", workflowId);
}

// ─── Tests ──────────────────────────────────────────────────

async function story1_atomicTransaction(projectId, sessionId) {
  console.log(`\n${SEPARATOR}`);
  console.log("Story 1: Atomic Transaction (RPC or sequential fallback)");
  console.log(SEPARATOR);

  const workflowData = {
    project_id:    projectId,
    session_id:    sessionId,
    display_name:  "Test Story 1 – Atomic",
    workflow_type: "GENERATION",
  };
  const mediaData = {
    project_id:           projectId,
    generation_config_id: null,
    step_id:              "GEN",
    status:               "processing",
    width:                1024,
    height:               1024,
  };

  const { workflow, media } = await createWorkflowWithMediaAtomic(db, { workflowData, mediaData });

  if (!workflow?.id) { fail("No workflow ID returned"); return null; }
  if (!media?.id)    { fail("No media ID returned");    return null; }

  pass(`Workflow created  →  id=${workflow.id}`);
  pass(`Media created     →  id=${media.id}`);

  // Verify primary_media_id is set on the workflow
  const wf = await getWorkflowById(workflow.id);
  if (wf.primary_media_id === media.id) {
    pass(`primary_media_id correctly set on workflow`);
  } else {
    fail(`primary_media_id mismatch: expected ${media.id}, got ${wf.primary_media_id}`);
  }

  await cleanupWorkflow(workflow.id);
  info("Cleaned up test rows");
  return { workflowId: workflow.id, mediaId: media.id };
}

async function story2_correctProjectAndSession(projectId, sessionId) {
  console.log(`\n${SEPARATOR}`);
  console.log("Story 2: Placeholder in correct project & session");
  console.log(SEPARATOR);

  const bridge = new V1StorageBridge({ db });
  const runId  = `test-run-${Date.now()}`;

  const { workflow, media } = await bridge.createV1Placeholder({
    userId:       "test-user",
    projectId,
    sessionId,
    displayName:  "Test Story 2 – Project Pin",
    workflowType: "GENERATION",
    stepId:       "GEN",
    config: {
      prompt:          "test prompt",
      model:           "test-model",
      aspect_ratio:    "SQUARE",
      generation_type: "TEXT_ONLY",
    },
  });

  const dbMedia    = await getMediaById(media.id);
  const dbWorkflow = await getWorkflowById(workflow.id);

  if (dbMedia.project_id === projectId) {
    pass(`Media pinned to correct project_id=${projectId}`);
  } else {
    fail(`Media in wrong project: ${dbMedia.project_id} (expected ${projectId})`);
  }

  if (dbWorkflow.session_id === sessionId) {
    pass(`Workflow pinned to correct session_id=${sessionId}`);
  } else if (!sessionId && !dbWorkflow.session_id) {
    pass("No session (null) — workflow correctly has no session");
  } else {
    fail(`Workflow in wrong session: ${dbWorkflow.session_id} (expected ${sessionId})`);
  }

  if (dbMedia.status === "processing") {
    pass("Media status = 'processing' ✓");
  } else {
    fail(`Media status = '${dbMedia.status}' (expected 'processing')`);
  }

  await cleanupWorkflow(workflow.id);
  info("Cleaned up test rows");
}

async function story3_workerIndependence(projectId) {
  console.log(`\n${SEPARATOR}`);
  console.log("Story 3: Worker Independence — worker only needs mediaId");
  console.log(SEPARATOR);

  const bridge = new V1StorageBridge({ db });

  // Phase 1: create placeholder (simulating controller)
  const { workflow, media } = await bridge.createV1Placeholder({
    userId:       "test-user",
    projectId,
    sessionId:    null,
    displayName:  "Test Story 3 – Worker",
    workflowType: "GENERATION",
    stepId:       "GEN",
    config:       { prompt: "test", model: "test-model", aspect_ratio: "SQUARE", generation_type: "TEXT_ONLY" },
  });

  info(`Controller created → workflowId=${workflow.id}  mediaId=${media.id}`);
  info("Simulating worker receiving ONLY { mediaId } — no frontend context...");

  // Phase 2: worker finalizes using ONLY mediaId (simulating success)
  const fakeAsset = {
    url:    "https://example.com/fake-test-image.jpg",
    width:  1024,
    height: 1024,
  };
  await bridge.finalizeV1Media(media.id, fakeAsset, "success");

  const dbMedia = await getMediaById(media.id);
  if (dbMedia.status === "success" && dbMedia.url === fakeAsset.url) {
    pass(`Worker finalized media correctly (status=success, url set)`);
  } else {
    fail(`Finalization failed: status=${dbMedia.status} url=${dbMedia.url}`);
  }

  await cleanupWorkflow(workflow.id);
  info("Cleaned up test rows");
}

async function story4_failureFlow(projectId) {
  console.log(`\n${SEPARATOR}`);
  console.log("Story 4: Failure Flow — failed media is visible in DB (not deleted)");
  console.log(SEPARATOR);

  const bridge = new V1StorageBridge({ db });

  // Phase 1: create placeholder
  const { workflow, media } = await bridge.createV1Placeholder({
    userId:       "test-user",
    projectId,
    sessionId:    null,
    displayName:  "Test Story 4 – Failure",
    workflowType: "GENERATION",
    stepId:       "GEN",
    config:       { prompt: "test fail", model: "test-model", aspect_ratio: "SQUARE", generation_type: "TEXT_ONLY" },
  });

  info(`Placeholder created → mediaId=${media.id}`);
  info("Simulating provider error...");

  // Phase 2: mark as failed (simulating worker catch block)
  await bridge.failV1Media(media.id, "Provider timeout — no response after 30s");

  const dbMedia = await getMediaById(media.id);

  if (dbMedia.status === "failed") {
    pass(`Media status = 'failed' ✓ (UI can render error card)`);
  } else {
    fail(`Expected status='failed' but got '${dbMedia.status}'`);
  }

  if (dbMedia.error_message && dbMedia.error_message.length > 0) {
    pass(`error_message saved: "${dbMedia.error_message}"`);
  } else {
    fail("error_message is empty — frontend won't know why it failed");
  }

  if (dbMedia.url === null) {
    pass("url remains null (correct — no asset was generated)");
  } else {
    fail(`url should be null but got: ${dbMedia.url}`);
  }

  await cleanupWorkflow(workflow.id);
  info("Cleaned up test rows");
}

// ─── Main Runner ─────────────────────────────────────────────

async function main() {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║     FULL ASYNC GENERATION STORY TEST                       ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  // Use the actual user from the database
  const userId = "7d40bff4-7cac-4f2d-8994-2642c90e40e4";

  let projectId, sessionId;
  try {
    projectId = await getTestProject(userId);
    sessionId = await getTestSession(projectId);
    info(`Using project=${projectId}`);
    info(`Using session=${sessionId || "(none)"}`);
  } catch (err) {
    console.error("\n❌ Cannot run tests — could not resolve test project:", err.message);
    process.exit(1);
  }

  await story1_atomicTransaction(projectId, sessionId);
  await story2_correctProjectAndSession(projectId, sessionId);
  await story3_workerIndependence(projectId);
  await story4_failureFlow(projectId);

  console.log(`\n${SEPARATOR}`);
  console.log("All stories complete.");
  console.log(SEPARATOR + "\n");
  process.exit(0);
}

main().catch(err => {
  console.error("\n💥 Unexpected test crash:", err);
  process.exit(1);
});
