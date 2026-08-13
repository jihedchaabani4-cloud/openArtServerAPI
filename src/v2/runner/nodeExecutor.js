import { parseBinding } from "../compiler/validateBindings.js";
import { RunRepository } from "./runRepository.js";
import { executeNode } from "../nodes/index.js";
import {
  reserveNodeBilling,
  settleNodeBilling,
  rollbackNodeBilling,
  createNodeMediaPlaceholders,
  finalizeNodeMediaOutputs,
  isProviderBackedNodeType,
  getGateways,
} from "./workflowRunner.js";
import { enqueueWorkflowRun } from "../queue/v2WorkflowQueue.js";
import { logV2Event } from "../logging/v2Logger.js";

const runRepo = new RunRepository();

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
      resolved[key] = run.input?.[parsed.field];
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

    const preCreatedPlaceholders = run.input?._v1PlaceholderIds;
    if (preCreatedPlaceholders && preCreatedPlaceholders.length > 0 && isProviderBackedNodeType(nodeConfig?.type)) {
      placeholders = preCreatedPlaceholders;
    } else {
      placeholders = await createNodeMediaPlaceholders({
        runId,
        nodeConfig,
        resolvedInputs,
        run,
      });
    }

    console.log(`🎨 ▶ Stage 3: Executing Processor "${nodeConfig.type}" for Node "${nodeId}"...`);
    const output = await executeNode(nodeConfig.type, resolvedInputs, ctx);
    console.log(`   Processor Output Preview:`, JSON.stringify(output, null, 2).slice(0, 300) + '...');

    console.log(`💾 ▶ Stage 4: Finalizing & persisting outputs for Node "${nodeId}"...`);
    await finalizeNodeMediaOutputs({
      runId,
      nodeId,
      nodeConfig,
      output,
      run,
      input: run.input,
      placeholders,
    });
    await settleNodeBilling({ runId, nodeId, nodeConfig, attempt: nodeRun.attempt });

    const durationMs = Date.now() - startedAt;
    console.log(`✅ ▶ Stage 5: Node "${nodeId}" COMPLETED successfully in ${durationMs}ms`);
    console.log(`----------------------------------------------------------------\n`);

    // 6. On success: update node status, complete it, and trigger orchestrator
    await runRepo.updateNodeRun(runId, nodeId, {
      status: "completed",
      output,
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

    // Enqueue orchestrator run to process next tier
    await enqueueWorkflowRun(runId);

  } catch (error) {
    console.error(`❌ [nodeExecutor] Node "${nodeId}" failed: ${error.message}`);

    await rollbackNodeBilling({ runId, nodeId, nodeConfig, attempt: nodeRun.attempt }).catch(() => {});

    const { storageGateway } = getGateways();
    if (storageGateway?.failPlaceholders && placeholders.length > 0) {
      await storageGateway.failPlaceholders(placeholders, error).catch(() => {});
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

    // Direct failure: Mark node run as failed without retrying
    await runRepo.updateNodeRun(runId, nodeId, {
      status: "failed",
      error: { code: error.code || "NODE_FAILED", message: error.message },
      completed_at: new Date().toISOString()
    });

    // Trigger orchestrator to mark workflow as failed immediately
    await enqueueWorkflowRun(runId);
  }
}
