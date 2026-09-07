import { resolveImageRoute } from "./image/resolver.js";
import { resolveVideoRoute } from "./video/resolver.js";
import { resolveUpscaleRoute } from "./upscale/resolver.js";
import { UnsupportedCapabilityError } from "../../errors/index.js";

/**
 * WaveSpeed Provider Execution Topology Resolver
 *
 * Owned exclusively by the WaveSpeed Provider Execution Layer.
 * Entrypoint for WaveSpeed route resolution.
 *
 * Supported topologies for this phase:
 *   - image (text-to-image, edit, inpaint, composition)
 *   - video (text-to-video, image-to-video, video-to-video)
 *   - upscale (image & video resolution upscaling)
 *
 * NOTE: LLM is intentionally EXCLUDED from WaveSpeed in this phase
 * (LLM is provided exclusively by Google Studio).
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

  // Domain belongs to the logical model; fallback to context or binding declaration
  const domain = context.model?.domain || context.domain || binding.domain || "image";

  switch (domain) {
    case "image":
      return resolveImageRoute(binding, semanticInput, context);
    case "video":
      return resolveVideoRoute(binding, semanticInput, context);
    case "upscale":
      return resolveUpscaleRoute(binding, semanticInput, context);
    case "llm":
      throw new UnsupportedCapabilityError(
        `WaveSpeed execution topology does not support domain "llm" for model "${binding.modelId}". ` +
        `LLM services are provided exclusively by Google Studio in this phase.`
      );
    default:
      throw new UnsupportedCapabilityError(
        `WaveSpeed execution topology does not support model domain "${domain}" for model "${binding.modelId}"`
      );
  }
}

export default resolveWaveSpeedRoute;
