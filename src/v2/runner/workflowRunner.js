import { randomUUID } from "node:crypto";
import { parseBinding } from "../compiler/validateBindings.js";
import { RunRepository } from "./runRepository.js";
import { jobQueueService } from "../../services/jobQueueService.js";
import { getValueAtPath, executeNodeJob } from "./nodeExecutor.js";
import { formatWorkflowError } from "../runtime/errorPolicy.js";
import { createLogger, LogEvents } from "../../infrastructure/logging/index.js";
import { db } from "../../container.js";
import { failWorkflowPendingMedia } from "../../platform/media/MediaLifecycleService.js";
import {
  PersistedBillingAccumulator,
  activeAccumulators,
  beginRunBillingAccumulator,
  endRunBillingAccumulator,
  getRunBillingAccumulator,
  initializeGateways,
  getGateways,
  isProviderBackedNodeType,
  getNodeBillingReference,
  estimateNodeBillingAmount,
  reserveNodeBilling,
  settleNodeBilling,
  rollbackNodeBilling,
  PROVIDER_BACKED_NODE_TYPES,
} from "./nodeBilling.js";

// Re-export for backward compatibility with existing tests and callers
export {
  PersistedBillingAccumulator,
  activeAccumulators,
  beginRunBillingAccumulator,
  endRunBillingAccumulator,
  getRunBillingAccumulator,
  initializeGateways,
  getGateways,
  isProviderBackedNodeType,
  getNodeBillingReference,
  estimateNodeBillingAmount,
  reserveNodeBilling,
  settleNodeBilling,
  rollbackNodeBilling,
  PROVIDER_BACKED_NODE_TYPES,
};

const workflowLogger = createLogger("workflow");
const runRepo = new RunRepository();

/**
 * Starts a new workflow run.
 * @param {import('../contracts/executionGraph.js').ExecutionGraph} plan
 * @param {Object} runtimeInput
 * @param {string} [runId] Optional pre-generated run ID
 * @param {Object} [serverContext] Server-assigned verified IDs (workflowId, mediaIds, projectId)
 * @returns {Promise<{ run_id: string, status: string, error?: Object, outputs?: Object }>}
 */
export async function startWorkflowRun(plan, runtimeInput, runId = null, serverContext = {}) {
  const finalRunId = runId || randomUUID();
  const billing = beginRunBillingAccumulator(finalRunId);

  const serverWorkflowId = serverContext?.workflowId || runtimeInput?.serverWorkflowId || null;
  const serverMediaIds = serverContext?.mediaIds || runtimeInput?.serverMediaIds || (runtimeInput?.media_id ? [runtimeInput.media_id] : []);
  const serverProjectId = serverContext?.projectId || runtimeInput?.serverProjectId || runtimeInput?.project_id || null;

  try {
    // Create workflow run entry in DB with server-verified target identifiers
    await runRepo.createRun({
      run_id: finalRunId,
      workflow_id: plan.workflow_id,
      workflow_version: plan.workflow_version,
      user_id: runtimeInput.userId || null,
      status: "pending",
      input: runtimeInput,
      execution_plan: {
        ...plan,
        targetWorkflowId: serverWorkflowId,
        targetMediaIds: serverMediaIds,
        targetProjectId: serverProjectId,
      },
      targetWorkflowId: serverWorkflowId,
      targetMediaIds: serverMediaIds,
      targetProjectId: serverProjectId,
    });

    // Initialize node run entries in DB
    for (const node of plan.nodes || []) {
      await runRepo.createNodeRun({
        run_id: finalRunId,
        node_id: node.id,
        node_type: node.type,
        status: "pending",
        attempt: 1
      });
    }

    // Record start event
    const { eventRecorder } = getGateways();
    if (eventRecorder) {
      eventRecorder.record({
        executionId: finalRunId,
        traceId: finalRunId,
        operation: "workflow.start",
        status: "success",
        metadata: { workflowId: plan.workflow_id }
      });
    }

    workflowLogger.info({
      runId: finalRunId,
      workflowId: plan.workflow_id,
      durationMs: 0,
      event: LogEvents.WORKFLOW_STARTED,
    }, `Initialized workflow run ${finalRunId} for ${plan.workflow_id}`);

    // Execute workflow orchestration across nodes
    await executeOrchestration(finalRunId);
  } catch (err) {
    workflowLogger.error({ runId: finalRunId, err, event: LogEvents.WORKFLOW_FAILED }, `Execution error for run ${finalRunId}: ${err.message}`);
    const normalizedErr = {
      message: err.message || "Workflow orchestration failed",
      code: err.code || "ORCHESTRATION_ERROR",
      category: err.category || "SERVER_FAULT",
      retryable: err.retryable ?? false,
    };
    await runRepo.updateRun(finalRunId, {
      status: "failed",
      error: normalizedErr,
      completed_at: new Date().toISOString(),
    }).catch((repoErr) => {
      workflowLogger.error({
        runId: finalRunId,
        err: repoErr,
      }, `[WorkflowRunner] Failed to update run status to failed for run ${finalRunId}: ${repoErr.message}`);
    });

    // F2a & F2c: Fail pending media using the real server-verified workflowId, with error-level logging
    const targetWfId = serverWorkflowId;
    if (targetWfId) {
      try {
        await failWorkflowPendingMedia(db, targetWfId, normalizedErr.message);
      } catch (mediaFailErr) {
        workflowLogger.error({
          runId: finalRunId,
          workflowId: targetWfId,
          err: mediaFailErr,
        }, `[WorkflowRunner] Failed to mark pending media as failed for workflow ${targetWfId}: ${mediaFailErr.message}`);
      }
    }
    endRunBillingAccumulator(finalRunId);
    throw err;
  }

  const finalRun = await runRepo.getRun(finalRunId);
  const billingBreakdown = billing.getBreakdown();
  const totalCost = billing.getTotalCost();
  const billingPersistenceFailed = billing.hasPersistenceFailure();
  const billingPersistenceError = billing.getLastPersistenceError()?.message || null;
  endRunBillingAccumulator(finalRunId);

  return {
    run_id: finalRunId,
    status: finalRun?.status || "pending",
    error: finalRun?.error || null,
    outputs: finalRun?.outputs || null,
    billingBreakdown,
    totalCost,
    billingPersistenceFailed,
    billingPersistenceError,
  };
}

