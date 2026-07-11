import { parseBinding } from "../compiler/validateBindings.js";
import { executeNode } from "../nodes/index.js";
import { RunRepository } from "./runRepository.js";
import { resolveRetryAttempt, getBackoffDelay } from "./retryExecutor.js";
import { enqueueWorkflowRun, v2WorkflowQueue } from "../queue/v2WorkflowQueue.js";
import { logV2Event } from "../logging/v2Logger.js";
import {
  getGateways,
  reserveNodeBilling,
  settleNodeBilling,
  rollbackNodeBilling,
  createNodeMediaPlaceholders,
  finalizeNodeMediaOutputs,
  isProviderBackedNodeType,
} from "./workflowRunner.js";

const runRepo = new RunRepository();

/**
 * Gets a nested value from an object using a dot-notation path.
 */
export function getValueAtPath(obj, path) {
  if (!path) return obj;
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Resolves inputs for a node by merging static resolved_inputs and dynamic bindings.
 */
export async function resolveInputsForNode(run, node, nodeRuns) {
  const resolved = { ...node.resolved_inputs };

  for (const [key, bindingExpr] of Object.entries(node.bindings || {})) {
    const parsed = parseBinding(bindingExpr);
    if (!parsed) continue;

    if (parsed.kind === "input") {
      resolved[key] = run.input[parsed.field];
    } else if (parsed.kind === "node_output") {
      const upstreamRun = nodeRuns.find((n) => n.node_id === parsed.nodeId);
      resolved[key] = getValueAtPath(upstreamRun?.output, parsed.path);
    }
  }

  return resolved;
}

/**
 * Executes a single node and handles its lifecycle/retries.
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

  // Declare placeholders in outer scope so catch block can access them for Phase 2 failure
  let placeholders = [];

  try {
    // 3. Resolve inputs
    const resolvedInputs = await resolveInputsForNode(run, nodeConfig, nodeRuns);

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
      message: `Starting node ${nodeId} (attempt ${nodeRun.attempt})`
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

    await reserveNodeBilling({
      run,
      nodeConfig,
      resolvedInputs,
      attempt: nodeRun.attempt,
    });

    // Phase 1 — Create or reuse V1 media placeholders BEFORE the provider is called.
    // If the controller pre-created placeholders (passed via run.input._v1PlaceholderIds),
    // we reuse those so the HTTP response can include them immediately.
    // Otherwise we create new placeholders here.
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

    const output = await executeNode(nodeConfig.type, resolvedInputs, ctx);

    // Phase 2 (success) — Finalize placeholders with actual URL and status='success'.
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
        durationMs: Date.now() - startedAt,
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
    await rollbackNodeBilling({ runId, nodeId, nodeConfig, attempt: nodeRun.attempt }).catch(() => {});

    // Phase 2 (failure) — Mark all created placeholders as failed.
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
      message: `Node ${nodeId} failed on attempt ${nodeRun.attempt}: ${error.message}`
    });

    // 7. On failure: apply retry policy
    const retryPolicy = nodeConfig.retry_policy;
    const retryResult = resolveRetryAttempt(nodeConfig, nodeRun.attempt);

    if (retryResult.shouldRetry) {
      const delayMs = getBackoffDelay(retryPolicy, nodeRun.attempt);
      
      // Update node run status to pending/running for next attempt
      await runRepo.updateNodeRun(runId, nodeId, {
        attempt: retryResult.nextAttempt,
        status: "pending", // mark as pending until job picks it up
        provider_override: retryResult.providerOverride || null,
        error: { code: error.code || "NODE_ATTEMPT_FAILED", message: error.message }
      });

      // Enqueue job with delay
      await v2WorkflowQueue.add(
        "node-execute",
        { runId, nodeId },
        {
          jobId: `node-${runId}-${nodeId}-${retryResult.nextAttempt}`,
          delay: delayMs
        }
      );

      logV2Event({
        traceId: runId,
        operation: `node.retry:${nodeId}`,
        durationMs: 0,
        status: "success",
        message: `Scheduled attempt ${retryResult.nextAttempt} for node ${nodeId} in ${delayMs}ms`
      });

    } else {
      // Retries exhausted: mark node run as failed and trigger orchestrator to fail run
      await runRepo.updateNodeRun(runId, nodeId, {
        status: "failed",
        error: { code: error.code || "NODE_FAILED", message: error.message },
        completed_at: new Date().toISOString()
      });

      await enqueueWorkflowRun(runId);
    }
  }
}
