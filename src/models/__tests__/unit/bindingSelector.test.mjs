import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { selectBinding } from "../../registry/bindingSelector.js";
import { CircuitBreakerRegistry } from "../../execution/circuitBreaker.js";
import {
  UnsupportedCapabilityError,
  AllProvidersUnavailableError
} from "../../errors/index.js";

describe("Two-Phase Binding Selector (US2)", () => {
  let mockRegistry;
  let cb;

  beforeEach(() => {
    cb = new CircuitBreakerRegistry({ failureThreshold: 2, cooldownDurationMs: 500 });
  });

  const sampleBindings = [
    {
      modelId: "nanobana_pro",
      operation: "text_to_image",
      providerId: "wavespeed",
      priority: 1,
      status: "active",
      parameterMap: {
        resolution: {
          providerField: "size",
          valueMap: { "1k": "1024x1024", "2k": "2048x2048", "4k": "4096x4096" }
        }
      }
    },
    {
      modelId: "nanobana_pro",
      operation: "text_to_image",
      providerId: "google",
      priority: 2,
      status: "active",
      parameterMap: {
        resolution: {
          providerField: "imageSize",
          valueMap: { "1k": "small", "2k": "medium" } // Note: no 4k
        }
      }
    }
  ];

  it("should select Priority 1 provider when both support the requested resolution", () => {
    const binding = selectBinding("nanobana_pro", "text_to_image", { resolution: "2k" }, {
      bindings: sampleBindings,
      circuitBreaker: cb
    });
    assert.equal(binding.providerId, "wavespeed");
  });

  it("should filter out Google during capability filter when 4k is requested and select WaveSpeed", () => {
    const binding = selectBinding("nanobana_pro", "text_to_image", { resolution: "4k" }, {
      bindings: sampleBindings,
      circuitBreaker: cb
    });
    assert.equal(binding.providerId, "wavespeed");
  });

  it("should throw UnsupportedCapabilityError if no provider supports requested value", () => {
    assert.throws(
      () => selectBinding("nanobana_pro", "text_to_image", { resolution: "8k" }, {
        bindings: sampleBindings,
        circuitBreaker: cb
      }),
      UnsupportedCapabilityError
    );
  });

  it("should failover to Google (Priority 2) when WaveSpeed circuit breaker is OPEN", () => {
    const wavespeedId = "nanobana_pro:text_to_image:wavespeed";
    cb.recordFailure(wavespeedId);
    cb.recordFailure(wavespeedId); // Trips breaker to OPEN

    const binding = selectBinding("nanobana_pro", "text_to_image", { resolution: "2k" }, {
      bindings: sampleBindings,
      circuitBreaker: cb
    });
    assert.equal(binding.providerId, "google");
  });

  it("should throw AllProvidersUnavailableError if WaveSpeed is tripped and 4k is requested", () => {
    const wavespeedId = "nanobana_pro:text_to_image:wavespeed";
    cb.recordFailure(wavespeedId);
    cb.recordFailure(wavespeedId);

    // WaveSpeed is OPEN, Google doesn't support 4K -> should throw AllProvidersUnavailableError
    assert.throws(
      () => selectBinding("nanobana_pro", "text_to_image", { resolution: "4k" }, {
        bindings: sampleBindings,
        circuitBreaker: cb
      }),
      AllProvidersUnavailableError
    );
  });
});
