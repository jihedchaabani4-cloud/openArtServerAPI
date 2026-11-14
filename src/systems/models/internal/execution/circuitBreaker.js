/**
 * Isolated Circuit Breaker Registry
 * Maintains CLOSED, OPEN, and HALF-OPEN states per model binding.
 */
export class CircuitBreakerRegistry {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.cooldownDurationMs = options.cooldownDurationMs || 60000;
    this.states = new Map();
  }

  _getOrCreate(bindingId) {
    if (!this.states.has(bindingId)) {
      this.states.set(bindingId, {
        state: "CLOSED",
        consecutiveFailures: 0,
        lastFailureTimestamp: null,
        cooldownUntil: null,
        canaryInFlight: false,
      });
    }
    return this.states.get(bindingId);
  }

  getState(bindingId) {
    const entry = this._getOrCreate(bindingId);
    if (entry.state === "OPEN") {
      if (Date.now() >= entry.cooldownUntil) {
        entry.state = "HALF-OPEN";
        entry.canaryInFlight = false;
      }
    }
    return entry.state;
  }

  isAvailable(bindingId) {
    const state = this.getState(bindingId);
    if (state === "CLOSED") return true;
    if (state === "HALF-OPEN") {
      const entry = this._getOrCreate(bindingId);
      if (!entry.canaryInFlight) {
        entry.canaryInFlight = true;
        return true;
      }
      return false;
    }
    return false;
  }

  recordSuccess(bindingId) {
    const entry = this._getOrCreate(bindingId);
    entry.state = "CLOSED";
    entry.consecutiveFailures = 0;
    entry.lastFailureTimestamp = null;
    entry.cooldownUntil = null;
    entry.canaryInFlight = false;
  }

  recordFailure(bindingId) {
    const entry = this._getOrCreate(bindingId);
    entry.consecutiveFailures += 1;
    entry.lastFailureTimestamp = Date.now();
    entry.canaryInFlight = false;

    if (entry.state === "HALF-OPEN" || entry.consecutiveFailures >= this.failureThreshold) {
      entry.state = "OPEN";
      entry.cooldownUntil = Date.now() + this.cooldownDurationMs;
    }
  }
}

export const circuitBreakerRegistry = new CircuitBreakerRegistry();
