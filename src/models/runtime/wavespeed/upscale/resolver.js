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
 * @param {object} semanticInput - Canonical semantic input (input_image, scale_factor, etc.)
 * @param {object} context       - Execution context { model }
 * @returns {object} Concrete execution route
 */
export function resolveUpscaleRoute(binding, semanticInput = {}, context = {}) {
  // If no routes declared, binding is single-route identity
  if (!Array.isArray(binding.routes) || binding.routes.length === 0) {
    return binding;
  }

  // Canonical normalization for upscale inputs:
  // Alias input_image <-> image_url so route rules match reliably
  const normalizedInput = { ...semanticInput };
  if (normalizedInput.input_image && !normalizedInput.image_url) {
    normalizedInput.image_url = normalizedInput.input_image;
  } else if (normalizedInput.image_url && !normalizedInput.input_image) {
    normalizedInput.input_image = normalizedInput.image_url;
  }

  return evaluateWaveSpeedRoutes(binding, binding.routes, normalizedInput, "upscale");
}

export const WaveSpeedUpscaleResolver = {
  resolve: resolveUpscaleRoute,
};

export default resolveUpscaleRoute;
