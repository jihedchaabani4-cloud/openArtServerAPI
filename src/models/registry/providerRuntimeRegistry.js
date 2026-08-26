import { ConfigIntegrityError } from "../errors/index.js";

// Providers Dedicated Clients
import { WaveSpeedClient } from "../../providers/wavespeed/client.js";
import { GoogleClient } from "../../providers/google/client.js";
import { GroqClient } from "../../providers/groq/client.js";
import { FalClient } from "../../providers/fal/client.js";
import { ReplicateClient } from "../../providers/replicate/client.js";

// Providers Adapters
import { wavespeedAdapter } from "../../adapters/wavespeedAdapter.js";
import { googleAdapter } from "../../adapters/googleAdapter.js";
import { groqAdapter } from "../../adapters/groqAdapter.js";
import { falAdapter } from "../../adapters/falAdapter.js";
import { replicateAdapter } from "../../adapters/replicateAdapter.js";

const clientRegistry = new Map();
const adapterRegistry = new Map();

/**
 * Registers a runtime ClientClass and Adapter for a provider.
 * @param {string} providerId
 * @param {{ ClientClass: Function, adapter: object }} runtime
 */
export function registerProviderRuntime(providerId, { ClientClass, adapter }) {
  if (!providerId || typeof providerId !== "string") {
    throw new ConfigIntegrityError("Provider ID must be a non-empty string");
  }
  if (!ClientClass || typeof ClientClass !== "function") {
    throw new ConfigIntegrityError(`ClientClass for provider "${providerId}" must be a constructor/class`);
  }
  if (!adapter || typeof adapter !== "object") {
    throw new ConfigIntegrityError(`Adapter for provider "${providerId}" must be an object`);
  }

  clientRegistry.set(providerId, ClientClass);
  adapterRegistry.set(providerId, adapter);
}

/**
 * Resolves and instantiates a Provider Client for execution.
 * @param {string} providerId
 * @param {object} config
 * @returns {object} ProviderClient instance implementing execute()
 */
export function getProviderClient(providerId, config = {}) {
  const ClientClass = clientRegistry.get(providerId);
  if (!ClientClass) {
    throw new ConfigIntegrityError(`No registered provider client runtime found for provider "${providerId}"`);
  }
  return new ClientClass(config);
}

/**
 * Resolves the Adapter for a provider.
 * @param {string} providerId
 * @returns {object} ProviderAdapter instance implementing toProviderPayload and fromProviderResponse
 */
export function getProviderAdapter(providerId) {
  const adapter = adapterRegistry.get(providerId);
  if (!adapter) {
    throw new ConfigIntegrityError(`No registered provider adapter found for provider "${providerId}"`);
  }
  return adapter;
}

/**
 * Returns all registered provider IDs.
 * @returns {string[]}
 */
export function listRegisteredRuntimes() {
  return Array.from(clientRegistry.keys());
}

// ── Auto-register Built-in Providers ─────────────────────────────────────────
registerProviderRuntime("wavespeed", { ClientClass: WaveSpeedClient, adapter: wavespeedAdapter });
registerProviderRuntime("google",    { ClientClass: GoogleClient,    adapter: googleAdapter });
registerProviderRuntime("groq",      { ClientClass: GroqClient,      adapter: groqAdapter });
registerProviderRuntime("fal",       { ClientClass: FalClient,       adapter: falAdapter });
registerProviderRuntime("replicate", { ClientClass: ReplicateClient, adapter: replicateAdapter });
