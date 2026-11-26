import { executeGeneration } from "#models/tools";
import {
  GenerationError,
  GenerationValidationError,
  GenerationUpstreamError,
  GenerationCompilationError,
  GenerationSafetyError,
} from "../../../errors.js";

/**
 * Normalizes a string, `{ url }` object, or mixed array of image references into deduplicated URLs.
 */
export function normalizeImages(rawImages) {
  const items = Array.isArray(rawImages)
    ? rawImages
    : rawImages !== undefined && rawImages !== null
      ? [rawImages]
      : [];
  const seen = new Set();
  const urls = [];
  for (const item of items) {
    const raw = typeof item === "string" ? item : item?.url;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        urls.push(trimmed);
      }
    }
  }
  return urls;
}

/**
 * Normalizes a node's `parameters` object into a plain non-array dictionary.
 */
export function normalizeParameters(rawParameters) {
  return rawParameters && typeof rawParameters === "object" && !Array.isArray(rawParameters)
    ? rawParameters
    : {};
}

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
 * Classifies a provider/LLM/model invocation error into a typed GenerationError across categories.
 * Supports fail-closed safety guard escalation when `requiresSafety` is true.
 */
export function normalizeModelInvocationError(
  err,
  model,
  { requiresSafety = false, allowUserFault = true, messagePrefix = "" } = {}
) {
  if (err?.code === "BILLING_CONTEXT_MISSING") {
    return err;
  }

  const code = String(err?.code || err?.errorCode || "").trim();
  const upperCode = code.toUpperCase();
  const msg = err?.message || "Model generation failed";
  const status = Number(err?.statusCode || err?.status || 0);

  if (
    upperCode === "CONTENT_SAFETY_VIOLATION" ||
    upperCode === "PROVIDER_CONTENT_POLICY_ERROR" ||
    err?.is_safe === false ||
    /safety violation|content policy|nsfw|moderation/i.test(msg)
  ) {
    if (err instanceof GenerationError && upperCode === "CONTENT_SAFETY_VIOLATION") {
      err.retryable = false;
      err.statusCode = 422;
      return err;
    }
    if (!requiresSafety && err instanceof GenerationError) {
      return err;
    }
    return new GenerationSafetyError(msg, {
      field: "prompt",
      context: { model },
    });
  }

  const isCircuitBreakerOpen = upperCode === "CIRCUIT_BREAKER_OPEN";
  const isProviderQuota = upperCode === "PROVIDER_QUOTA_EXCEEDED";
  const isTimeout =
    status === 504 ||
    status === 408 ||
    /TIMEOUT/i.test(upperCode) ||
    /timed out|timeout/i.test(msg);
  const isRateLimit =
    !isProviderQuota &&
    (status === 429 ||
      err?.category === "RATE_LIMIT" ||
      upperCode === "RATE_LIMITED" ||
      upperCode === "RATE_LIMIT_EXCEEDED" ||
      upperCode === "PROVIDER_RATE_LIMITED" ||
      /rate limit|429/i.test(msg) ||
      /RATE_LIMIT|QUOTA/i.test(upperCode));

  if (requiresSafety) {
    const isTransient =
      isCircuitBreakerOpen ||
      isRateLimit ||
      isTimeout ||
      isProviderQuota ||
      err?.retryable === true ||
      err?.category === "UPSTREAM_FAULT" ||
      upperCode === "PROVIDER_TRANSIENT_ERROR" ||
      upperCode === "PROVIDER_UNAVAILABLE" ||
      status === 502 ||
      status === 503;

    if (isTransient) {
      const category = isRateLimit ? "RATE_LIMIT" : "UPSTREAM_FAULT";
      const statusCode = isRateLimit
        ? 429
        : status === 503 || isCircuitBreakerOpen || isProviderQuota
          ? 503
          : 502;
      const unavailableErr = new GenerationUpstreamError(
        `Safety verification temporarily unavailable (fail-closed): ${msg}`,
        {
          code: "SAFETY_CHECK_UNAVAILABLE",
          category,
          statusCode,
          retryable: !isCircuitBreakerOpen && !isProviderQuota,
          context: {
            cause: msg,
            ...(upperCode ? { upstreamCode: upperCode } : {}),
          },
        }
      );
      unavailableErr.code = "SAFETY_CHECK_UNAVAILABLE";
      return unavailableErr;
    }

    const failErr = new GenerationUpstreamError(
      `Safety verification failed (fail-closed): ${msg}`,
      {
        code: "SAFETY_CHECK_FAILED",
        category: "UPSTREAM_FAULT",
        statusCode: 502,
        retryable: false,
        context: { cause: msg },
      }
    );
    failErr.code = "SAFETY_CHECK_FAILED";
    failErr.is_safe = false;
    return failErr;
  }

  if (err instanceof GenerationError) {
    return err;
  }

  if (
    allowUserFault &&
    (err?.category === "USER_FAULT" ||
      status === 400 ||
      status === 403 ||
      status === 404 ||
      /unknown model|not found|invalid/i.test(msg))
  ) {
    const valErr = new GenerationValidationError(msg, { context: { model } });
    if (code) valErr.code = code;
    if (status === 403 || status === 404) valErr.statusCode = status;
    if (typeof err?.safeMessage === "string" && err.safeMessage.trim()) {
      valErr.safeMessage = err.safeMessage;
    }
    return valErr;
  }

  if (isProviderQuota || isCircuitBreakerOpen) {
    const upstreamErr = new GenerationUpstreamError(`${messagePrefix}${msg}`, {
      code: upperCode,
      category: "UPSTREAM_FAULT",
      statusCode: 503,
      retryable: false,
      context: { model, ...(messagePrefix ? { cause: msg } : {}) },
    });
    if (err?.safeMessage) {
      upstreamErr.safeMessage = err.safeMessage;
    }
    return upstreamErr;
  }

  if (isRateLimit || /quota/i.test(msg)) {
    return new GenerationUpstreamError(`${messagePrefix}${msg}`, {
      code: code || "RATE_LIMIT_EXCEEDED",
      category: "RATE_LIMIT",
      statusCode: 429,
      retryable: err?.retryable !== undefined ? Boolean(err.retryable) : true,
      context: { model, ...(messagePrefix ? { cause: msg } : {}) },
    });
  }

  if (err?.retryable === false || err?.category === "SERVER_FAULT" || status === 500) {
    return new GenerationError({
      code: code || "SERVER_ERROR",
      message: `${messagePrefix}${msg}`,
      status: 500,
      statusCode: 500,
      category: "SERVER_FAULT",
      retryable: false,
      isInternal: true,
      context: { model },
    });
  }

  return new GenerationUpstreamError(`${messagePrefix}${msg}`, {
    code: code || "GENERATION_UPSTREAM_ERROR",
    category: "UPSTREAM_FAULT",
    statusCode: status === 503 ? 503 : 502,
    retryable: err?.retryable !== undefined ? Boolean(err.retryable) : true,
    context: { model, ...(messagePrefix ? { cause: msg } : {}) },
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
    return await executeGeneration({
      modelId: model,
      ...(prompt !== undefined ? { prompt } : {}),
      params,
      ...(references !== undefined ? { references } : {}),
      userId: ctx.userId || "system",
      maxRetries: 0,
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

function normalizeVideoAssetList(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  const normalized = [];
  for (const item of list) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) {
        normalized.push({ url: trimmed });
      }
    } else if (item && typeof item === "object" && typeof item.url === "string") {
      const trimmed = item.url.trim();
      if (trimmed) {
        normalized.push(trimmed === item.url ? item : { ...item, url: trimmed });
      }
    }
  }
  return normalized;
}

/**
 * Extracts normalized video asset list and primary URL from a provider response.
 */
export function extractVideoOutput(res, model, errorMessage = "Provider returned no video URL") {
  const candidates = [
    normalizeVideoAssetList(res?.assets),
    normalizeVideoAssetList(res?.videos),
    normalizeVideoAssetList(res?.data?.videos),
    normalizeVideoAssetList(res?.images),
  ];

  let assets = candidates.find((list) => list.length > 0) || [];
  if (assets.length === 0) {
    const directUrl =
      typeof res?.url === "string" && res.url.trim()
        ? res.url.trim()
        : typeof res?.videoUrl === "string" && res.videoUrl.trim()
          ? res.videoUrl.trim()
          : null;
    if (directUrl) {
      assets = [{ url: directUrl }];
    }
  }

  const url = assets[0]?.url || null;
  if (!url) {
    throw new GenerationUpstreamError(errorMessage, {
      context: { model },
    });
  }
  return { url, assets };
}
