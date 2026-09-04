import { run, resolveOperation } from "../../models/index.js";
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

  const modelFamily = safe.model;
  if (!modelFamily) {
    throw new Error(`[Node:${nodeId}] Missing required "model" input`);
  }
  const operation = resolveOperation(safe, "image");

  // ── Direct execution via Models Management System ─────────────────────────
  const runResult = await run(modelFamily, operation, safe, {
    idempotencyKey: `node:${runId}:${nodeId}`,
    userId,
    domain: "image",
    skipWalletHold: Boolean(ctx.hasWorkflowHold || ctx.skipWalletHold),
  });

  // ── Normalize outputs → V2 asset shape ──────────────────────────────────
  const assets = [
    {
      id: `img-${Date.now()}`,
      type: "image",
      url: runResult.url ?? "",
      width: safe.width ?? null,
      height: safe.height ?? null,
      metadata: {
        provider: runResult.metadata?.deploymentUsed ?? modelFamily,
        model: modelFamily,
        ...(runResult.metadata ?? {}),
      },
    },
  ];

  const durationMs = Date.now() - started;

  return {
    assets,
    metadata: { model: modelFamily, latencyMs: durationMs, metadata: runResult.metadata },
  };
}
