/**
 * System 2: Models Management — Execution Engine Subsystem (Internal)
 *
 * Encapsulates the Universal Model Runner, circuit breakers, error normalizers,
 * and runtime executors.
 */

import {
  run,
} from "./modelRunner.js";
import {
  circuitBreakerRegistry,
} from "./circuitBreaker.js";
import {
  normalizeError,
} from "./errorNormalizer.js";
import {
  RuntimeExecutor,
  defaultRuntimeExecutor,
} from "./runtimeExecutor.js";
import {
  idempotencyStore,
} from "./idempotencyStore.js";
import {
  resolveProviderRoute,
  registerProviderResolver,
  getRunner,
  registerProviderRunner,
  unregisterProviderRunner,
  executeProvider,
} from "../runtime/providerRuntimeRegistry.js";

export {
  run,
  circuitBreakerRegistry,
  normalizeError,
  RuntimeExecutor,
  defaultRuntimeExecutor,
  idempotencyStore,
  resolveProviderRoute,
  registerProviderResolver,
  getRunner,
  registerProviderRunner,
  unregisterProviderRunner,
  executeProvider,
};

export default {
  run,
  circuitBreakerRegistry,
  normalizeError,
  RuntimeExecutor,
  defaultRuntimeExecutor,
  idempotencyStore,
  resolveProviderRoute,
  registerProviderResolver,
  getRunner,
  registerProviderRunner,
  unregisterProviderRunner,
  executeProvider,
};
