export class WorkflowBillingGateway {
  constructor({ walletService = null } = {}) {
    this.walletService = walletService;
  }

  async reserve({ userId, amount = 0, referenceId, metadata = {} }) {
    if (!this.walletService) {
      return { kind: "NO_CHARGE", status: "ACTIVE", referenceId, amount: 0 };
    }
    if (typeof this.walletService.reserve === "function") {
      return this.walletService.reserve({ userId, amount, referenceId, metadata });
    }
    if (amount <= 0) {
      return { kind: "NO_CHARGE", status: "ACTIVE", referenceId, amount: 0 };
    }
    const result = await this.walletService.hold({ userId, amount, referenceId, metadata });
    return { kind: "CHARGEABLE", status: "HELD", referenceId, amount, transaction: result };
  }

  async settle(reservationOrRef) {
    if (!this.walletService || !reservationOrRef) return { status: "skipped" };

    if (typeof reservationOrRef === "object" && reservationOrRef.kind && typeof this.walletService.settle === "function") {
      return this.walletService.settle(reservationOrRef);
    }

    const referenceId = typeof reservationOrRef === "string" ? reservationOrRef : reservationOrRef.referenceId;
    const status = typeof reservationOrRef === "object" ? reservationOrRef.status : null;
    const amount = typeof reservationOrRef === "object" ? reservationOrRef.amount : null;

    if (status === "skipped" || (amount !== null && amount <= 0)) {
      return { status: "skipped", referenceId };
    }

    if (!referenceId) return { status: "skipped" };

    return this.walletService.commitHoldIdempotent
      ? this.walletService.commitHoldIdempotent(referenceId)
      : this.walletService.commit(referenceId);
  }

  async rollback(reservationOrRef) {
    if (!this.walletService || !reservationOrRef) return { status: "skipped" };

    if (typeof reservationOrRef === "object" && reservationOrRef.kind && typeof this.walletService.release === "function") {
      return this.walletService.release(reservationOrRef);
    }

    const referenceId = typeof reservationOrRef === "string" ? reservationOrRef : reservationOrRef.referenceId;
    const status = typeof reservationOrRef === "object" ? reservationOrRef.status : null;
    const amount = typeof reservationOrRef === "object" ? reservationOrRef.amount : null;

    if (status === "skipped" || (amount !== null && amount <= 0)) {
      return { status: "skipped", referenceId };
    }

    if (!referenceId) return { status: "skipped" };

    return this.walletService.rollback(referenceId);
  }
}

