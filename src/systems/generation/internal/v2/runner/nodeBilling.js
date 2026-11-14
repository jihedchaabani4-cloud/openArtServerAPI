import { RunRepository } from "../../db/RunRepository.js";
import { calculateCost } from "#models/tools";
import { createLogger } from "#shared";

const workflowLogger = createLogger("workflow");
const runRepo = new RunRepository();

export const PROVIDER_BACKED_NODE_TYPES = new Set([
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

export const activeAccumulators = new Map();

/**
 * Creates and registers a new PersistedBillingAccumulator for an active run.
 * @param {string} runId
 * @returns {PersistedBillingAccumulator}
 */
export function beginRunBillingAccumulator(runId) {
  const billing = new PersistedBillingAccumulator(runId, runRepo);
  activeAccumulators.set(runId, billing);
  return billing;
}

/**
 * Removes the active accumulator for a completed/failed run.
 * @param {string} runId
 */
export function endRunBillingAccumulator(runId) {
  activeAccumulators.delete(runId);
}

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
