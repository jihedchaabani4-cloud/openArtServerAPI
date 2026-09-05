import path from "path";
import { fileURLToPath } from "url";
import { getProvider } from "../registry/modelRegistry.js";
import { ConfigIntegrityError } from "../errors/index.js";
import { createLogger } from "../../infrastructure/logging/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger("models");

/**
 * Provider Runtime Registry (Freeze V2 — Zero Silent Fallback)
 *
 * Maps providerId → runnerFn based on explicit provider manifest declaration.
 *
 * ── Architecture Principle ─────────────────────────────────────────────────
 * ZERO SILENT FALLBACK:
 * If a provider declares runtime="sdk" and its dedicated runner cannot be loaded,
 * the system throws ConfigIntegrityError immediately.
 *
 * If a provider does not declare runtime="generic" or runtime="sdk",
 * the system throws ConfigIntegrityError.
 *
 * The system NEVER guesses or silently falls back to generic REST.
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
 *
 * @param {string} providerId
 * @returns {Promise<Function>}
 */
export async function getRunner(providerId) {
  // 1. Manual override (injected at test/boot time)
  if (manualRunners.has(providerId)) {
    return manualRunners.get(providerId);
  }

  // 2. Cached from previous resolution
  if (cachedRunners.has(providerId)) {
    return cachedRunners.get(providerId);
  }

  // 3. Look up provider declaration in modelRegistry
  let providerConfig;
  try {
    providerConfig = getProvider(providerId);
  } catch (err) {
    // If not found in registry (e.g. unknown provider reference), propagate error
    throw err;
  }

  const runtimeType = providerConfig.runtime || providerConfig.clientType;
  if (!runtimeType) {
    throw new ConfigIntegrityError(
      `Provider "${providerId}" has no explicit "runtime" declared in provider manifest`
    );
  }

  // 4. Explicit Generic REST Runner
  if (runtimeType === "generic" || runtimeType === "api" || runtimeType === "rest") {
    const genericRunnerPath = path.join(__dirname, "generic", "restRunner.js");
    const genericMod = await import(`file://${genericRunnerPath}`);
    const genericRunner = genericMod.run;
    cachedRunners.set(providerId, genericRunner);
    logger.debug(
      { providerId, source: "runtime/generic/restRunner.js" },
      `[RuntimeRegistry] Loaded declared generic REST runner for provider "${providerId}"`
    );
    return genericRunner;
  }

  // 5. Dedicated SDK Runner
  if (runtimeType === "sdk") {
    const specificRunnerPath = path.join(__dirname, providerId, "runner.js");
    try {
      const mod = await import(`file://${specificRunnerPath}`);
      if (typeof mod.run !== "function") {
        throw new ConfigIntegrityError(
          `Dedicated runner runtime/${providerId}/runner.js must export a named "run" function`
        );
      }
      const runnerFn = mod.run;
      cachedRunners.set(providerId, runnerFn);
      logger.debug(
        { providerId, source: `runtime/${providerId}/runner.js` },
        `[RuntimeRegistry] Loaded dedicated SDK runner for provider "${providerId}"`
      );
      return runnerFn;
    } catch (err) {
      if (err instanceof ConfigIntegrityError) throw err;
      throw new ConfigIntegrityError(
        `Provider "${providerId}" declared runtime "sdk" but dedicated runner ` +
        `runtime/${providerId}/runner.js was not found or failed to load: ${err.message}`
      );
    }
  }

  throw new ConfigIntegrityError(
    `Provider "${providerId}" declared unrecognized runtime type "${runtimeType}". Valid types: "sdk", "generic"`
  );
}

/**
 * Execute a model operation through the registered provider runner.
 *
 * @param {object} args
 * @param {object} args.provider        - Provider config object from providers/*.json
 * @param {object} args.binding         - Binding manifest
 * @param {object} args.payload         - Provider-mapped payload
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
