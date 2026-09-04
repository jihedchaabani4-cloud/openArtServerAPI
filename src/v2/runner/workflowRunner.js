import { randomUUID } from "node:crypto";
import { parseBinding } from "../compiler/validateBindings.js";
import { RunRepository } from "./runRepository.js";
import { jobQueueService } from "../../services/jobQueueService.js";
import { getValueAtPath, executeNodeJob } from "./nodeExecutor.js";
import { calculateCost, resolveOperation } from "../../models/index.js";
import { BillingAccumulator } from "../runtime/billingAccumulator.js";
import { formatWorkflowError } from "../runtime/errorPolicy.js";
import { createLogger, LogEvents } from "../../infrastructure/logging/index.js";

const workflowLogger = createLogger("workflow");

const runRepo = new RunRepository();
const PROVIDER_BACKED_NODE_TYPES = new Set([
  "image-generation",
  "llm",
]);

// ── BILLING ACCUMULATOR REGISTRY ──────────────────────────────────────────────
// Maps runId → BillingAccumulator for in-flight workflow runs.
//
// ✅ SAFE: Current architecture runs all nodes sequentially inside ONE process.
//    executeOrchestration() calls executeNodeJob() via `await` in the same Node.js
//    process, so this in-memory Map is shared by all nodes of the same workflow run.
//
// ⚠️  LIMITATION: If you distribute node execution across separate BullMQ worker
//    processes (e.g., enqueuing individual node jobs), this Map will NOT be shared.
//    In that case, migrate to one of:
//      - Redis Hash keyed by runId (O(1) per node)
//      - workflow_runs.metadata JSON column (persisted, auto-recoverable on crash)
//    Do NOT activate distributed node queuing without migrating the accumulator first.
// ─────────────────────────────────────────────────────────────────────────────
const activeAccumulators = new Map();

export function getRunBillingAccumulator(runId) {
  return activeAccumulators.get(runId) || null;
}

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
  workflowLogger.debug("Gateways initialized");
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

/**
 * Calculate the billing cost for a single node using the Models Management System.
 *
 * ── SINGLE SOURCE OF TRUTH ────────────────────────────────────────────────────
 * Both the UseCase Upfront Hold (workflowBillingPlan.js) and the BillingAccumulator
 * (this function) use the SAME `calculateCost` from `models/index.js`.
 * There is no separate estimator — this IS the canonical pricing calculation.
 *
 *   workflowBillingPlan.calculateWorkflowBillingPlan()
 *     → calculateCost(modelKey, operation, inputs)   [PRE-execution estimate]
 *
 *   estimateNodeBillingAmount()
 *     → calculateCost(model, op, resolvedInputs)     [AT-execution with real inputs]
 *
 * The at-execution cost uses fully resolved inputs (actual dimensions, quality, etc.)
 * so it is MORE accurate than the upfront estimate. Minor deltas (upfront=24, actual=24)
 * are expected and are the correct behaviour — the Hold covers the maximum possible cost.
 * ────────────────────────────────────────────────────────────────────────────────
 *
 * @param {object} nodeConfig
 * @param {object} resolvedInputs - Fully resolved runtime inputs for the node
 * @returns {number} Credit cost (0 for free nodes)
 */
export function estimateNodeBillingAmount(nodeConfig, resolvedInputs = {}) {
  const nodeType = nodeConfig?.type;
  if (!isProviderBackedNodeType(nodeType)) {
    return 0;
  }

  const isLLM = nodeType === "llm";
  const model =
    resolvedInputs.model ||
    nodeConfig?.config?.model ||
    nodeConfig?.inputs?.model ||
    nodeConfig?.resolved_inputs?.model;

  if (!model) {
    throw new Error(`[Billing] Missing required model for node "${nodeConfig?.id || nodeType}"`);
  }

  let domain = "image";
  if (nodeType === "video-generation") {
    domain = "video";
  } else if (isLLM) {
    domain = "text";
  } else if (nodeType === "media-transform") {
    const isVideo = Boolean(
      resolvedInputs.video_url ||
      resolvedInputs.video ||
      resolvedInputs.duration ||
      resolvedInputs.mode === "video_to_video"
    );
    domain = isVideo ? "video" : "image";
  }

  const inputsForBilling = { ...resolvedInputs, model };
  if (isLLM && !inputsForBilling.messages) {
    const textPrompt = resolvedInputs.userPrompt || resolvedInputs.prompt || "Default prompt";
    inputsForBilling.messages = [{ role: "user", content: textPrompt }];
  }

  const op = resolveOperation(inputsForBilling, domain);
  const costResult = calculateCost(model, op, inputsForBilling);
  const rawCost = typeof costResult === "object" && costResult !== null ? costResult.amount : costResult;
  const costNumber = parseFloat(rawCost);

  if (isNaN(costNumber) || costNumber < 0) {
    throw new Error(`[Billing] Invalid calculated cost "${rawCost}" for model "${model}" (${op})`);
  }

  return costNumber;
}


