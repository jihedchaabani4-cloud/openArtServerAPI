/**
 * Image Generation Node (T073)
 * skill_aware: false | provider-backed: true
 *
 * Accepts a prompt and generation parameters, routes to the selected image
 * provider via the V2 provider router, and returns image assets.
 *
 * Billing and storage are handled by the V2 runner gateways, not in-node.
 */

import { selectProvider } from "../providers/router.js";
import { MEDIA_CAPABILITIES } from "../../workflows/workflowConstants.js";
import { logV2Event } from "../logging/v2Logger.js";

/**
 * @param {object} inputs - { prompt, width, height, count, seed, style }
 * @param {object} ctx    - { runId, nodeId, userId, traceId, forceProvider, gateways }
 * @returns {Promise<{ assets: object[], metadata: object }>}
 */
export async function executeImageGeneration(inputs, ctx) {
  const { forceProvider = null } = ctx;

  // Test hook for retry/fallback integration tests (Phase 6)
  if (typeof globalThis.__RETRY_FALLBACK_TEST_HOOK__ === "function") {
    return globalThis.__RETRY_FALLBACK_TEST_HOOK__(
      { ...inputs, forceProvider },
      ctx,
    );
  }

  const { runId, nodeId, traceId } = ctx;
  const started = Date.now();

  logV2Event({
    traceId,
    operation: `node.imageGeneration:${nodeId}`,
    durationMs: 0,
    status: "success",
    message: `Starting image generation for node ${nodeId}`,
  });

  // ── Provider selection ───────────────────────────────────────────────────
  const { adapter, decision } = await selectProvider(
    {
      capabilityId: MEDIA_CAPABILITIES.IMAGE_GENERATION,
      executionId: runId,
    },
    { quality: inputs.quality ?? "standard" },
    forceProvider
  );

  const providerId = decision.selectedProvider;

  // ── Execute generation ───────────────────────────────────────────────────
  const providerResult = await adapter.execute({
    capabilityId: MEDIA_CAPABILITIES.IMAGE_GENERATION,
    prompt: inputs.prompt,
    width: inputs.width ?? 1024,
    height: inputs.height ?? 1024,
    count: inputs.count ?? 1,
    seed: inputs.seed ?? null,
    style: inputs.style ?? null,
    references: inputs.references ?? [],
    model: inputs.model ?? null,          // ← pass model to adapter
  });

  // ── Normalize outputs → V2 asset shape ──────────────────────────────────
  const rawOutputs = providerResult?.outputs ?? [];
  const assets = rawOutputs.map((item) => ({
    id: item.id ?? `img-${Date.now()}`,
    type: "image",
    url: item.url ?? "",
    width: item.width ?? inputs.width ?? 1024,
    height: item.height ?? inputs.height ?? 1024,
    metadata: { ...(item.metadata ?? {}), provider: providerId, model: item.metadata?.model ?? inputs.model ?? null },
  }));

  const durationMs = Date.now() - started;
  logV2Event({
    traceId,
    operation: `node.imageGeneration:${nodeId}`,
    durationMs,
    status: "success",
    message: `Image generation completed — ${assets.length} asset(s) via ${providerId}`,
  });

  return {
    assets,
    metadata: { provider: providerId, model: inputs.model ?? null, decision, latencyMs: durationMs },
    providerDecision: decision,
  };
}
