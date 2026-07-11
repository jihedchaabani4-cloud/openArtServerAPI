export class ProviderResolutionRecorder {
  constructor({ eventRecorder = null } = {}) {
    this.eventRecorder = eventRecorder;
    this.decisions = [];
  }

  record(decision) {
    this.decisions.push(decision);
    this.eventRecorder?.record?.({
      executionId: decision.executionId,
      operation: "provider.resolution",
      status: "success",
      metadata: {
        capabilityId: decision.capabilityId,
        selectedProvider: decision.selectedProvider,
        eligibleProviders: decision.eligibleProviders,
        fallbackChain: decision.fallbackChain,
      },
    });
    return decision;
  }

  list() {
    return [...this.decisions];
  }
}
