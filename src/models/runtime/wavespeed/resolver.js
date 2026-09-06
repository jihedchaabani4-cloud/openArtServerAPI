import { resolveImageRoute } from "./image/resolver.js";
import { resolveVideoRoute } from "./video/resolver.js";
import { resolveLlmRoute } from "./llm/resolver.js";
import { resolveUpscaleRoute } from "./upscale/resolver.js";
import { UnsupportedCapabilityError } from "../../errors/index.js";

/**
 * WaveSpeed Provider Execution Topology Resolver
 *
 * Owned exclusively by the WaveSpeed Provider Execution Layer.
 * Entrypoint for WaveSpeed route resolution.
 *
 * Resolves the concrete execution plan based on:
 *   1. Model Domain / Category (image, video, llm, upscale)
 *   2. WaveSpeed model configuration (binding.routes)
 *   3. Semantic parameters
 *
 * Invariants:
 *   - Provider-owned: generic Models Core has zero knowledge of WaveSpeed routes
 *   - Configuration-driven: zero model-specific if/else statements
 *   - Fail-fast: unmapped domains throw UnsupportedCapabilityError
 *
 * @param {object} binding       - WaveSpeed binding manifest
 * @param {object} semanticInput - Canonical semantic inputs
 * @param {object} [context={}]  - Execution context { model }
 * @returns {object} Concrete execution route with merged configuration
 */
export function resolveWaveSpeedRoute(binding, semanticInput = {}, context = {}) {
  if (!binding) return null;

  // Domain belongs to the logical model; fallback to binding declaration
  const domain = context.model?.domain || binding.domain || "image";

  switch (domain) {
    case "image":
      return resolveImageRoute(binding, semanticInput, context);
    case "video":
      return resolveVideoRoute(binding, semanticInput, context);
    case "llm":
      return resolveLlmRoute(binding, semanticInput, context);
    case "upscale":
      return resolveUpscaleRoute(binding, semanticInput, context);
    default:
      throw new UnsupportedCapabilityError(
        `WaveSpeed execution topology does not support model domain "${domain}" for model "${binding.modelId}"`
      );
  }
}

export default resolveWaveSpeedRoute;
