import { randomUUID } from "node:crypto";
import { parseBinding } from "../compiler/validateBindings.js";
import { RunRepository } from "./runRepository.js";
import { jobQueueService } from "../../services/jobQueueService.js";
import { getValueAtPath, executeNodeJob } from "./nodeExecutor.js";
import { calculateCost } from "../../models/index.js";
import { formatWorkflowError } from "../runtime/errorPolicy.js";
import { createLogger, LogEvents } from "../../infrastructure/logging/index.js";
import { db } from "../../container.js";
import { failWorkflowPendingMedia } from "../../platform/media/MediaLifecycleService.js";

const workflowLogger = createLogger("workflow");

const runRepo = new RunRepository();
const PROVIDER_BACKED_NODE_TYPES = new Set([
  "image-generation",
  "video-generation",
  "llm",
]);

// ── BILLING ACCUMULATOR REGISTRY ──────────────────────────────────────────────
// Maps runId → PersistedBillingAccumulator for in-flight workflow runs.
//
// ✅ WRITE-THROUGH PERSISTENCE (BUG-09 fix):
//    Each record() call immediately persists the entry to run.metadata.billingAccumulator
//    via runRepo.updateRun. The in-memory Map is kept as a write-through cache for
//    single-process performance.
//
// ✅ CRASH / DISTRIBUTED RECOVERY:
//    getRunBillingAccumulator() checks the in-memory Map first. If the runId is not
//    found (e.g. worker restart, cross-process call), it reconstructs the accumulator
//    from run.metadata.billingAccumulator in the DB, so no entries are lost.
//
// ✅ DISTRIBUTED SAFETY:
//    Nodes dispatched to separate BullMQ workers can safely call record() — each
//    write is appended to the DB column atomically via updateRun.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PersistedBillingAccumulator
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop-in replacement for BillingAccumulator that writes every recorded entry
 * to `run.metadata.billingAccumulator` (via runRepo.updateRun) so the entries
 * survive worker crashes and are visible to other processes.
 *
 * The in-memory `entries[]` array is kept in sync as a write-through cache,
 * so intra-process reads are still O(1) without a DB round-trip.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export class PersistedBillingAccumulator {
  /**
   * @param {string} runId
   * @param {import('./runRepository.js').RunRepository} repo
   * @param {Array<Object>} [initialEntries=[]]
   */
  constructor(runId, repo, initialEntries = []) {
    this._runId = runId;
    this._repo = repo;
    this._entries = [...initialEntries];
    this._hasPersistenceFailure = false;
    this._lastPersistenceError = null;
  }

  /** Whether DB persistence failed for any billing entry. */
  hasPersistenceFailure() {
    return this._hasPersistenceFailure;
  }

  /** Returns the last DB persistence error, if any. */
  getLastPersistenceError() {
    return this._lastPersistenceError;
  }

  /**
   * Records a node's execution cost and persists it to run metadata.
   *
   * @param {Object} params
   * @param {string} params.nodeId
   * @param {string} [params.nodeType]
   * @param {string} [params.model]
   * @param {number} [params.amount=0]
   * @param {"CHARGEABLE"|"NO_CHARGE"} [params.kind]
   * @param {Object} [params.metadata={}]
   */
  async record({
    nodeId,
    nodeType = null,
    model = null,
    amount = 0,
    kind = null,
    metadata = {},
  }) {
    const numericAmount = Math.max(0, Number(amount) || 0);
    const effectiveKind = kind || (numericAmount > 0 ? "CHARGEABLE" : "NO_CHARGE");
    const entry = {
      nodeId,
      nodeType,
      model,
      amount: numericAmount,
      kind: effectiveKind,
      recordedAt: new Date().toISOString(),
      ...metadata,
    };

    // 1. Update in-memory cache immediately (fast path for same-process reads)
    this._entries.push(entry);

    // 2. Persist to DB — read current metadata, append entry, write back
    try {
      const run = await this._repo.getRun(this._runId);
      const existing = run?.metadata?.billingAccumulator || [];
      const merged = [...existing];
      // Avoid double-write if this entry was already persisted (idempotency guard)
      if (!merged.some((e) => e.nodeId === entry.nodeId && e.recordedAt === entry.recordedAt)) {
        merged.push(entry);
      }
      await this._repo.updateRun(this._runId, {
        metadata: {
          ...(run?.metadata || {}),
          billingAccumulator: merged,
        },
      });
    } catch (persistErr) {
      this._hasPersistenceFailure = true;
      this._lastPersistenceError = persistErr;
      workflowLogger.error(
        { runId: this._runId, nodeId, err: persistErr },
        `[BillingAccumulator] Failed to persist billing entry for node ${nodeId} to DB — in-memory entry retained: ${persistErr.message}`
      );
    }
  }

  /** Total chargeable credits accumulated across all nodes. */
  getTotalCost() {
    return this._entries.reduce(
      (sum, e) => sum + (e.kind === "CHARGEABLE" ? e.amount : 0),
      0
    );
  }

  /** Returns a shallow copy of all recorded entries. */
  getBreakdown() {
    return [...this._entries];
  }

  /** Total number of recorded nodes. */
  size() {
    return this._entries.length;
  }
}

