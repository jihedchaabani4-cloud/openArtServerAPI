import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  CircuitBreakerRegistry,
  circuitBreakerRegistry
} from "../../execution/circuitBreaker.js";

describe("Circuit Breaker (US2)", () => {
  let cb;

  beforeEach(() => {
    cb = new CircuitBreakerRegistry({ failureThreshold: 3, cooldownDurationMs: 100 });
  });

  it("should start in CLOSED state and report available", () => {
    const id = "modelA:op1:providerA";
    assert.equal(cb.getState(id), "CLOSED");
    assert.equal(cb.isAvailable(id), true);
  });

  it("should transition from CLOSED to OPEN after reaching failure threshold", () => {
    const id = "modelA:op1:providerA";
    cb.recordFailure(id);
    cb.recordFailure(id);
    assert.equal(cb.getState(id), "CLOSED");
    assert.equal(cb.isAvailable(id), true);

    cb.recordFailure(id); // 3rd failure
    assert.equal(cb.getState(id), "OPEN");
    assert.equal(cb.isAvailable(id), false);
  });

  it("should transition from OPEN to HALF-OPEN after cooldown elapses", async () => {
    const id = "modelA:op1:providerA";
    cb.recordFailure(id);
    cb.recordFailure(id);
    cb.recordFailure(id);
    assert.equal(cb.getState(id), "OPEN");

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 110));

    assert.equal(cb.getState(id), "HALF-OPEN");
    assert.equal(cb.isAvailable(id), true); // Allows canary
  });

  it("should reset to CLOSED when canary request succeeds in HALF-OPEN", async () => {
    const id = "modelA:op1:providerA";
    cb.recordFailure(id);
    cb.recordFailure(id);
    cb.recordFailure(id);

    await new Promise((r) => setTimeout(r, 110));
    assert.equal(cb.getState(id), "HALF-OPEN");

    cb.recordSuccess(id);
    assert.equal(cb.getState(id), "CLOSED");
    assert.equal(cb.isAvailable(id), true);
  });

  it("should return to OPEN if canary request fails in HALF-OPEN", async () => {
    const id = "modelA:op1:providerA";
    cb.recordFailure(id);
    cb.recordFailure(id);
    cb.recordFailure(id);

    await new Promise((r) => setTimeout(r, 110));
    assert.equal(cb.getState(id), "HALF-OPEN");

    cb.recordFailure(id);
    assert.equal(cb.getState(id), "OPEN");
    assert.equal(cb.isAvailable(id), false);
  });
});
