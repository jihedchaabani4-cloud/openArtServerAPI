import path from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../../infrastructure/logging/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger("models");

/**
 * Provider Runtime Registry
 *
 * Maps providerId → runnerFn.
 *
 * Resolution order:
 *   1. Manually registered runner (via registerRunner — useful for tests / overrides)
 *   2. Auto-discovered runner from runtime/<providerId>/runner.js
 *   3. Generic REST runner (runtime/generic/restRunner.js) as universal fallback
 *
 * ── Architecture Principle ─────────────────────────────────────────────────
 * No if (providerId === "wavespeed") ... if (providerId === "google") allowed.
 * Adding a new provider requires only:
 *   a) A JSON config in models/providers/<id>.json
 *   b) An optional runtime/<id>/runner.js (if generic REST is insufficient)
 * ────────────────────────────────────────────────────────────────────────────
 */
const manualRunners = new Map();
const cachedRunners = new Map();

/**
 * Manually register a runner function for a provider.
 * Useful for tests, mocking, or overrides.
 *
 * @param {string} providerId
 * @param {Function} runnerFn  async (args) => rawResponse
 */
export function registerRunner(providerId, runnerFn) {
  if (typeof runnerFn !== "function") {
    throw new Error(`registerRunner: runnerFn for "${providerId}" must be a function`);
  }
  manualRunners.set(providerId, runnerFn);
}

/**
 * Get the runner function for a given provider.
 * Auto-discovers from filesystem on first call; caches thereafter.
 *
 * @param {string} providerId
 * @returns {Promise<Function>}
 */
export async function getRunner(providerId) {
  // 1. Manual override (injected at test/boot time)
  if (manualRunners.has(providerId)) {
    return manualRunners.get(providerId);
  }

  // 2. Cached from previous auto-discovery
  if (cachedRunners.has(providerId)) {
    return cachedRunners.get(providerId);
  }

  // 3. Auto-discover: try runtime/<providerId>/runner.js
  const specificRunnerPath = path.join(__dirname, providerId, "runner.js");
  try {
    const mod = await import(`file://${specificRunnerPath}`);
    if (typeof mod.run !== "function") {
      throw new Error(`runtime/${providerId}/runner.js must export a named "run" function`);
    }
    const runnerFn = mod.run;
    cachedRunners.set(providerId, runnerFn);
    logger.debug(
      { providerId, source: `runtime/${providerId}/runner.js` },
      `[RuntimeRegistry] Loaded dedicated runner for provider "${providerId}"`
    );
    return runnerFn;
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND" && !err.message?.includes("Cannot find")) {
      // Real error in the runner module — re-throw
      throw err;
    }
    // No dedicated runner found — fall through to generic
  }

  // 4. Fallback: generic REST runner
  const genericRunnerPath = path.join(__dirname, "generic", "restRunner.js");
  const genericMod = await import(`file://${genericRunnerPath}`);
  const genericRunner = genericMod.run;
  cachedRunners.set(providerId, genericRunner);
  logger.debug(
    { providerId, source: "runtime/generic/restRunner.js" },
    `[RuntimeRegistry] No dedicated runner for "${providerId}". Using generic REST runner.`
  );
  return genericRunner;
}

/**
 * Execute a model operation through the registered provider runner.
 * This is the primary entry point replacing executeProviderSdk().
 *
 * @param {object} args
 * @param {object} args.provider     - Provider config object from providers/*.json
 * @param {object} args.binding      - Binding manifest
 * @param {object} args.payload      - Provider-mapped payload
 * @param {string|null} args.credential - Resolved API key
 * @param {number} [args.timeoutMs]
 * @param {object} [args.options]
 * @returns {Promise<any>} rawResponse
 */
export async function executeProvider({ provider, binding, payload, credential, timeoutMs, options = {} }) {
  const providerId = provider.id;

  // Allow injected sdkRunner for unit tests
  if (typeof options.sdkRunner === "function") {
    return options.sdkRunner({ provider, binding, payload, credential, timeoutMs, options });
  }

  const runnerFn = await getRunner(providerId);
  return runnerFn({ provider, binding, payload, credential, timeoutMs, options });
}

/**
 * Reset all cached runners (useful in tests).
 */
export function resetRuntimeRegistry() {
  manualRunners.clear();
  cachedRunners.clear();
}
