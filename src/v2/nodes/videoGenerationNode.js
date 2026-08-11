/**
 * Video Generation Node (T074)
 * skill_aware: false | provider-backed: true
 *
 * Accepts a prompt and motion parameters, routes to the selected video
 * provider via the V2 provider router, and returns a video asset.
 *
 * Billing and storage are handled by the V2 runner gateways, not in-node.
 */

import { selectProvider } from "../providers/router.js";
import { MEDIA_CAPABILITIES } from "../constants/workflowConstants.js";
import { logV2Event } from "../logging/v2Logger.js";
import { NodeSafetyService } from "./safety/NodeSafetyService.js";

/**
 * @param {object} inputs - { prompt, duration, aspect_ratio, motion_strength }
 * @param {object} ctx    - { runId, nodeId, userId, traceId, forceProvider, gateways }
 * @returns {Promise<{ asset: object, metadata: object }>}
 */
export async function executeVideoGeneration(inputs, ctx) {
  const { runId, nodeId, traceId, forceProvider = null } = ctx;

  // ── Safety: validate & sanitise all inputs before any provider work ────────
  const safe = NodeSafetyService.assertVideoInputs(inputs, nodeId);

  const started = Date.now();

  logV2Event({
    traceId,
    operation: `node.videoGeneration:${nodeId}`,
    durationMs: 0,
    status: "success",
    message: `Starting video generation for node ${nodeId}`,
  });

  // ── Provider selection ───────────────────────────────────────────────────
  const { adapter, decision } = await selectProvider(
    { capabilityId: MEDIA_CAPABILITIES.VIDEO_GENERATION, executionId: runId },
    { quality: inputs.quality ?? "standard" },
    forceProvider
  );
  const providerId = decision.selectedProvider;

  // ── Execute generation (use sanitised safe inputs) ────────────────────────
  const providerResult = await adapter.execute({
    capabilityId: MEDIA_CAPABILITIES.VIDEO_GENERATION,
    model:           safe.model,
    mode:            safe.mode,
    prompt:          safe.prompt,
    duration:        safe.duration,
    fps:             safe.fps,
    aspect_ratio:    safe.aspect_ratio,
    motion_strength: safe.motion_strength,
    startFrame:      safe.startFrame,
    references:      safe.references,
  });

  // ── Normalize output ─────────────────────────────────────────────────────
  const rawOutputs = providerResult?.outputs ?? [];
  const firstOutput = rawOutputs[0] ?? {};
  const asset = {
    id: firstOutput.id ?? `vid-${Date.now()}`,
    type: "video",
    url: firstOutput.url ?? "",
    duration: firstOutput.duration ?? safe.duration,
    metadata: { ...(firstOutput.metadata ?? {}), provider: providerId },
  };

  const durationMs = Date.now() - started;
  logV2Event({
    traceId,
    operation: `node.videoGeneration:${nodeId}`,
    durationMs,
    status: "success",
    message: `Video generation completed via ${providerId}`,
  });

  return {
    asset,
    metadata: { provider: providerId, decision, latencyMs: durationMs },
    providerDecision: decision,
  };
}
