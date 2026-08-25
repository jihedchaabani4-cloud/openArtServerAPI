import { randomUUID } from "node:crypto";
import { BILLING_STATUS } from "./runtimeConstants.js";

export class UseCaseBillingRuntime {
  constructor({ walletService = null, billingGateway = null } = {}) {
    this.walletService = walletService;
    this.billingGateway = billingGateway;
  }

  buildReferenceId({ workflowRunId = null, useCaseId, userId, idempotencyKey = null } = {}) {
    const stableKey = idempotencyKey || workflowRunId || randomUUID();
    return `usecase:${useCaseId}:${userId}:${stableKey}`;
  }

  async reserveUseCase({ userId, useCaseId, workflowRunId = null, totalCredits = 0, costBreakdown = null, idempotencyKey = null } = {}) {
    const amount = Math.max(0, Math.ceil(Number(totalCredits) || 0));
    const referenceId = this.buildReferenceId({ workflowRunId, useCaseId, userId, idempotencyKey });

    if (amount <= 0) {
      return {
        billingStatus: BILLING_STATUS.NOT_REQUIRED,
        billingHoldId: null,
        referenceId,
        reservedCredits: 0,
      };
    }

    const metadata = {
      kind: "usecase-upfront-reserve",
      userId,
      useCaseId,
      workflowRunId,
      totalCredits: amount,
      costBreakdown,
    };

    const gateway = this.billingGateway;
    const result = gateway
      ? await gateway.reserve({ userId, amount, referenceId, metadata })
      : await this.walletService?.hold({ userId, amount, referenceId, metadata });

    return {
      billingStatus: BILLING_STATUS.RESERVED,
      billingHoldId: referenceId,
      referenceId,
      reservedCredits: amount,
      transaction: result,
    };
  }

  async settleUseCase(referenceId) {
    if (!referenceId) return { billingStatus: BILLING_STATUS.NOT_REQUIRED };
    const result = this.billingGateway
      ? await this.billingGateway.settle(referenceId)
      : await this.walletService?.commitHoldIdempotent?.(referenceId) || await this.walletService?.commit?.(referenceId);
    return { billingStatus: BILLING_STATUS.SETTLED, referenceId, transaction: result };
  }

  async rollbackUseCase(referenceId) {
    if (!referenceId) return { billingStatus: BILLING_STATUS.NOT_REQUIRED };
    const result = this.billingGateway
      ? await this.billingGateway.rollback(referenceId)
      : await this.walletService?.rollback?.(referenceId);
    return { billingStatus: BILLING_STATUS.REFUNDED, referenceId, transaction: result };
  }
}

export const useCaseBillingRuntime = new UseCaseBillingRuntime();
export default useCaseBillingRuntime;
