/**
 * V2 Image Provider Adapter
 *
 * Routes image generation requests directly to the V1 model runners
 * (e.g., NanobanaNormal, SeedreamPro, etc.) using the existing model router.
 *
 * This bypasses GenerateImageTreatment entirely — V2 Engine is already
 * responsible for DB placeholders, billing, and queue. This adapter's
 * only job is to call the AI provider API and return the URL.
 */

import { MEDIA_CAPABILITIES } from "../../constants/workflowConstants.js";
import { createStaticProviderAdapter } from "../../../providers/providerAdapterContract.js";
import { resolveProvider, buildProviderPayload, extractOutputUrl } from "../../../image/treatments/basetretment/providerStrategy.js";

/**
 * Build a V2 image adapter that routes directly to V1 model runners.
 * @param {{ providerId: string, cost?: number, latencyMs?: number, qualityTier?: string, healthy?: boolean }} opts
 */
export function createV2ImageAdapter({
  providerId,
  runner = null,
  cost = 10,
  latencyMs = 1200,
  qualityTier = "standard",
  healthy = true,
} = {}) {
  return createStaticProviderAdapter({
    providerId,
    capabilities: [MEDIA_CAPABILITIES.IMAGE_GENERATION],
    cost,
    latencyMs,
    qualityTier,
    healthy,
    execute: async (request) => {
      // 1. Delegate to custom runner (e.g. test mocks) if available
      if (runner) {
        const runnerFn = runner.execute ?? runner.run ?? runner.generate ?? null;
        if (typeof runnerFn === "function") {
          const v1Result = await runnerFn.call(runner, request);
          return normalizeImageResponse(v1Result, providerId);
        }
      }

      const modelName = request.model ?? request.model_name ?? null;

      // If a model is specified, route directly to the V1 model runner
      if (modelName) {
        try {
          // 1. Resolve the correct model runner class (e.g., NanobanaNormal)
          const runner = resolveProvider({
            model_name: modelName,
            input_assets: request.references ?? request.input_assets ?? [],
          });

          // 2. Build provider payload using the runner's own adapt() / toPayload()
          const payload = buildProviderPayload(runner, request);

          // 3. Call the AI provider API directly (Zero DB, Zero Billing, Zero Queue)
          const result = await runner.generate(payload);

          // 4. Extract the URL from the provider-specific response shape
          const url = extractOutputUrl(result);

          return {
            providerId,
            capabilityId: MEDIA_CAPABILITIES.IMAGE_GENERATION,
            outputs: [
              {
                id: `${providerId}-img-${Date.now()}`,
                type: "image",
                url: url ?? "",
                width: request.width ?? 1024,
                height: request.height ?? 1024,
                metadata: {
                  prompt: request.prompt,
                  provider: providerId,
                  model: modelName,
                  runner: runner.constructor?.name ?? modelName,
                },
              },
            ],
            status: "success",
          };
        } catch (err) {
          console.error(`[imageAdapter] Real execution failed: ${err.message}`);
          throw err;
        }
      }

      // No model specified — return a structured mock suitable for E2E testing
      const isEditMode = request.image || request.image_url;
      return {
        providerId,
        capabilityId: MEDIA_CAPABILITIES.IMAGE_GENERATION,
        outputs: [
          {
            id: `${providerId}-img-${Date.now()}`,
            type: "image",
            url: `https://placehold.co/${request.width ?? 1024}x${request.height ?? 1024}.png`,
            width: request.width ?? 1024,
            height: request.height ?? 1024,
            metadata: {
              prompt: request.prompt,
              provider: providerId,
              model: null,
              ...(isEditMode
                ? {
                    source_image: request.image || request.image_url,
                    mode: request.mode || "edit",
                    strength: request.strength ?? null,
                  }
                : {}),
            },
          },
        ],
        status: "success",
      };
    },
  });
}

/**
 * Normalize V1 provider response → V2 asset shape.
 * @param {object} v1Result
 * @param {string} providerId
 */
function normalizeImageResponse(v1Result, providerId) {
  const raw = v1Result?.outputs ?? v1Result?.assets ?? v1Result?.images ?? [];
  const outputs = raw.map((item) => ({
    id: item.id ?? `${providerId}-${Date.now()}`,
    type: "image",
    url: item.url ?? item.src ?? "",
    width: item.width ?? null,
    height: item.height ?? null,
    metadata: item.metadata ?? {},
  }));
  return { providerId, capabilityId: MEDIA_CAPABILITIES.IMAGE_GENERATION, outputs, status: "success" };
}
