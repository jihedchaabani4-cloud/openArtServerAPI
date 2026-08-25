import { randomUUID } from "node:crypto";
import { parseBinding } from "../compiler/validateBindings.js";
import { RunRepository } from "./runRepository.js";
import { jobQueueService } from "../../services/jobQueueService.js";
import { getValueAtPath, executeNodeJob } from "./nodeExecutor.js";
import { logV2Event } from "../logging/v2Logger.js";

const runRepo = new RunRepository();
const PROVIDER_BACKED_NODE_TYPES = new Set([
  "image-generation",
  "video-generation",
  "upscale",
  "media-transform",
  "llm",
]);

let billingGateway = null;
let storageGateway = null;
let eventRecorder = null;

/**
 * Configure global/injected gateways.
 */
export function initializeGateways({ billing, storage, events }) {
  billingGateway = billing;
  storageGateway = storage;
  eventRecorder = events;
  console.log("[V2 Runner] Gateways initialized.");
}

export function getGateways() {
  return { billingGateway, storageGateway, eventRecorder };
}

export function isProviderBackedNodeType(nodeType) {
  return PROVIDER_BACKED_NODE_TYPES.has(nodeType);
}

export function getNodeBillingReference(runId, nodeId, attempt = 1) {
  return `v2:${runId}:${nodeId}:${attempt}`;
}

function estimateNodeBillingAmount(nodeConfig, resolvedInputs = {}) {
  switch (nodeConfig?.type) {
    case "image-generation":
      return Math.max(1, Number(resolvedInputs.count ?? nodeConfig?.resolved_inputs?.count ?? 1));
    case "video-generation":
      return Math.max(1, Number(resolvedInputs.duration ?? nodeConfig?.resolved_inputs?.duration ?? 5));
    case "upscale":
      return Math.max(1, Number(resolvedInputs.factor ?? nodeConfig?.resolved_inputs?.factor ?? 2));
    case "media-transform":
      return 1; // 1 credit per transform operation
    case "llm":
      return 1; // 1 credit per LLM execution
    default:
      return 0;
  }
}


export async function reserveNodeBilling({ run, nodeConfig, resolvedInputs = {}, attempt = 1 }) {
  if (!billingGateway || !isProviderBackedNodeType(nodeConfig?.type)) {
    return null;
  }

  return billingGateway.reserve({
    userId: run?.user_id || null,
    amount: estimateNodeBillingAmount(nodeConfig, resolvedInputs),
    referenceId: getNodeBillingReference(run.run_id, nodeConfig.id, attempt),
    metadata: {
      workflowId: run?.workflow_id,
      workflowVersion: run?.workflow_version,
      nodeId: nodeConfig.id,
      nodeType: nodeConfig.type,
      attempt,
    },
  });
}

export async function settleNodeBilling({ runId, nodeId, nodeConfig, attempt = 1 }) {
  if (!billingGateway || !isProviderBackedNodeType(nodeConfig?.type)) {
    return null;
  }

  return billingGateway.settle(getNodeBillingReference(runId, nodeId, attempt));
}

export async function rollbackNodeBilling({ runId, nodeId, nodeConfig, attempt = 1 }) {
  if (!billingGateway || !isProviderBackedNodeType(nodeConfig?.type)) {
    return null;
  }

  return billingGateway.rollback(getNodeBillingReference(runId, nodeId, attempt));
}

/**
 * Starts a new workflow run.
 * @param {import('../contracts/executionGraph.js').ExecutionGraph} plan
 * @param {Object} runtimeInput
 * @param {string} [runId] Optional pre-generated run ID
 * @returns {Promise<{ run_id: string, status: string }>}
 */
export async function startWorkflowRun(plan, runtimeInput, runId = null) {
  const finalRunId = runId || randomUUID();

  // Create workflow run entry in DB
  await runRepo.createRun({
    run_id: finalRunId,
    workflow_id: plan.workflow_id,
    workflow_version: plan.workflow_version,
    user_id: runtimeInput.userId || null,
    status: "pending",
    input: runtimeInput,
    execution_plan: plan
  });

  // Initialize node run entries in DB
  for (const node of plan.nodes) {
    await runRepo.createNodeRun({
      run_id: finalRunId,
      node_id: node.id,
      node_type: node.type,
      status: "pending",
      attempt: 1
    });
  }

  // Record start event
  if (eventRecorder) {
    eventRecorder.record({
      executionId: finalRunId,
      traceId: finalRunId,
      operation: "workflow.start",
      status: "success",
      metadata: { workflowId: plan.workflow_id }
    });
  }

  logV2Event({
    traceId: finalRunId,
    operation: "workflow.start",
    durationMs: 0,
    status: "success",
    message: `Initialized workflow run ${finalRunId} for ${plan.workflow_id}`
  });

  // Execute workflow orchestration across nodes
  try {
    await executeOrchestration(finalRunId);
  } catch (err) {
    console.error(`[workflowRunner] Execution error for run ${finalRunId}:`, err);
  }

  return { run_id: finalRunId, status: "pending" };
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
    await runRepo.updateRun(runId, {
      status: "failed",
      error: { code: "NODE_FAILED", message: `Workflow failed at node ${failedNode.node_id}` },
      completed_at: new Date().toISOString()
    });

    if (eventRecorder) {
      eventRecorder.record({
        executionId: runId,
        traceId: runId,
        operation: "workflow.complete",
        status: "error",
        errorCode: "NODE_FAILED",
        message: `Workflow failed at node ${failedNode.node_id}`
      });
    }

    logV2Event({
      traceId: runId,
      operation: "workflow.orchestrate",
      durationMs: Date.now() - started,
      status: "error",
      errorCode: "WORKFLOW_FAILED",
      message: `Workflow failed at node ${failedNode.node_id}`
    });
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

    logV2Event({
      traceId: runId,
      operation: "workflow.orchestrate",
      durationMs: Date.now() - started,
      status: "success",
      message: "Workflow completed successfully"
    });
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
        console.error(`[workflowRunner] Node execution error (${node.id}):`, err.message);
        return;
      }
    }
  }

  const anyRunning = nodeRuns.some((n) => n.status === "running");
  if (!anyRunning && !enqueuedAny) {
    // Deadlock: no node is running and no pending node has dependencies satisfied
    await runRepo.updateRun(runId, {
      status: "failed",
      error: { code: "ORCHESTRATION_DEADLOCK", message: "Workflow stuck: no nodes running or ready" },
      completed_at: new Date().toISOString()
    });

    logV2Event({
      traceId: runId,
      operation: "workflow.orchestrate",
      durationMs: Date.now() - started,
      status: "error",
      errorCode: "ORCHESTRATION_DEADLOCK",
      message: "Workflow stuck: no nodes running or ready"
    });
  }
}
