import { evaluateWaveSpeedRoutes } from "../common/routeEvaluator.js";

/**
 * WaveSpeed Image Topology Resolver
 *
 * Handles WaveSpeed image execution topologies:
 *   - text-to-image (generation)
 *   - image-to-image / edit
 *   - inpaint (image + mask)
 *   - reference-guided generation
 *
 * Driven entirely by declarative route configuration (`when` rules).
 * No model-specific branching.
 *
 * @param {object} binding       - WaveSpeed binding manifest
 * @param {object} semanticInput - Canonical semantic input (prompt, input_image, mask, etc.)
 * @param {object} context       - Execution context { model }
 * @returns {object} Concrete execution route
 */
export function resolveImageRoute(binding, semanticInput = {}, context = {}) {
  // If no routes declared, binding is single-route identity
  if (!Array.isArray(binding.routes) || binding.routes.length === 0) {
    return binding;
  }

  return evaluateWaveSpeedRoutes(binding, binding.routes, semanticInput, "image");
}

export const WaveSpeedImageResolver = {
  resolve: resolveImageRoute,
};
