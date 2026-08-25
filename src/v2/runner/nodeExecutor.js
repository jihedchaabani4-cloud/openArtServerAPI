import { parseBinding } from "../compiler/validateBindings.js";
import { RunRepository } from "./runRepository.js";
import { executeNode } from "../nodes/index.js";
import {
  reserveNodeBilling,
  settleNodeBilling,
  rollbackNodeBilling,
  isProviderBackedNodeType,
  getGateways,
} from "./workflowRunner.js";
import { jobQueueService } from "../../services/jobQueueService.js";
import { db } from "../../container.js";
import { logV2Event } from "../logging/v2Logger.js";
import { nodeFailure, nodeSuccess } from "../runtime/nodeEnvelope.js";

const runRepo = new RunRepository();

/**
 * Executes declarative node-level persistence from YAML (target: "character" | "media")
 */
export async function executeNodePersistence({ nodeConfig, output, run, resolvedInputs = {} }) {
  if (!nodeConfig?.persist) return;

  const { target, step_id, field, value, status = "completed" } = nodeConfig.persist;
  const workflowId = run.input?.workflow_id || run.input?.characterId;
  const projectId = run.input?.project_id || run.input?.projectId;

  const resolvedValue = typeof value === "string" && value.startsWith("$output")
    ? getValueAtPath(output, value.replace(/^\$outputs?\./, ""))
    : value;

  try {
    if (target === "character" && workflowId && field) {
      console.log(`💾 [Persistence] Updating character ${workflowId} field "${field}"`);
      await db.characters.updateCharacter(workflowId, { [field]: resolvedValue }).catch(() => null);
    } else if (target === "media" && workflowId) {
      const mediaUrl = typeof resolvedValue === "string" ? resolvedValue : (resolvedValue?.url || output?.assets?.[0]?.url || output?.media?.url);
      if (mediaUrl) {
        const targetStepId = step_id || "character_sheet";
        console.log(`💾 [Persistence] Updating media for workflow ${workflowId} (step_id: ${targetStepId}) to completed`);

        // Find existing processing media placeholder created by createCharacter
        const existingList = await db.media.findByWorkflow(workflowId).catch(() => []);
        const placeholder = existingList?.find((m) => m.step_id === targetStepId || m.status === "processing" || m.status === "pending");

        const width = output?.assets?.[0]?.width || resolvedInputs?.width || nodeConfig?.config?.width || 1344;
        const height = output?.assets?.[0]?.height || resolvedInputs?.height || nodeConfig?.config?.height || 768;

        if (placeholder?.id) {
          await db.media.updateMedia(placeholder.id, {
            url: mediaUrl,
            status: status || "completed",
            width,
            height,
          }).catch((err) => console.warn(`[Persistence] Failed to update media placeholder:`, err.message));
        } else {
          await db.media.createMedia({
            workflow_id: workflowId,
            project_id: projectId,
            step_id: targetStepId,
            url: mediaUrl,
            status: status || "completed",
            width,
            height,
          }).catch((err) => console.warn(`[Persistence] Failed to create media fallback:`, err.message));
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️ [Persistence] Notice for node ${nodeConfig.id}:`, err.message);
  }
}

/**
 * Safely extracts nested properties using dot notation paths.
 */
export function getValueAtPath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = path.split(".");
  let curr = obj;
  for (const part of parts) {
    if (curr === undefined || curr === null) return undefined;
    curr = curr[part];
  }
  return curr;
}

/**
 * Resolves input expressions for a node based on workflow inputs and dependency outputs.
 * Combines compiled static resolved_inputs and dynamic bindings expressions.
 */
export async function resolveInputsForNode(run, nodeConfig, nodeRuns) {
  const resolved = { ...(nodeConfig.resolved_inputs || {}) };
  const inputsToResolve = {
    ...(nodeConfig.user_inputs || {}),
    ...(nodeConfig.inputs || {}),
    ...(nodeConfig.bindings || {}),
  };

  for (const [key, expr] of Object.entries(inputsToResolve)) {
    if (typeof expr !== "string") {
      resolved[key] = expr;
      continue;
    }

    const parsed = parseBinding(expr);
    if (!parsed) {
      resolved[key] = expr;
      continue;
    }

    if (parsed.kind === "input") {
      const inputVal = run.input?.[parsed.field];
      if (inputVal !== undefined && inputVal !== null) {
        resolved[key] = inputVal;
      }
    } else if (parsed.kind === "node_output") {
      const depRun = nodeRuns.find((n) => n.node_id === parsed.nodeId);
      resolved[key] = getValueAtPath(depRun?.output, parsed.path);
    }
  }

  return resolved;
}

/**
 * Executes a single node directly without retries. On failure, immediately marks as failed.
 * @param {string} runId
 * @param {string} nodeId
 */
export async function executeNodeJob(runId, nodeId) {
  const startedAt = Date.now();
  
  // 1. Fetch current run and node run state
  const run = await runRepo.getRun(runId);
  if (!run) {
    throw new Error(`Run ${runId} not found.`);
  }

  const nodeRun = await runRepo.getNodeRun(runId, nodeId);
  if (!nodeRun) {
    throw new Error(`Node run for ${runId}:${nodeId} not found.`);
  }

  // If node is already completed or failed, skip
  if (nodeRun.status === "completed" || nodeRun.status === "failed") {
    return;
  }

  const nodeConfig = run.execution_plan.nodes.find((n) => n.id === nodeId);
  if (!nodeConfig) {
    throw new Error(`Node configuration for ${nodeId} not found in execution plan.`);
  }

  // 2. Fetch other node runs to resolve dependencies
  const nodeRuns = await runRepo.listNodeRuns(runId);

  let placeholders = [];

  try {
    // 3. Resolve inputs
    const resolvedInputs = await resolveInputsForNode(run, nodeConfig, nodeRuns);

    console.log(`\n----------------------------------------------------------------`);
    console.log(`⚡ [character-sheet-v1 Execution Engine]`);
    console.log(`▶ Stage 1: Resolving inputs for Node "${nodeId}" (${nodeConfig.type})`);
    console.log(`   Resolved Inputs:`, JSON.stringify(resolvedInputs, null, 2));

    // 4. Update status in database to running and set started_at if attempt is 1
    await runRepo.updateNodeRun(runId, nodeId, {
      status: "running",
      started_at: nodeRun.started_at || new Date().toISOString()
    });

    const { eventRecorder } = getGateways();
    if (eventRecorder) {
      eventRecorder.record({
        executionId: runId,
        traceId: runId,
        operation: `node.start`,
        metadata: { nodeId, attempt: nodeRun.attempt }
      });
    }

    logV2Event({
      traceId: runId,
      operation: `node.execute:${nodeId}`,
      durationMs: 0,
      status: "success",
      message: `Starting node ${nodeId}`
    });

    // 5. Invoke node execution
    const ctx = {
      runId,
      nodeId,
      userId: run.user_id,
      traceId: runId,
      attempt: nodeRun.attempt,
      forceProvider: nodeRun.provider_override || null,
    };

    console.log(`💳 ▶ Stage 2: Reserving billing & preparing placeholders for Node "${nodeId}"`);
    await reserveNodeBilling({
      run,
      nodeConfig,
      resolvedInputs,
      attempt: nodeRun.attempt,
    });

    console.log(`🎨 ▶ Stage 2: Executing Processor "${nodeConfig.type}" for Node "${nodeId}"...`);
    const output = await executeNode(nodeConfig.type, resolvedInputs, ctx);
    console.log(`   Processor Output Preview:`, JSON.stringify(output, null, 2).slice(0, 300) + '...');

    console.log(`💾 ▶ Stage 3: Persisting outputs for Node "${nodeId}"...`);
    await executeNodePersistence({ nodeConfig, output, run, resolvedInputs });

    await settleNodeBilling({ runId, nodeId, nodeConfig, attempt: nodeRun.attempt });

    const durationMs = Date.now() - startedAt;
    const envelope = nodeSuccess(output, {
      workflowRunId: runId,
      nodeRunId: nodeRun.id,
      nodeId,
      nodeType: nodeConfig.type,
      durationMs,
      modelKey: resolvedInputs.model,
      traceId: runId,
    });
    console.log(`✅ ▶ Stage 4: Node "${nodeId}" COMPLETED successfully in ${durationMs}ms`);
    console.log(`----------------------------------------------------------------\n`);

    // 6. On success: update node status, complete it, and trigger orchestrator
    await runRepo.updateNodeRun(runId, nodeId, {
      status: "completed",
      output: output && typeof output === "object"
        ? { ...output, __nodeEnvelope: envelope }
        : { value: output, __nodeEnvelope: envelope },
      completed_at: new Date().toISOString()
    });

    if (eventRecorder) {
      eventRecorder.record({
        executionId: runId,
        traceId: runId,
        operation: `node.complete`,
        durationMs,
        metadata: { nodeId, attempt: nodeRun.attempt }
      });
    }

    logV2Event({
      traceId: runId,
      operation: `node.execute:${nodeId}`,
      durationMs: Date.now() - startedAt,
      status: "success",
      message: `Node ${nodeId} completed successfully`
    });

  } catch (error) {
    console.error(`❌ [nodeExecutor] Node "${nodeId}" failed: ${error.message}`);

    await rollbackNodeBilling({ runId, nodeId, nodeConfig, attempt: nodeRun.attempt }).catch(() => {});

    const maxAttempts = nodeConfig?.retry_policy?.max_attempts || 1;
    const currentAttempt = nodeRun?.attempt || 1;

    if (currentAttempt < maxAttempts) {
      const nextAttempt = currentAttempt + 1;
      const fallbackProvider = nodeConfig?.retry_policy?.fallback_provider || nodeRun.provider_override || null;
      console.log(`🔄 [nodeExecutor] Retrying Node "${nodeId}" (Attempt ${nextAttempt}/${maxAttempts}) with fallback: ${fallbackProvider}`);

      await runRepo.updateNodeRun(runId, nodeId, {
        attempt: nextAttempt,
        status: "pending",
        provider_override: fallbackProvider,
      });

      return executeNodeJob(runId, nodeId);
    }

    const { storageGateway } = getGateways();
    if (storageGateway?.failPlaceholders && placeholders.length > 0) {
      await storageGateway.failPlaceholders(placeholders, error).catch(() => {});
    }

    const workflowId = run?.input?.workflow_id || run?.input?.characterId;
    if (workflowId) {
      await db.media.findByWorkflow(workflowId).then((list) => {
        const p = list?.find((m) => m.status === "processing" || m.status === "pending");
        if (p?.id) return db.media.updateMedia(p.id, { status: "failed", error_message: error.message }).catch(() => {});
      }).catch(() => {});
    }

    const { eventRecorder } = getGateways();
    if (eventRecorder) {
      eventRecorder.record({
        executionId: runId,
        traceId: runId,
        operation: `node.fail`,
        durationMs: Date.now() - startedAt,
        status: "error",
        errorCode: error.code || "NODE_FAILED",
        message: error.message,
        metadata: { nodeId, attempt: nodeRun.attempt }
      });
    }

    logV2Event({
      traceId: runId,
      operation: `node.execute:${nodeId}`,
      durationMs: Date.now() - startedAt,
      status: "error",
      errorCode: error.code || "NODE_EXECUTION_FAILED",
      message: `Node ${nodeId} failed: ${error.message}`
    });

    const envelope = nodeFailure(error, {
      workflowRunId: runId,
      nodeRunId: nodeRun.id,
      nodeId,
      nodeType: nodeConfig?.type,
      durationMs: Date.now() - startedAt,
      traceId: runId,
    });
    await runRepo.updateNodeRun(runId, nodeId, {
      status: "failed",
      error: { code: error.code || "NODE_FAILED", message: error.message, envelope },
      completed_at: new Date().toISOString()
    });
  }
}