const activeAccumulators = new Map();

/**
 * Returns the PersistedBillingAccumulator for an active run.
 *
 * - If the run is in-flight in this process, returns the cached instance (O(1)).
 * - If the Map has no entry (e.g. cross-process call or crash recovery), reads
 *   run.metadata.billingAccumulator from the DB and reconstructs the accumulator.
 * - Returns null only when the runId does not exist in DB either.
 *
 * @param {string} runId
 * @returns {Promise<PersistedBillingAccumulator|null>}
 */
export async function getRunBillingAccumulator(runId) {
  // Fast path: in-memory cache hit
  if (activeAccumulators.has(runId)) {
    return activeAccumulators.get(runId);
  }

  // Slow path: reconstruct from DB (crash recovery / distributed worker)
  try {
    const run = await runRepo.getRun(runId);
    if (!run) return null;
    const persistedEntries = run.metadata?.billingAccumulator || [];
    const acc = new PersistedBillingAccumulator(runId, runRepo, persistedEntries);
    // Do NOT cache in activeAccumulators — this is a read-only reconstruction;
    // only startWorkflowRun should own the canonical Map entry.
    return acc;
  } catch {
    return null;
  }
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
 *     → calculateCost(modelKey, inputs)              [PRE-execution estimate]
 *
 *   estimateNodeBillingAmount()
 *     → calculateCost(model, resolvedInputs)         [AT-execution with real inputs]
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

  let inputsForBilling;
  if (isLLM) {
    const textPrompt = resolvedInputs.userPrompt || resolvedInputs.prompt || "Default prompt";
    inputsForBilling = {
      model,
      modelKey: model,
      messages: resolvedInputs.messages || [{ role: "user", content: textPrompt }],
      prompt: textPrompt,
      ...(resolvedInputs.temperature !== undefined ? { temperature: resolvedInputs.temperature } : {}),
      ...(resolvedInputs.system_prompt || resolvedInputs.systemPromptOverride ? { system_prompt: resolvedInputs.system_prompt || resolvedInputs.systemPromptOverride } : {}),
    };
  } else {
    const params = (resolvedInputs.parameters && typeof resolvedInputs.parameters === "object")
      ? resolvedInputs.parameters
      : {};
    inputsForBilling = {
      ...params,
      model,
      modelKey: model,
      ...(resolvedInputs.prompt !== undefined ? { prompt: resolvedInputs.prompt } : {}),
    };
  }

  // Model-First: pass (model, semanticInput) — no explicit operation.
  // Models Management resolves configured provider and route internally from semantic params.
  const costResult = calculateCost(model, inputsForBilling);
  const rawCost = typeof costResult === "object" && costResult !== null ? costResult.amount : costResult;
  const costNumber = Number(rawCost);

  if (isNaN(costNumber) || costNumber < 0) {
    throw new Error(`[Billing] Invalid calculated cost "${rawCost}" for model "${model}"`);
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
 * @param {Object} [serverContext] Server-assigned verified IDs (workflowId, mediaIds, projectId)
 * @returns {Promise<{ run_id: string, status: string, error?: Object, outputs?: Object }>}
 */
export async function startWorkflowRun(plan, runtimeInput, runId = null, serverContext = {}) {
  const finalRunId = runId || randomUUID();
  const billing = new PersistedBillingAccumulator(finalRunId, runRepo);
  activeAccumulators.set(finalRunId, billing);

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
    activeAccumulators.delete(finalRunId);
    throw err;
  }

  const finalRun = await runRepo.getRun(finalRunId);
  const billingBreakdown = billing.getBreakdown();
  const totalCost = billing.getTotalCost();
  const billingPersistenceFailed = billing.hasPersistenceFailure();
  const billingPersistenceError = billing.getLastPersistenceError()?.message || null;
  activeAccumulators.delete(finalRunId);

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
