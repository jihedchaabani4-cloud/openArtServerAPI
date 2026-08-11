/**
 * V2 Video Provider Adapter
 *
 * Routes video generation requests directly to the V1 model runners
 * (e.g., KlingV3, RunwayGen4, etc.) using the existing video model router.
 *
 * This bypasses VideoTreatment entirely — V2 Engine is already responsible
 * for DB placeholders, billing, and queue. This adapter's only job is to
 * call the AI provider API and return the video URL.
 */

import { MEDIA_CAPABILITIES } from "../../constants/workflowConstants.js";
import { createStaticProviderAdapter } from "../../../providers/providerAdapterContract.js";
import { getRunner } from "../../../video/core/modelRouter.js";

/**
 * Build a V2 video adapter that routes directly to V1 video model runners.
 * @param {{ providerId: string, cost?: number, latencyMs?: number, qualityTier?: string, healthy?: boolean }} opts
 */
export function createV2VideoAdapter({
  providerId,
  runner = null,
  cost = 30,
  latencyMs = 8000,
  qualityTier = "standard",
  healthy = true,
} = {}) {
  return createStaticProviderAdapter({
    providerId,
    capabilities: [MEDIA_CAPABILITIES.VIDEO_GENERATION],
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
          return normalizeVideoResponse(v1Result, providerId);
        }
      }

      const modelName = request.model ?? request.model_name ?? null;
      const mode = request.mode ?? "t2v";

      // If a model is specified, route directly to the V1 model runner
      if (modelName) {
        try {
          // 1. Resolve the correct video runner (e.g., KlingV3T2V instance)
          const runnerInstance = getRunner(modelName, mode);
          if (!runnerInstance) {
            throw new Error(`Model "${modelName}" does not support mode "${mode}" or is not available.`);
          }

          // 2. Build provider payload using the runner's own adapt() / toPayload()
          const adapted = typeof runnerInstance.adapt === "function"
            ? runnerInstance.adapt(request, mode)
            : request;
          const payload = typeof runnerInstance.toPayload === "function"
            ? runnerInstance.toPayload(adapted, mode)
            : adapted;

          // 3. Call the AI provider API directly (Zero DB, Zero Billing, Zero Queue)
          const result = await runnerInstance.generate(payload);

          // 4. Extract URL from provider-specific response shape
          const url = result?.video_url ?? result?.url ?? result?.outputUrl ?? null;

          return {
            providerId,
            capabilityId: MEDIA_CAPABILITIES.VIDEO_GENERATION,
            outputs: [
              {
                id: `${providerId}-vid-${Date.now()}`,
                type: "video",
                url: url ?? "",
                duration: request.duration ?? 5,
                metadata: {
                  prompt: request.prompt,
                  provider: providerId,
                  model: modelName,
                  mode,
                  runner: runnerInstance.constructor?.name ?? modelName,
                },
              },
            ],
            status: "success",
          };
        } catch (err) {
          console.error(`[videoAdapter] Real execution failed: ${err.message}`);
          throw err;
        }
      }

      // No model specified — return a structured mock suitable for E2E testing
      return {
        providerId,
        capabilityId: MEDIA_CAPABILITIES.VIDEO_GENERATION,
        outputs: [
          {
            id: `${providerId}-vid-${Date.now()}`,
            type: "video",
            url: "https://www.w3schools.com/html/mov_bbb.mp4",
            duration: request.duration ?? 5,
            metadata: { prompt: request.prompt, provider: providerId, model: null },
          },
        ],
        status: "success",
      };
    },
  });
}

function normalizeVideoResponse(v1Result, providerId) {
  const raw = v1Result?.outputs ?? v1Result?.videos ?? [];
  const outputs = raw.map((item) => ({
    id: item.id ?? `${providerId}-${Date.now()}`,
    type: "video",
    url: item.url ?? item.src ?? "",
    duration: item.duration ?? null,
    metadata: item.metadata ?? {},
  }));
  return { providerId, capabilityId: MEDIA_CAPABILITIES.VIDEO_GENERATION, outputs, status: "success" };
}
