import { run, resolveOperation } from "../../models/index.js";
import { logV2Event } from "../logging/v2Logger.js";
import { NodeSafetyService } from "./safety/NodeSafetyService.js";

/**
 * Upscale Node
 * Takes an existing asset and requests an upscale/enhancement pass.
 */
export async function executeUpscale(inputs, ctx) {
  const { runId, nodeId = "upscale", traceId, userId } = ctx;

  // ── Safety: validate & sanitise all inputs before any provider work ────────
  const safe = NodeSafetyService.assertUpscaleInputs(inputs, nodeId);

  const inputAsset = safe.asset;
  const factor     = safe.factor || null;
  const started    = Date.now();

  logV2Event({
    traceId,
    operation: `node.upscale:${nodeId}`,
    durationMs: 0,
    status: "success",
    message: `Starting upscale for node ${nodeId}`,
  });

  const modelFamily = safe.model;
  if (!modelFamily) {
    throw new Error(`[Node:${nodeId}] Missing required "model" input`);
  }
  const operation = resolveOperation(safe, "image");

  // ── Direct execution via Models Management System ─────────────────────────
  const runResult = await run(
    modelFamily,
    operation,
    {
      ...safe,
      image_url: inputAsset.url,
      ...(factor ? { factor } : {}),
    },
    {
      idempotencyKey: `node:${runId}:${nodeId}`,
      userId,
      domain: "image",
    }
  );

  const enhancedAsset = {
    id: `enhanced-${inputAsset.id || "asset"}-${Date.now()}`,
    type: "image",
    url: runResult.url || inputAsset.url,
    width: inputAsset.width ? inputAsset.width * (factor || 1) : null,
    height: inputAsset.height ? inputAsset.height * (factor || 1) : null,
    duration: inputAsset.duration ?? null,
    metadata: {
      ...(inputAsset.metadata || {}),
      provider: runResult.metadata?.deploymentUsed ?? modelFamily,
      model: modelFamily,
      upscaled: true,
      factor,
      ...(runResult.metadata ?? {}),
    },
  };

  const durationMs = Date.now() - started;
  logV2Event({
    traceId,
    operation: `node.upscale:${nodeId}`,
    durationMs,
    status: "success",
    message: `Upscale completed via ${modelFamily}`,
  });

  return {
    enhancedAsset,
    assets: [enhancedAsset],
    metadata: { model: modelFamily, latencyMs: durationMs, metadata: runResult.metadata },
  };
}
