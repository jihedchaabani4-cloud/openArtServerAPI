/**
 * Media Transform Node
 * skill_aware: false | provider-backed: true
 *
 * Capabilities:
 *   - image_edit    : Edit an existing image (inpaint, style transfer, etc.)
 *   - image_to_image: Transform image to new image
 *   - image_variation: Generate variations of an image
 *   - video_to_video: Transform a video
 *
 * Requires source_asset (the media to transform)
 *
 * NOTE: Billing is managed by nodeExecutor.js at the orchestration level.
 * Do NOT call reserveNodeBilling / settleNodeBilling / rollbackNodeBilling here.
 */

import { run, resolveOperation } from "../../models/index.js";
import { logV2Event } from "../logging/v2Logger.js";
import { NodeSafetyService } from "./safety/NodeSafetyService.js";

export async function executeMediaTransform(inputs, ctx) {
  const { runId, nodeId = "media-transform", traceId, userId } = ctx;

  // ── Safety: validate & sanitise all inputs before any provider work ────────
  const safe = NodeSafetyService.assertTransformInputs(inputs, nodeId);
  const sourceAsset = safe.source_asset;
  const started = Date.now();

  logV2Event({
    traceId,
    operation: `node.mediaTransform:${nodeId}`,
    durationMs: 0,
    status: "success",
    message: `Starting media transform for node ${nodeId}`,
  });

  const modelFamily = safe.model;
  if (!modelFamily) {
    throw new Error(`[Node:${nodeId}] Missing required "model" input`);
  }
  const operation = resolveOperation(
    { ...safe, image_url: sourceAsset?.url || safe.image_url },
    safe.mode?.includes("video") ? "video" : "image"
  );

  // ── Direct execution via Models Management System ─────────────────────────
  const runResult = await run(
    modelFamily,
    operation,
    {
      ...safe,
      image_url: sourceAsset?.url || safe.image_url,
      prompt: safe.prompt || "",
    },
    {
      idempotencyKey: `node:${runId}:${nodeId}`,
      userId,
      domain: safe.mode?.includes("video") ? "video" : "image",
    }
  );

  const asset = {
    id: `transformed-${Date.now()}`,
    url: runResult.url ?? "",
    type: runResult.type || (safe.mode?.includes("video") ? "video" : "image"),
    width: safe.width || 1024,
    height: safe.height || 1024,
    metadata: {
      provider: runResult.metadata?.deploymentUsed ?? modelFamily,
      mode: safe.mode,
      model: modelFamily,
      source_asset_id: sourceAsset?.id || null,
      prompt: safe.prompt,
      ...(runResult.metadata ?? {}),
    },
  };

  const durationMs = Date.now() - started;
  logV2Event({
    traceId,
    operation: `node.mediaTransform:${nodeId}`,
    durationMs,
    status: "success",
    message: `Media transform completed via ${modelFamily} (${safe.mode})`,
  });

  return {
    asset,
    assets: [asset],
    metadata: {
      model: modelFamily,
      mode: safe.mode,
      latencyMs: durationMs,
      metadata: runResult.metadata,
    },
  };
}
