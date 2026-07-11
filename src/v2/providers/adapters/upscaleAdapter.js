/**
 * V2 Upscale Provider Adapter (T072)
 *
 * Thin wrapper for upscale capability. V1 does not have a dedicated upscale
 * capability constant in MEDIA_CAPABILITIES, so we reuse IMAGE_EDITING which
 * semantically covers post-processing operations. The adapter normalizes the
 * V2 upscale request (asset + factor) and returns an enhanced asset.
 */

import { MEDIA_CAPABILITIES } from "../../../workflows/workflowConstants.js";
import { createStaticProviderAdapter } from "../../../providers/providerAdapterContract.js";

/**
 * @param {{ providerId: string, runner?: object, cost?: number, latencyMs?: number }} opts
 */
export function createV2UpscaleAdapter({
  providerId,
  runner = null,
  cost = 5,
  latencyMs = 2000,
  qualityTier = "standard",
  healthy = true,
} = {}) {
  return createStaticProviderAdapter({
    providerId,
    // Reuse IMAGE_EDITING as the closest capability for upscale post-processing
    capabilities: [MEDIA_CAPABILITIES.IMAGE_EDITING],
    cost,
    latencyMs,
    qualityTier,
    healthy,
    execute: async (request) => {
      if (runner) {
        const runnerFn =
          runner.execute ?? runner.run ?? runner.upscale ?? null;
        if (typeof runnerFn === "function") {
          const v1Result = await runnerFn.call(runner, request);
          return normalizeUpscaleResponse(v1Result, providerId);
        }
      }

      // Mock: double the resolution of the input asset
      const inputAsset = request.asset ?? {};
      const factor = request.factor ?? 2;
      return {
        providerId,
        capabilityId: MEDIA_CAPABILITIES.IMAGE_EDITING,
        outputs: [
          {
            id: `${providerId}-upscaled-${Date.now()}`,
            type: inputAsset.type ?? "image",
            url: inputAsset.url ?? "https://placehold.co/2048x2048.png",
            width: (inputAsset.width ?? 1024) * factor,
            height: (inputAsset.height ?? 1024) * factor,
            metadata: {
              ...(inputAsset.metadata ?? {}),
              upscaled: true,
              factor,
              provider: providerId,
            },
          },
        ],
        status: "success",
      };
    },
  });
}

function normalizeUpscaleResponse(v1Result, providerId) {
  const raw = v1Result?.outputs ?? v1Result?.assets ?? [];
  const outputs = raw.map((item) => ({
    id: item.id ?? `${providerId}-upscaled-${Date.now()}`,
    type: item.type ?? "image",
    url: item.url ?? "",
    width: item.width ?? null,
    height: item.height ?? null,
    metadata: { ...(item.metadata ?? {}), upscaled: true },
  }));
  return { providerId, capabilityId: MEDIA_CAPABILITIES.IMAGE_EDITING, outputs, status: "success" };
}
