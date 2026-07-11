export class WorkflowBillingGateway {
  constructor({ walletService = null } = {}) {
    this.walletService = walletService;
  }

  async reserve({ userId, amount = 0, referenceId, metadata = {} }) {
    if (!this.walletService || amount <= 0) {
      return { status: "skipped", referenceId, amount };
    }
    return this.walletService.hold({ userId, amount, referenceId, metadata });
  }

  async settle(referenceId) {
    if (!this.walletService || !referenceId) return { status: "skipped", referenceId };
    return this.walletService.commitHoldIdempotent
      ? this.walletService.commitHoldIdempotent(referenceId)
      : this.walletService.commit(referenceId);
  }

  async rollback(referenceId) {
    if (!this.walletService || !referenceId) return { status: "skipped", referenceId };
    return this.walletService.rollback(referenceId);
  }
}
