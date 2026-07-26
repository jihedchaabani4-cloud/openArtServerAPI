/**
 * Per-Node Billing Strategy (PAID per node execution)
 * This strategy does not perform upfront precheck calculations;
 * billing holds are applied dynamically as each node executes.
 */
export class PerNodeStrategy {
  async estimateTotal() {
    return 0;
  }

  async preCheck() {
    // No-op upfront check
    return;
  }
}
