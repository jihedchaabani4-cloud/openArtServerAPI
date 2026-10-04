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

  async reserveUseCase({
    userId,
    useCaseId,
    workflowRunId = null,
    workflowId = null,
    mediaId = null,
    totalCredits,
    costBreakdown = null,
    idempotencyKey = null,
  } = {}) {
    if (typeof totalCredits !== "number" || Number.isNaN(totalCredits) || !Number.isFinite(totalCredits) || totalCredits < 0) {
      const err = new Error(`Invalid billing amount for UseCase "${useCaseId}": ${totalCredits}. Amount must be a finite, non-negative number.`);
      err.code = "PRICING_CONFIG_ERROR";
      err.category = "SERVER_FAULT";
      err.statusCode = 500;
      throw err;
    }
    const amount = Math.ceil(totalCredits);
    const referenceId = this.buildReferenceId({ workflowRunId, useCaseId, userId, idempotencyKey });

    if (amount === 0) {
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
      workflowId: workflowId || workflowRunId,
      mediaId,
      totalCredits: amount,
      costBreakdown,
    };


    const gateway = this.billingGateway;
    if (!gateway && !this.walletService) {
      const err = new Error(`Cannot reserve ${amount} credits for UseCase "${useCaseId}": WalletService is not configured.`);
      err.code = "WALLET_NOT_CONFIGURED";
      err.category = "SERVER_FAULT";
      err.statusCode = 500;
      throw err;
    }
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
    } else if (typeof this.walletService?.rollback === "function") {
      result = await this.walletService.rollback(referenceId, extraMetadata);
    } else if (typeof this.walletService?.release === "function") {
      result = await this.walletService.release(referenceId, extraMetadata);
    } else {
      result = await this.walletService?.rollbackTransaction?.(referenceId, extraMetadata);
    }

    return { billingStatus: BILLING_STATUS.REFUNDED, referenceId, transaction: result };
  }
}

export const useCaseBillingRuntime = new UseCaseBillingRuntime();
export default useCaseBillingRuntime;
