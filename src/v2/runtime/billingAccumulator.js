/**
 * BillingAccumulator
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight, in-memory cost and usage accumulator for V2 workflows.
 *
 * During workflow execution under a UseCase upfront hold, individual nodes
 * never touch the database or WalletService. Instead, they record their
 * resource consumption (model, credit amount, kind) into this accumulator.
 *
 * At workflow completion or failure, the UseCase orchestrator retrieves
 * the complete breakdown and commits or rolls back the parent hold with
 * the breakdown stored directly in the transaction's metadata.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export class BillingAccumulator {
  constructor() {
    this.entries = [];
  }

  /**
   * Records a node's execution cost and metadata.
   *
   * @param {Object} params
   * @param {string} params.nodeId
   * @param {string} [params.nodeType]
   * @param {string} [params.model]
   * @param {number} [params.amount=0]
   * @param {"CHARGEABLE"|"NO_CHARGE"} [params.kind]
   * @param {Object} [params.metadata={}]
   */
  record({
    nodeId,
    nodeType = null,
    model = null,
    amount = 0,
    kind = null,
    metadata = {},
  }) {
    const numericAmount = Math.max(0, Number(amount) || 0);
    const effectiveKind = kind || (numericAmount > 0 ? "CHARGEABLE" : "NO_CHARGE");

    this.entries.push({
      nodeId,
      nodeType,
      model,
      amount: numericAmount,
      kind: effectiveKind,
      recordedAt: new Date().toISOString(),
      ...metadata,
    });
  }

  /**
   * Total chargeable credits accumulated across all nodes.
   * @returns {number}
   */
  getTotalCost() {
    return this.entries.reduce(
      (sum, e) => sum + (e.kind === "CHARGEABLE" ? e.amount : 0),
      0
    );
  }

  /**
   * Returns a shallow copy of all recorded entries.
   * @returns {Array<Object>}
   */
  getBreakdown() {
    return [...this.entries];
  }

  /**
   * Total number of recorded nodes.
   * @returns {number}
   */
  size() {
    return this.entries.length;
  }
}

export default BillingAccumulator;
