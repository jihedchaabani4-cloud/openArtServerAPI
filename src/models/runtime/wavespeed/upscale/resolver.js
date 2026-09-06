import { evaluateWaveSpeedRoutes } from "../common/routeEvaluator.js";

/**
 * WaveSpeed Upscale Topology Resolver
 *
 * Handles WaveSpeed upscale execution topologies:
 *   - image upscale
 *   - video upscale
 *   - face restoration / quality enhancement variants
 *
 * Driven entirely by declarative route configuration (`when` rules).
 * No model-specific branching.
 *
 * @param {object} binding       - WaveSpeed binding manifest
 * @param {object} semanticInput - Canonical semantic input (image_url, scale_factor, etc.)
 * @param {object} context       - Execution context { model }
 * @returns {object} Concrete execution route
 */
export function resolveUpscaleRoute(binding, semanticInput = {}, context = {}) {
  // If no routes declared, binding is single-route identity
  if (!Array.isArray(binding.routes) || binding.routes.length === 0) {
    return binding;
  }

  return evaluateWaveSpeedRoutes(binding, binding.routes, semanticInput, "upscale");
}

export const WaveSpeedUpscaleResolver = {
  resolve: resolveUpscaleRoute,
};
