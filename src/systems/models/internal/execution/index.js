/**
 * System 2: Models Management — Execution Engine Subsystem (Internal)
 *
 * Encapsulates the Universal Model Runner, circuit breakers, error normalizers,
 * and runtime executors.
 */

import {
  run,
} from "../../../../models/execution/modelRunner.js";
import {
  circuitBreakerRegistry,
} from "../../../../models/execution/circuitBreaker.js";
import {
  normalizeError,
} from "../../../../models/execution/errorNormalizer.js";
import {
  defaultRuntimeExecutor,
} from "../../../../models/execution/runtimeExecutor.js";
import {
  idempotencyStore,
} from "../../../../models/execution/idempotencyStore.js";

export {
  run,
  circuitBreakerRegistry,
  normalizeError,
  defaultRuntimeExecutor,
  idempotencyStore,
};

export default {
  run,
  circuitBreakerRegistry,
  normalizeError,
  defaultRuntimeExecutor,
  idempotencyStore,
};