export async function reserveNodeBilling({ run, nodeConfig, resolvedInputs = {}, attempt = 1 }) {
  if (!billingGateway || !isProviderBackedNodeType(nodeConfig?.type)) {
    return { status: "skipped", reason: "non_billable_node_type", amount: 0 };
  }

  const referenceId = getNodeBillingReference(run.run_id, nodeConfig.id, attempt);

  // If the workflow run has an upfront UseCase billing hold, financial reservation is handled at UseCase level
  if (run?.input?.billing_hold_id) {
    return {
      status: "skipped",
      reason: "covered_by_usecase_hold",
      referenceId,
      amount: 0,
      parentHoldId: run.input.billing_hold_id,
    };
  }

  return billingGateway.reserve({
    userId: run?.user_id || null,
    amount: estimateNodeBillingAmount(nodeConfig, resolvedInputs),
    referenceId,
    metadata: {
      workflowId: run?.workflow_id,
      workflowVersion: run?.workflow_version,
      nodeId: nodeConfig.id,
      nodeType: nodeConfig.type,
      attempt,
    },
  });
}

export async function settleNodeBilling({ runId, nodeId, nodeConfig, attempt = 1, reservation = null }) {
  if (!billingGateway || !isProviderBackedNodeType(nodeConfig?.type)) {
    return { status: "skipped" };
  }

  if (reservation && (reservation.status === "skipped" || reservation.amount === 0)) {
    return { status: "skipped", referenceId: reservation.referenceId };
  }

  return billingGateway.settle(reservation || getNodeBillingReference(runId, nodeId, attempt));
}

export async function rollbackNodeBilling({ runId, nodeId, nodeConfig, attempt = 1, reservation = null }) {
  if (!billingGateway || !isProviderBackedNodeType(nodeConfig?.type)) {
    return { status: "skipped" };
  }

  if (reservation && (reservation.status === "skipped" || reservation.amount === 0)) {
    return { status: "skipped", referenceId: reservation.referenceId };
  }

  return billingGateway.rollback(reservation || getNodeBillingReference(runId, nodeId, attempt));
}

/**
 * Starts a new workflow run.
 * @param {import('../contracts/executionGraph.js').ExecutionGraph} plan
 * @param {Object} runtimeInput
 * @param {string} [runId] Optional pre-generated run ID
 * @returns {Promise<{ run_id: string, status: string, error?: Object, outputs?: Object }>}
 */
export async function startWorkflowRun(plan, runtimeInput, runId = null) {
  const finalRunId = runId || randomUUID();
  const billing = new BillingAccumulator();
  activeAccumulators.set(finalRunId, billing);

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

  workflowLogger.info({
    runId: finalRunId,
    workflowId: plan.workflow_id,
    durationMs: 0,
    event: LogEvents.WORKFLOW_STARTED,
  }, `Initialized workflow run ${finalRunId} for ${plan.workflow_id}`);

  // Execute workflow orchestration across nodes
  try {
    await executeOrchestration(finalRunId);
  } catch (err) {
    workflowLogger.error({ runId: finalRunId, err, event: LogEvents.WORKFLOW_FAILED }, `Execution error for run ${finalRunId}: ${err.message}`);
  }

  const finalRun = await runRepo.getRun(finalRunId);
  const billingBreakdown = billing.getBreakdown();
  const totalCost = billing.getTotalCost();
  activeAccumulators.delete(finalRunId);

  return {
    run_id: finalRunId,
    status: finalRun?.status || "pending",
    error: finalRun?.error || null,
    outputs: finalRun?.outputs || null,
    billingBreakdown,
    totalCost,
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
    });

    if (eventRecorder) {
      eventRecorder.record({
        executionId: runId,
        traceId: runId,
        operation: "workflow.complete",
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
        }).catch(() => {});
        return await executeOrchestration(runId);
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

    workflowLogger.error({
      runId,
      durationMs: Date.now() - started,
      errorCode: "ORCHESTRATION_DEADLOCK",
      event: LogEvents.WORKFLOW_FAILED,
    }, "Workflow stuck: no nodes running or ready");
  }
}
