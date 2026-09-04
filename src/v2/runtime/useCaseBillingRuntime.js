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
      : (this.walletService?.reserve
          ? await this.walletService.reserve({ userId, amount, referenceId, metadata })
          : await this.walletService?.hold({ userId, amount, referenceId, metadata }));

    return {
      billingStatus: BILLING_STATUS.RESERVED,
      billingHoldId: referenceId,
      referenceId,
      reservedCredits: amount,
      reservation: result,
      transaction: result,
    };
  }

  async settleUseCase(reservationOrRef, extraMetadata = null) {
    if (!reservationOrRef) return { billingStatus: BILLING_STATUS.NOT_REQUIRED };
    const referenceId = typeof reservationOrRef === "string" ? reservationOrRef : reservationOrRef.referenceId;
    if (!referenceId) return { billingStatus: BILLING_STATUS.NOT_REQUIRED };

    let result;
    if (this.billingGateway) {
      result = await this.billingGateway.settle(reservationOrRef);
    } else if (typeof reservationOrRef === "object" && typeof this.walletService?.settle === "function") {
      result = await this.walletService.settle(reservationOrRef, extraMetadata);
    } else {
      result = await this.walletService?.commitHoldIdempotent?.(referenceId, extraMetadata) || await this.walletService?.commit?.(referenceId, extraMetadata);
    }

    return { billingStatus: BILLING_STATUS.SETTLED, referenceId, transaction: result };
  }

  async rollbackUseCase(reservationOrRef, extraMetadata = null) {
    if (!reservationOrRef) return { billingStatus: BILLING_STATUS.NOT_REQUIRED };
    const referenceId = typeof reservationOrRef === "string" ? reservationOrRef : reservationOrRef.referenceId;
    if (!referenceId) return { billingStatus: BILLING_STATUS.NOT_REQUIRED };

    let result;
    if (this.billingGateway) {
      result = await this.billingGateway.rollback(reservationOrRef);
    } else if (typeof reservationOrRef === "object" && typeof this.walletService?.release === "function") {
      result = await this.walletService.release(reservationOrRef, extraMetadata);
    } else {
      result = await this.walletService?.rollback?.(referenceId, extraMetadata);
    }

    return { billingStatus: BILLING_STATUS.REFUNDED, referenceId, transaction: result };
  }
}

export const useCaseBillingRuntime = new UseCaseBillingRuntime();
export default useCaseBillingRuntime;
