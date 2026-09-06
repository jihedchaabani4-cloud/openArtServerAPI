import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { getProvider } from "../registry/modelRegistry.js";
import { ConfigIntegrityError } from "../errors/index.js";
import { createLogger } from "../../infrastructure/logging/index.js";

import { resolveWaveSpeedRoute } from "./wavespeed/resolver.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger("models");

/**
 * Provider Resolver Registry
 * Maps providerId to provider-owned execution topology resolvers.
 */
const providerResolvers = new Map([
  ["wavespeed", resolveWaveSpeedRoute],
]);

/**
 * Resolves the concrete execution route through the provider-owned resolver.
 * Providers with custom topologies (like WaveSpeed) resolve their own routes.
 * Providers without custom resolvers (like Google) return the binding directly.
 *
 * @param {string} providerId
 * @param {object} binding
 * @param {object} semanticInput
 * @param {object} [context={}]
 * @returns {object} resolved concrete route
 */
export function resolveProviderRoute(providerId, binding, semanticInput = {}, context = {}) {
  const resolver = providerResolvers.get(providerId);
  if (typeof resolver === "function") {
    return resolver(binding, semanticInput, context);
  }
  return binding;
}

/**
 * Register a custom provider resolver (e.g. for extensions or mock providers).
 * @param {string} providerId
 * @param {Function} resolverFn
 */
export function registerProviderResolver(providerId, resolverFn) {
  providerResolvers.set(providerId, resolverFn);
}

/**
 * Provider Runtime Registry (Phase 1 — Zero Silent Fallback)
 *
 * Maps providerId to runnerFn based on explicit provider manifest declaration.
 * runtime="sdk"     => loads runtime/<provider>/runner.js
 * runtime="generic" => loads runtime/generic/restRunner.js
 * Anything else     => ConfigIntegrityError
 *
 * ZERO SILENT FALLBACK: no guessing, no default to generic if sdk is declared.
 */
const cachedRunners = new Map();

/**
 * Get the runner function for a given provider.
 * @param {string} providerId
 * @returns {Promise<Function>}
 */
export async function getRunner(providerId) {
  if (cachedRunners.has(providerId)) {
    return cachedRunners.get(providerId);
  }

  const providerConfig = getProvider(providerId);
  const runtimeType = providerConfig.runtime || providerConfig.clientType;

  if (!runtimeType) {
    throw new ConfigIntegrityError(
      `Provider "${providerId}" has no explicit "runtime" declared in provider manifest`
    );
  }

  if (runtimeType === "generic" || runtimeType === "api" || runtimeType === "rest") {
    const genericRunnerPath = path.join(__dirname, "generic", "restRunner.js");
    const genericMod = await import(pathToFileURL(genericRunnerPath).href);
    const genericRunner = genericMod.run;
    cachedRunners.set(providerId, genericRunner);
    logger.debug({ providerId }, `[RuntimeRegistry] Loaded generic REST runner for "${providerId}"`);
    return genericRunner;
  }

  if (runtimeType === "sdk") {
    const specificRunnerPath = path.join(__dirname, providerId, "runner.js");
    try {
      const mod = await import(pathToFileURL(specificRunnerPath).href);
      if (typeof mod.run !== "function") {
        throw new ConfigIntegrityError(
          `Dedicated runner runtime/${providerId}/runner.js must export a named "run" function`
        );
      }
      cachedRunners.set(providerId, mod.run);
      logger.debug({ providerId }, `[RuntimeRegistry] Loaded SDK runner for "${providerId}"`);
      return mod.run;
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
 * @param {object} args
 * @returns {Promise<any>} rawResponse
 */
export async function executeProvider({ provider, binding, payload, credential, timeoutMs, options = {} }) {
  // Allow injected sdkRunner for integration testing without real HTTP calls
  if (typeof options.sdkRunner === "function") {
    return options.sdkRunner({ provider, binding, payload, credential, timeoutMs, options });
  }
  const runnerFn = await getRunner(provider.id);
  return runnerFn({ provider, binding, payload, credential, timeoutMs, options });
}
