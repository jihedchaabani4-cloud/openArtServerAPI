import { WorkflowBudgetStrategy } from "./WorkflowBudgetStrategy.js";
import { PerNodeStrategy } from "./PerNodeStrategy.js";

export class FreeStrategy {
  async estimateTotal() {
    return 0;
  }
  async preCheck() {
    return;
  }
}

/**
 * Strategy Factory
 */
export function createBillingStrategy(strategyName) {
  switch (strategyName) {
    case "workflow-budget":
      return new WorkflowBudgetStrategy();
    case "per-node":
      return new PerNodeStrategy();
    case "free":
      return new FreeStrategy();
    default:
      console.warn(`[BillingStrategy] Unknown billing strategy "${strategyName}". Defaulting to "free".`);
      return new FreeStrategy();
  }
}
