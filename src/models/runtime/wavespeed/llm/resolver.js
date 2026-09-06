import { evaluateWaveSpeedRoutes } from "../common/routeEvaluator.js";

/**
 * WaveSpeed LLM Topology Resolver
 *
 * Handles WaveSpeed LLM execution topologies:
 *   - text / chat completion
 *   - vision / multimodal analysis (when images present)
 *   - streaming execution variants
 *
 * Driven entirely by declarative route configuration (`when` rules).
 * No model-specific branching.
 *
 * @param {object} binding       - WaveSpeed binding manifest
 * @param {object} semanticInput - Canonical semantic input (messages, prompt, images, etc.)
 * @param {object} context       - Execution context { model }
 * @returns {object} Concrete execution route
 */
export function resolveLlmRoute(binding, semanticInput = {}, context = {}) {
  // If no routes declared, binding is single-route identity
  if (!Array.isArray(binding.routes) || binding.routes.length === 0) {
    return binding;
  }

  return evaluateWaveSpeedRoutes(binding, binding.routes, semanticInput, "llm");
}

export const WaveSpeedLLMResolver = {
  resolve: resolveLlmRoute,
};
