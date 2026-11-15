import { executeGeneration, getModelConfig } from "#models/tools";
import {
  GenerationUpstreamError,
  GenerationCompilationError,
} from "../../../errors.js";

/**
 * Extracts and validates a non-negative finite credit cost from calculateCost result.
 * Fails closed with GenerationCompilationError (PRICING_CONFIG_ERROR, 500) on invalid cost.
 */
export function extractNodeCostAmount(costRes, model, nodeType) {
  const raw =
    typeof costRes === "number"
      ? costRes
      : costRes && typeof costRes === "object"
        ? Number(costRes.amount ?? costRes.totalCredits ?? costRes.credits)
        : NaN;

  if (typeof raw !== "number" || Number.isNaN(raw) || !Number.isFinite(raw) || raw < 0) {
    const err = new GenerationCompilationError(
      `[Billing] Pricing failure for model "${model}" in ${nodeType}: invalid cost (${raw})`
    );
    err.code = "PRICING_CONFIG_ERROR";
    err.category = "SERVER_FAULT";
    err.statusCode = 500;
    throw err;
  }
  return raw;
}

/**
 * Executes a model generation request using context overrides if present,
 * or the canonical `#models/tools` runner.
 */
export async function invokeModelGeneration({
  model,
  prompt = undefined,
  params = {},
  references = undefined,
  ctx = {},
}) {
  if (typeof ctx.executeProvider === "function") {
    return ctx.executeProvider(model, params);
  }
  if (typeof ctx.executeGeneration === "function") {
    return ctx.executeGeneration({
      modelId: model,
      ...(prompt !== undefined ? { prompt } : {}),
      params,
      ...(references !== undefined ? { references } : {}),
      userId: ctx.userId || null,
    });
  }
  getModelConfig(model);
  return executeGeneration({
    modelId: model,
    ...(prompt !== undefined ? { prompt } : {}),
    params,
    ...(references !== undefined ? { references } : {}),
    userId: ctx.userId || "system",
    idempotencyKey: ctx.runId && ctx.nodeId ? `node:${ctx.runId}:${ctx.nodeId}` : undefined,
  });
}

/**
 * Extracts normalized image asset list and primary URL from a provider response.
 */
export function extractImageOutput(res, model, errorMessage = "Provider returned no image URL") {
  const assets = Array.isArray(res?.assets)
    ? res.assets
    : Array.isArray(res?.images)
      ? res.images.map((u) => (typeof u === "string" ? { url: u } : u))
      : Array.isArray(res?.data?.images)
        ? res.data.images.map((u) => (typeof u === "string" ? { url: u } : u))
        : res?.url
          ? [{ url: res.url }]
          : [];

  const url = assets[0]?.url || (typeof assets[0] === "string" ? assets[0] : null);
  if (!url) {
    throw new GenerationUpstreamError(errorMessage, {
      context: { model },
    });
  }
  return { url, assets };
}

/**
 * Extracts primary video URL from a provider response.
 */
export function extractVideoOutput(res, model, errorMessage = "Provider returned no video URL") {
  const url =
    res?.assets?.[0]?.url ||
    res?.videos?.[0]?.url ||
    (typeof res?.videos?.[0] === "string" ? res.videos[0] : null) ||
    (typeof res?.data?.videos?.[0] === "string" ? res.data.videos[0] : res?.data?.videos?.[0]?.url) ||
    (typeof res?.images?.[0] === "string" ? res.images[0] : res?.images?.[0]?.url) ||
    res?.url ||
    res?.videoUrl ||
    null;

  if (!url) {
    throw new GenerationUpstreamError(errorMessage, {
      context: { model },
    });
  }
  return { url };
}
