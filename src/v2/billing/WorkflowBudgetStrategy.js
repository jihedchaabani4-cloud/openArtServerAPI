import { estimateWorkflowCost } from "./BudgetEstimator.js";

/**
 * Workflow Budget Strategy
 * Performs an upfront estimation and credit check on the entire workflow.
 */
export class WorkflowBudgetStrategy {
  async estimateTotal(plan, inputs, pricingService) {
    return estimateWorkflowCost(plan, inputs, pricingService);
  }

  async preCheck(userId, total, walletService) {
    if (!walletService) {
      console.warn("[WorkflowBudgetStrategy] No walletService provided, skipping preCheck.");
      return;
    }

    if (total <= 0) {
      return; // Free workflow run
    }

    let balance = 0;
    try {
      balance = await walletService.getBalance(userId);
    } catch (err) {
      console.warn(`[WorkflowBudgetStrategy] Failed to fetch wallet balance for user ${userId}, assuming 0:`, err.message);
    }

    if (balance < total) {
      const err = new Error(`Insufficient credits: required ${total}, available ${balance}`);
      err.code = "INSUFFICIENT_CREDITS";
      err.required = total;
      err.available = balance;
      throw err;
    }
  }
}
