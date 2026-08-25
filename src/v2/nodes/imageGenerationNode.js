import { run, resolveOperation } from "../../models/index.js";
import { logV2Event } from "../logging/v2Logger.js";
import { NodeSafetyService } from "./safety/NodeSafetyService.js";

/**
 * @param {object} inputs - { prompt, width, height, count, seed, style, model, quality }
 * @param {object} ctx    - { runId, nodeId, userId, traceId, forceProvider, gateways }
 * @returns {Promise<{ assets: object[], metadata: object }>}
 */
export async function executeImageGeneration(inputs, ctx) {
  const { runId, nodeId, traceId, userId } = ctx;

  // ── Safety: validate & sanitise all inputs before any provider work ────────
  const safe = NodeSafetyService.assertImageInputs(inputs, nodeId);
  const started = Date.now();

  logV2Event({
    traceId,
    operation: `node.imageGeneration:${nodeId}`,
    durationMs: 0,
    status: "success",
    message: `Starting image generation for node ${nodeId}`,
  });

  const modelFamily = safe.model || "nanobana";
  const operation = resolveOperation(safe, "image");

  // ── Direct execution via Models Management System ─────────────────────────
  const runResult = await run(modelFamily, operation, safe, {
    idempotencyKey: `node:${runId}:${nodeId}`,
    userId,
    domain: "image",
  });

  // ── Normalize outputs → V2 asset shape ──────────────────────────────────
  const assets = [
    {
      id: `img-${Date.now()}`,
      type: "image",
      url: runResult.url ?? "",
      width: safe.width ?? 1024,
      height: safe.height ?? 1024,
      metadata: {
        provider: runResult.metadata?.deploymentUsed ?? modelFamily,
        model: modelFamily,
        ...(runResult.metadata ?? {}),
      },
    },
  ];

  const durationMs = Date.now() - started;
  logV2Event({
    traceId,
    operation: `node.imageGeneration:${nodeId}`,
    durationMs,
    status: "success",
    message: `Image generation completed — 1 asset via ${modelFamily}`,
  });

  return {
    assets,
    metadata: { model: modelFamily, latencyMs: durationMs, metadata: runResult.metadata },
  };
}
