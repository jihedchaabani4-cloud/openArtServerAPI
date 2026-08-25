import { run, resolveOperation } from "../../models/index.js";
import { logV2Event } from "../logging/v2Logger.js";
import { NodeSafetyService } from "./safety/NodeSafetyService.js";

/**
 * @param {object} inputs - { prompt, duration, aspect_ratio, motion_strength, model }
 * @param {object} ctx    - { runId, nodeId, userId, traceId, forceProvider, gateways }
 * @returns {Promise<{ asset: object, metadata: object }>}
 */
export async function executeVideoGeneration(inputs, ctx) {
  const { runId, nodeId, traceId, userId } = ctx;

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

  const modelFamily = safe.model || "kling-v3";
  const operation = resolveOperation(safe, "video");

  // ── Direct execution via Models Management System ─────────────────────────
  const runResult = await run(modelFamily, operation, safe, {
    idempotencyKey: `node:${runId}:${nodeId}`,
    userId,
    domain: "video",
  });

  // ── Normalize output ─────────────────────────────────────────────────────
  const asset = {
    id: `vid-${Date.now()}`,
    type: "video",
    url: runResult.url ?? "",
    duration: safe.duration ?? 5,
    metadata: {
      provider: runResult.metadata?.deploymentUsed ?? modelFamily,
      model: modelFamily,
      ...(runResult.metadata ?? {}),
    },
  };

  const durationMs = Date.now() - started;
  logV2Event({
    traceId,
    operation: `node.videoGeneration:${nodeId}`,
    durationMs,
    status: "success",
    message: `Video generation completed via ${modelFamily}`,
  });

  return {
    asset,
    assets: [asset],
    metadata: { model: modelFamily, latencyMs: durationMs, metadata: runResult.metadata },
  };
}
