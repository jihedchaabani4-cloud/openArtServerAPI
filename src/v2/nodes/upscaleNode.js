import { selectProvider } from "../providers/router.js";
import { MEDIA_CAPABILITIES } from "../constants/workflowConstants.js";
import { logV2Event } from "../logging/v2Logger.js";
import { NodeSafetyService } from "./safety/NodeSafetyService.js";

/**
 * Upscale Node (T075)
 * skill_aware: false | provider-backed: true
 *
 * Takes an existing asset and requests an upscale/enhancement pass.
 * Billing and storage are handled by the V2 runner gateways, not in-node.
 */
export async function executeUpscale(inputs, ctx) {
  const { runId, nodeId, traceId, forceProvider = null } = ctx;

  // ── Safety: validate & sanitise all inputs before any provider work ────────
  const safe = NodeSafetyService.assertUpscaleInputs(inputs, nodeId);

  const inputAsset = safe.asset;
  const factor     = safe.factor;
  const started    = Date.now();

  logV2Event({
    traceId,
    operation: `node.upscale:${nodeId}`,
    durationMs: 0,
    status: "success",
    message: `Starting upscale for node ${nodeId}`,
  });

  const { adapter, decision } = await selectProvider(
    {
      capabilityId: MEDIA_CAPABILITIES.IMAGE_EDITING,
      executionId: runId,
    },
    { quality: inputs.quality ?? "standard" },
    forceProvider,
  );

  const providerId = decision.selectedProvider;
  const providerResult = await adapter.execute({
    capabilityId: MEDIA_CAPABILITIES.IMAGE_EDITING,
    asset: inputAsset,
    factor,
  });

  const firstOutput = providerResult?.outputs?.[0] ?? {};
  const enhancedAsset = {
    id: firstOutput.id ?? `enhanced-${inputAsset.id || "asset"}`,
    type: firstOutput.type ?? inputAsset.type ?? "image",
    url: firstOutput.url ?? inputAsset.url ?? "https://placehold.co/2048x2048.png",
    width: firstOutput.width ?? ((inputAsset.width ?? 1024) * factor),
    height: firstOutput.height ?? ((inputAsset.height ?? 1024) * factor),
    duration: firstOutput.duration ?? inputAsset.duration ?? null,
    metadata: {
      ...(inputAsset.metadata || {}),
      ...(firstOutput.metadata || {}),
      provider: providerId,
      upscaled: true,
      factor,
    },
  };

  logV2Event({
    traceId,
    operation: `node.upscale:${nodeId}`,
    durationMs: Date.now() - started,
    status: "success",
    message: `Upscale completed via ${providerId}`,
  });

  return {
    enhancedAsset,
    metadata: { provider: providerId, decision, latencyMs: Date.now() - started },
    providerDecision: decision,
  };
}
