import { evaluateWaveSpeedRoutes } from "../common/routeEvaluator.js";

/**
 * WaveSpeed Video Topology Resolver
 *
 * Handles WaveSpeed video execution topologies:
 *   - text-to-video (generation)
 *   - image-to-video (first frame / input image animation)
 *   - video-to-video (transformation / motion guidance)
 *   - reference-to-video
 *
 * Driven entirely by declarative route configuration (`when` rules).
 * No model-specific branching.
 *
 * @param {object} binding       - WaveSpeed binding manifest
 * @param {object} semanticInput - Canonical semantic input (prompt, duration, input_image, etc.)
 * @param {object} context       - Execution context { model }
 * @returns {object} Concrete execution route
 */
export function resolveVideoRoute(binding, semanticInput = {}, context = {}) {
  // If no routes declared, binding is single-route identity
  if (!Array.isArray(binding.routes) || binding.routes.length === 0) {
    return binding;
  }

  // Canonical normalization for video inputs:
  // Alias input_image <-> image_url and input_video <-> video_url so route rules match reliably
  const normalizedInput = { ...semanticInput };
  if (normalizedInput.input_image && !normalizedInput.image_url) {
    normalizedInput.image_url = normalizedInput.input_image;
  } else if (normalizedInput.image_url && !normalizedInput.input_image) {
    normalizedInput.input_image = normalizedInput.image_url;
  }

  if (normalizedInput.input_video && !normalizedInput.video_url) {
    normalizedInput.video_url = normalizedInput.input_video;
  } else if (normalizedInput.video_url && !normalizedInput.input_video) {
    normalizedInput.input_video = normalizedInput.video_url;
  }

  return evaluateWaveSpeedRoutes(binding, binding.routes, normalizedInput, "video");
}

export const WaveSpeedVideoResolver = {
  resolve: resolveVideoRoute,
};