/**
 * Runs a single step of orchestrating the workflow.
 * Checks completed nodes, enqueues ready nodes, transitions workflow state.
 * @param {string} runId
 */
export async function executeOrchestration(runId) {
  const started = Date.now();
  const run = await runRepo.getRun(runId);
  if (!run) {
    throw new Error(`Run ${runId} not found`);
  }

  // Already terminal, skip
  if (run.status === "completed" || run.status === "failed") {
    return;
  }

  const nodeRuns = await runRepo.listNodeRuns(runId);
  const plan = run.execution_plan;
  const { eventRecorder } = getGateways();

  // 1. Transition run to 'running' if it was 'pending'
  if (run.status === "pending") {
    await runRepo.updateRun(runId, { status: "running" });
    run.status = "running";
    if (eventRecorder) {
      eventRecorder.record({
        executionId: runId,
        traceId: runId,
        operation: "workflow.run",
        status: "success"
      });
    }
  }

  // 2. Check for failed nodes
  const failedNode = nodeRuns.find((n) => n.status === "failed");
  if (failedNode) {
    const rawError = failedNode.error?.envelope?.error || failedNode.error;
    const formattedError = formatWorkflowError(rawError, failedNode);

    await runRepo.updateRun(runId, {
      status: "failed",
      error: formattedError,
      completed_at: new Date().toISOString()
    }).catch((repoErr) => {
      workflowLogger.error({
        runId,
        err: repoErr,
      }, `[WorkflowRunner] Failed to update run status to failed for run ${runId}: ${repoErr.message}`);
    });

    const targetWfId = run?.targetWorkflowId || run?.execution_plan?.targetWorkflowId || null;
    if (targetWfId) {
      try {
        await failWorkflowPendingMedia(db, targetWfId, formattedError.message);
      } catch (mediaFailErr) {
        workflowLogger.error({
          runId,
          workflowId: targetWfId,
          err: mediaFailErr,
        }, `[WorkflowRunner] Failed to mark pending media as failed for workflow ${targetWfId}: ${mediaFailErr.message}`);
      }
    }

    if (eventRecorder) {
      eventRecorder.record({
        executionId: runId,
        traceId: runId,
        operation: "workflow.fail",
        status: "error",
        errorCode: formattedError.code,
        message: formattedError.message,
        metadata: {
          category: formattedError.category,
          nodeId: failedNode.node_id,
          retryable: formattedError.retryable,
          internalDetails: formattedError.internalDetails,
        }
      });
    }

    workflowLogger.error({
      runId,
      nodeId: failedNode.node_id,
      durationMs: Date.now() - started,
      errorCode: formattedError.code,
      event: LogEvents.WORKFLOW_FAILED,
    }, `Workflow failed at node ${failedNode.node_id} [${formattedError.category}]: ${formattedError.message}`);
    return;
  }

  // 3. Check if all nodes are completed
  const allCompleted = plan.nodes.every((node) => {
    const nodeRun = nodeRuns.find((n) => n.node_id === node.id);
    return nodeRun && nodeRun.status === "completed";
  });

  if (allCompleted) {
    // Resolve outputs
    const outputs = {};
    for (const [key, bindingExpr] of Object.entries(plan.outputs || {})) {
      const parsed = parseBinding(bindingExpr);
      if (parsed && parsed.kind === "node_output") {
        const nodeRun = nodeRuns.find((n) => n.node_id === parsed.nodeId);
        outputs[key] = getValueAtPath(nodeRun?.output, parsed.path);
      } else if (parsed && parsed.kind === "input") {
        outputs[key] = run.input[parsed.field];
      }
    }

    await runRepo.updateRun(runId, {
      status: "completed",
      outputs,
      completed_at: new Date().toISOString()
    });

    if (eventRecorder) {
      eventRecorder.record({
        executionId: runId,
        traceId: runId,
        operation: "workflow.complete",
        status: "success",
        metadata: { outputs }
      });
    }

    workflowLogger.info({
      runId,
      durationMs: Date.now() - started,
      event: LogEvents.WORKFLOW_COMPLETED,
    }, "Workflow completed successfully");
    return;
  }

  // 4. Enqueue ready nodes
  let enqueuedAny = false;
  for (const node of plan.nodes) {
    const nodeRun = nodeRuns.find((n) => n.node_id === node.id);
    if (!nodeRun || nodeRun.status !== "pending") {
      continue;
    }

    // Check dependencies (incoming edges to this node)
    const deps = plan.edges.filter((e) => e.to === node.id).map((e) => e.from);
    const depsSatisfied = deps.every((depId) => {
      const depRun = nodeRuns.find((n) => n.node_id === depId);
      return depRun && depRun.status === "completed";
    });

    if (depsSatisfied) {
      await runRepo.updateNodeRun(runId, node.id, {
        status: "running",
        started_at: new Date().toISOString()
      });
      
      try {
        await executeNodeJob(runId, node.id);
        return await executeOrchestration(runId);
      } catch (err) {
        workflowLogger.error({ nodeId: node.id, runId, err, event: LogEvents.WORKFLOW_NODE_FAILED }, `Node execution error (${node.id}): ${err.message}`);
        await runRepo.updateNodeRun(runId, node.id, {
          status: "failed",
          error: { code: "NODE_FAILED", message: err.message },
          completed_at: new Date().toISOString()
        }).catch((updateErr) => {
          workflowLogger.error(
            { nodeId: node.id, runId, err: updateErr, event: LogEvents.WORKFLOW_NODE_FAILED },
            `Failed to update node run status to failed for node ${node.id}: ${updateErr.message}`
          );
        });
        return await executeOrchestration(runId);
      }
    }
  }

  const anyRunning = nodeRuns.some((n) => n.status === "running");
  if (!anyRunning && !enqueuedAny) {
    // Deadlock: no node is running and no pending node has dependencies satisfied
    const deadlockError = { code: "ORCHESTRATION_DEADLOCK", message: "Workflow stuck: no nodes running or ready" };
    await runRepo.updateRun(runId, {
      status: "failed",
      error: deadlockError,
      completed_at: new Date().toISOString()
    }).catch((repoErr) => {
      workflowLogger.error({
        runId,
        err: repoErr,
      }, `[WorkflowRunner] Failed to update run status to failed on deadlock for run ${runId}: ${repoErr.message}`);
    });

    const targetWfId = run?.targetWorkflowId || run?.execution_plan?.targetWorkflowId || null;
    if (targetWfId) {
      try {
        await failWorkflowPendingMedia(db, targetWfId, deadlockError.message);
      } catch (mediaFailErr) {
        workflowLogger.error({
          runId,
          workflowId: targetWfId,
          err: mediaFailErr,
        }, `[WorkflowRunner] Failed to mark pending media as failed on deadlock for workflow ${targetWfId}: ${mediaFailErr.message}`);
      }
    }

    workflowLogger.error({
      runId,
      durationMs: Date.now() - started,
      errorCode: "ORCHESTRATION_DEADLOCK",
      event: LogEvents.WORKFLOW_FAILED,
    }, "Workflow stuck: no nodes running or ready");
  }
}
