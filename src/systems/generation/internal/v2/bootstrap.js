import { initializeGateways, getGateways } from "./runner/workflowRunner.js";
import { registerAllUseCases } from "../use-cases/registerUseCases.js";
import { createLogger } from "#shared";

const systemLogger = createLogger("system");

let _defaultGatewaysProvider = null;

/**
 * Configures default gateway provider without static circular imports to container.js.
 * @param {Function} provider
 */
export function configureDefaultGateways(provider) {
  _defaultGatewaysProvider = provider;
}

/**
 * Bootstrap the V2 Composable Workflow Engine & Use Case Registry.
 * Wires shared gateways and configures runner dependencies.
 *
 * @param {Object} [gateways={}]
 */
export function bootstrapV2(gateways = {}) {
  let { billing, storage, events } = gateways;

  if (!billing || !storage || !events) {
    if (typeof _defaultGatewaysProvider === "function") {
      try {
        const provided = _defaultGatewaysProvider();
        billing = billing || provided.billing;
        storage = storage || provided.storage;
        events = events || provided.events;
      } catch (err) {
        systemLogger.warn("Failed to retrieve default gateways: " + err.message);
      }
    }
  }

  if (billing || storage || events) {
    systemLogger.debug("Wiring shared gateways...");
    initializeGateways({
      billing,
      storage,
      events,
    });
  }

  // Register all Use Cases (image-generation-v1, video-generation-v1, etc.)
  registerAllUseCases();

  systemLogger.debug("V2 Workflow Engine & Use Cases successfully bootstrapped");
}
