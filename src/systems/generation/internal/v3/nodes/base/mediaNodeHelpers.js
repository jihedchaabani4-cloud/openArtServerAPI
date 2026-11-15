import { executeGeneration, getModelConfig } from "#models/tools";
import {
  GenerationError,
  GenerationValidationError,
  GenerationUpstreamError,
  GenerationCompilationError,
  GenerationSafetyError,
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
    err.retryable = false;
    throw err;
  }
  return raw;
}

/**
 * Classifies a provider/model invocation error into a typed GenerationError across the 4 categories.
 */
function normalizeModelInvocationError(err, model) {
  if (err instanceof GenerationError) {
    return err;
  }
  const code = String(err?.code || err?.errorCode || "").trim();
  const msg = err?.message || "Model generation failed";
  const status = Number(err?.statusCode || err?.status || 0);

  if (
    code === "CONTENT_SAFETY_VIOLATION" ||
    code === "PROVIDER_CONTENT_POLICY_ERROR" ||
    err?.is_safe === false ||
    /safety violation|content policy|nsfw|moderation/i.test(msg)
  ) {
    return new GenerationSafetyError(msg, {
      field: "prompt",
      context: { model },
    });
  }

  if (
    err?.category === "USER_FAULT" ||
    status === 400 ||
    status === 403 ||
    status === 404 ||
    /unknown model|not found|invalid/i.test(msg)
  ) {
    const valErr = new GenerationValidationError(msg, { context: { model } });
    if (code) valErr.code = code;
    if (status === 403 || status === 404) valErr.statusCode = status;
    return valErr;
  }

  if (
    err?.category === "RATE_LIMIT" ||
    status === 429 ||
    /rate limit|quota|429/i.test(msg) ||
    /RATE_LIMIT|QUOTA/i.test(code)
  ) {
    return new GenerationUpstreamError(msg, {
      code: code || "RATE_LIMIT_EXCEEDED",
      category: "RATE_LIMIT",
      statusCode: 429,
      retryable: err?.retryable !== undefined ? Boolean(err.retryable) : true,
      context: { model },
    });
  }

  if (err?.retryable === false || err?.category === "SERVER_FAULT" || status === 500) {
    return new GenerationError({
      code: code || "SERVER_ERROR",
      message: msg,
      status: 500,
      statusCode: 500,
      category: "SERVER_FAULT",
      retryable: false,
      isInternal: true,
      context: { model },
    });
  }

  return new GenerationUpstreamError(msg, {
    code: code || "GENERATION_UPSTREAM_ERROR",
    category: "UPSTREAM_FAULT",
    statusCode: status === 503 ? 503 : 502,
    retryable: err?.retryable !== undefined ? Boolean(err.retryable) : true,
    context: { model },
  });
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
  try {
    if (typeof ctx.executeProvider === "function") {
      return await ctx.executeProvider(model, params);
    }
    if (typeof ctx.executeGeneration === "function") {
      return await ctx.executeGeneration({
        modelId: model,
        ...(prompt !== undefined ? { prompt } : {}),
        params,
        ...(references !== undefined ? { references } : {}),
        userId: ctx.userId || null,
      });
    }
    getModelConfig(model);
    return await executeGeneration({
      modelId: model,
      ...(prompt !== undefined ? { prompt } : {}),
      params,
      ...(references !== undefined ? { references } : {}),
      userId: ctx.userId || "system",
      idempotencyKey: ctx.runId && ctx.nodeId ? `node:${ctx.runId}:${ctx.nodeId}` : undefined,
    });
  } catch (err) {
    throw normalizeModelInvocationError(err, model);
  }
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
