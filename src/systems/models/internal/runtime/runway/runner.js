import RunwayML, {
  TaskFailedError,
  TaskTimedOutError,
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  RateLimitError,
} from "@runwayml/sdk";
import { ProviderRequestError, ProviderTransientError } from "../../errors.js";
import { createLogger, envConfig } from "#shared";
import { resolveRunwayRatio } from "./ratioResolver.js";

const logger = createLogger("models");

const SUPPORTED_SDK_METHODS = new Set([
  "textToImage",
  "textToVideo",
  "imageToVideo",
  "videoToVideo",
  "characterPerformance",
  "imageUpscale",
  "videoUpscale",
]);

// Models whose API endpoints directly accept `resolution` instead of encoding it in `ratio`
const DIRECT_RESOLUTION_MODELS = new Set([
  "seedream5_pro_layers",
  "seedream5.5_layers",
  "magnific_video_upscaler_creative",
]);

function normalizeReferenceImages(rawRefs, fallbackSingleImage = null) {
  const list = [];
  const seen = new Set();

  const pushRef = (entry) => {
    if (!entry) return;
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      list.push({ uri: trimmed });
    } else if (typeof entry === "object" && typeof entry.uri === "string") {
      const trimmed = entry.uri.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      const refObj = { uri: trimmed };
      if (entry.tag) refObj.tag = entry.tag;
      if (entry.subject) refObj.subject = entry.subject;
      list.push(refObj);
    }
  };

  if (fallbackSingleImage) pushRef(fallbackSingleImage);
  if (Array.isArray(rawRefs)) {
    for (const item of rawRefs) pushRef(item);
  } else if (rawRefs) {
    pushRef(rawRefs);
  }

  return list;
}

function normalizeReferenceVideos(rawVideos) {
  if (!Array.isArray(rawVideos)) return [];
  const list = [];
  for (const item of rawVideos) {
    if (typeof item === "string" && item.trim()) {
      list.push({ type: "video", uri: item.trim() });
    } else if (item && typeof item === "object" && typeof item.uri === "string" && item.uri.trim()) {
      list.push({ type: item.type || "video", uri: item.uri.trim() });
    }
  }
  return list;
}

function buildRunwayRequestBody(sdkMethod, providerModelId, payload = {}) {
  const body = { model: providerModelId };

  // Extract internal routing / ratio hints before copying payload fields
  const aspectRatio = payload._aspect_ratio ?? payload.aspect_ratio;
  const resolution = payload._resolution ?? payload.resolution;
  const inputImage = payload._input_image ?? payload.input_image;
  const lastFrame = payload._last_frame ?? payload.last_frame;
  const extraImages = payload._images ?? payload.images;
  const refImages = payload._reference_images ?? payload.reference_images;
  const refVideos = payload._reference_videos ?? payload.reference_videos;

  // Copy already-mapped Runway API fields (skip internal / canonical helpers)
  const SKIP_KEYS = new Set([
    "model",
    "_aspect_ratio",
    "aspect_ratio",
    "_resolution",
    "resolution",
    "_input_image",
    "input_image",
    "_last_frame",
    "last_frame",
    "_images",
    "images",
    "_reference_images",
    "reference_images",
    "_reference_videos",
    "reference_videos",
    "referenceImages",
    "references",
    "referenceVideos",
    "promptImage",
    "characterImage",
    "characterVideo",
    "referenceVideo",
  ]);

  for (const [key, val] of Object.entries(payload)) {
    if (SKIP_KEYS.has(key)) continue;
    if (val === undefined || val === null || val === "") continue;
    body[key] = val;
  }

  // Coerce numeric fields expected by Runway SDK
  if (body.duration !== undefined && body.duration !== "auto") {
    const num = Number(body.duration);
    if (Number.isFinite(num) && num > 0) body.duration = num;
  }
  if (body.seed !== undefined) {
    const num = Number(body.seed);
    if (Number.isFinite(num)) body.seed = Math.trunc(num);
  }
  if (body.outputCount !== undefined) {
    const num = Number(body.outputCount);
    if (Number.isFinite(num) && num > 0) body.outputCount = Math.trunc(num);
  }
  if (body.scaleFactor !== undefined) {
    const num = Number(body.scaleFactor);
    if (Number.isFinite(num) && num > 0) body.scaleFactor = Math.trunc(num);
  }
  if (body.cfgScale !== undefined) {
    const num = Number(body.cfgScale);
    if (Number.isFinite(num)) body.cfgScale = num;
  }
  if (body.expressionIntensity !== undefined) {
    const num = Number(body.expressionIntensity);
    if (Number.isFinite(num)) body.expressionIntensity = Math.trunc(num);
  }
  for (const slider of ["creativity", "sharpen", "smartGrain", "ultraDetail"]) {
    if (body[slider] !== undefined) {
      const num = Number(body[slider]);
      if (Number.isFinite(num)) body[slider] = num;
    }
  }
  if (body.targetFramerate !== undefined) {
    body.targetFramerate = String(body.targetFramerate);
  }

  // ── Method-specific payload construction ──────────────────────────────────

  if (sdkMethod === "textToImage") {
    const combinedRefs = normalizeReferenceImages(
      payload.referenceImages || refImages || extraImages,
      inputImage
    );
    if (combinedRefs.length > 0) {
      body.referenceImages = combinedRefs;
    }

    if (DIRECT_RESOLUTION_MODELS.has(providerModelId)) {
      if (resolution) body.resolution = resolution;
    } else if (!body.ratio) {
      const resolvedRatio = resolveRunwayRatio(providerModelId, sdkMethod, aspectRatio, resolution);
      if (resolvedRatio) body.ratio = resolvedRatio;
    }
  } else if (sdkMethod === "textToVideo") {
    if (!body.ratio) {
      const resolvedRatio = resolveRunwayRatio(providerModelId, sdkMethod, aspectRatio, resolution);
      if (resolvedRatio) body.ratio = resolvedRatio;
    }
    const combinedRefs = normalizeReferenceImages(payload.references || refImages || extraImages);
    if (combinedRefs.length > 0) body.references = combinedRefs;
    const normalizedVids = normalizeReferenceVideos(payload.referenceVideos || refVideos);
    if (normalizedVids.length > 0) body.referenceVideos = normalizedVids;
  } else if (sdkMethod === "imageToVideo") {
    const primaryImage = payload.promptImage || inputImage;
    if (Array.isArray(primaryImage)) {
      body.promptImage = primaryImage;
    } else if (primaryImage && lastFrame) {
      body.promptImage = [
        { uri: primaryImage, position: "first" },
        { uri: lastFrame, position: "last" },
      ];
    } else if (primaryImage) {
      body.promptImage = primaryImage;
    }

    if (!body.ratio) {
      const resolvedRatio = resolveRunwayRatio(providerModelId, sdkMethod, aspectRatio, resolution);
      if (resolvedRatio) body.ratio = resolvedRatio;
    }
    const combinedRefs = normalizeReferenceImages(payload.references || refImages || extraImages);
    if (combinedRefs.length > 0) body.references = combinedRefs;
    const normalizedVids = normalizeReferenceVideos(payload.referenceVideos || refVideos);
    if (normalizedVids.length > 0) body.referenceVideos = normalizedVids;
  } else if (sdkMethod === "videoToVideo") {
    if (providerModelId === "aleph2") {
      if (aspectRatio && !body.targetAspectRatio) {
        body.targetAspectRatio = aspectRatio;
      }
    } else {
      if (providerModelId === "gemini_omni_flash_1.2" && resolution && (body.mode === "edit" || body.mode === "extend")) {
        body.resolution = resolution;
      } else if (!body.ratio) {
        const resolvedRatio = resolveRunwayRatio(providerModelId, sdkMethod, aspectRatio, resolution);
        if (resolvedRatio) body.ratio = resolvedRatio;
      }
    }
    const combinedRefs = normalizeReferenceImages(payload.references || refImages || extraImages);
    if (combinedRefs.length > 0) body.references = combinedRefs;
    const normalizedVids = normalizeReferenceVideos(payload.referenceVideos || refVideos);
    if (normalizedVids.length > 0) body.referenceVideos = normalizedVids;
  } else if (sdkMethod === "characterPerformance") {
    if (payload.characterVideo) {
      body.character = { type: "video", uri: payload.characterVideo };
    } else if (payload.characterImage || inputImage) {
      body.character = { type: "image", uri: payload.characterImage || inputImage };
    }
    if (payload.referenceVideo) {
      body.reference = { type: "video", uri: payload.referenceVideo };
    }
    if (!body.ratio) {
      const resolvedRatio = resolveRunwayRatio(providerModelId, sdkMethod, aspectRatio, resolution);
      if (resolvedRatio) body.ratio = resolvedRatio;
    }
  } else if (sdkMethod === "videoUpscale") {
    if (DIRECT_RESOLUTION_MODELS.has(providerModelId) && resolution) {
      body.resolution = resolution;
    }
  }

  return body;
}

function normalizeRunwaySdkError(err, providerModelId) {
  const msg = err?.message || "RunwayML SDK execution error";

  if (err instanceof TaskTimedOutError || err instanceof APIConnectionTimeoutError || err?.name === "TaskTimedOutError") {
    const timeoutErr = new ProviderTransientError(`[Runway] Task timed out for "${providerModelId}": ${msg}`);
    timeoutErr.statusCode = 504;
    timeoutErr.code = "PROVIDER_TIMEOUT";
    timeoutErr.raw = err.taskDetails || err;
    return timeoutErr;
  }

  if (err instanceof TaskFailedError || err?.name === "TaskFailedError") {
    const details = err.taskDetails || {};
    const failureText = details.failure || msg;
    const isQuota = /insufficient credits|credit limit|quota|balance/i.test(failureText);
    const failedErr = new ProviderRequestError(`[Runway] Task failed: ${failureText}`);
    failedErr.terminal = true;
    failedErr.retryable = false;
    failedErr.raw = details;
    if (isQuota) {
      failedErr.statusCode = 402;
      failedErr.code = "PROVIDER_QUOTA_EXCEEDED";
    } else {
      failedErr.statusCode = 422;
      failedErr.code = "PROVIDER_JOB_FAILED";
    }
    return failedErr;
  }

  if (err instanceof RateLimitError || err?.status === 429) {
    const rateErr = new ProviderTransientError(`[Runway] Rate limited: ${msg}`);
    rateErr.statusCode = 429;
    rateErr.code = "RATE_LIMITED";
    rateErr.raw = err.error || err;
    if (err.headers) rateErr.headers = err.headers;
    return rateErr;
  }

  if (err instanceof APIConnectionError || (typeof err?.status === "number" && err.status >= 500)) {
    const serverErr = new ProviderTransientError(`[Runway] Upstream unavailable: ${msg}`);
    serverErr.statusCode = err?.status >= 500 ? err.status : 502;
    serverErr.code = "PROVIDER_UNAVAILABLE";
    serverErr.raw = err.error || err;
    return serverErr;
  }

  const status = err?.status || err?.statusCode || 400;
  const isQuota =
    status === 402 ||
    /insufficient credits|not\s+(?:have\s+)?enough\s+credits|quota.*exceeded|credit balance/i.test(msg);

  if (isQuota) {
    const quotaErr = new ProviderRequestError(`[Runway] Account credits exhausted: ${msg}`);
    quotaErr.statusCode = 402;
    quotaErr.code = "PROVIDER_QUOTA_EXCEEDED";
    quotaErr.raw = err.error || err;
    return quotaErr;
  }

  const reqErr = new ProviderRequestError(`[Runway] ${msg}`);
  reqErr.statusCode = err instanceof APIError ? status : (err?.statusCode || 400);
  reqErr.code = status === 401 || status === 403 ? "MISSING_CREDENTIAL" : "INVALID_INPUT_REJECTED_BY_PROVIDER";
  reqErr.raw = err.error || err;
  return reqErr;
}

/**
 * RunwayML Official SDK Runner (@runwayml/sdk)
 *
 * Export shape:
 *   export async function run({ provider, binding, payload, credential, timeoutMs, options }) → rawResponse
 */
export async function run({ provider, binding, payload = {}, credential, timeoutMs, options = {} }) {
  const providerModelId = binding.providerModelId;
  const apiKey = credential || envConfig.runwayApiKey;

  if (!apiKey && !options.sdkClient) {
    const err = new ProviderRequestError(
      "[Runway] No API key resolved — set RUNWAYML_API_SECRET (or RUNWAY_API_KEY) in environment"
    );
    err.statusCode = 401;
    err.code = "MISSING_CREDENTIAL";
    throw err;
  }

  const sdkMethod = binding.sdkMethod;
  if (!sdkMethod || !SUPPORTED_SDK_METHODS.has(sdkMethod)) {
    throw new ProviderRequestError(
      `[Runway] Binding for "${providerModelId}" declared unsupported sdkMethod "${sdkMethod}"`
    );
  }

  const client =
    options.sdkClient ||
    new RunwayML({
      apiKey,
      baseURL: provider?.baseUrl || "https://api.dev.runwayml.com",
      maxRetries: options.maxRetries ?? 2,
    });

  const resource = client[sdkMethod];
  if (!resource || typeof resource.create !== "function") {
    throw new ProviderRequestError(`[Runway] SDK client missing resource "${sdkMethod}.create()"`);
  }

  const requestBody = buildRunwayRequestBody(sdkMethod, providerModelId, payload);
  const pollTimeoutMs =
    (binding.pollingConfig?.timeout ? binding.pollingConfig.timeout * 1000 : null) ||
    timeoutMs ||
    provider?.defaultTimeoutMs ||
    600_000;

  logger.info(
    { modelId: binding.modelId, providerModelId, sdkMethod },
    "[Runway] Submitting task via @runwayml/sdk"
  );

  try {
    const pendingTask = resource.create(requestBody);

    // Always await the initial POST first so immediate API errors (e.g. 400/401/429)
    // reject cleanly inside this try/catch instead of triggering an unhandled rejection
    // while @runwayml/sdk's waitForTaskOutput() sleeps before awaiting responsePromise.
    const createdTask = await pendingTask;

    // @runwayml/sdk attaches .waitForTaskOutput() to all task-creating APIPromises
    const completedTask =
      typeof pendingTask?.waitForTaskOutput === "function"
        ? await pendingTask.waitForTaskOutput({
            timeout: pollTimeoutMs,
            abortSignal: options.abortSignal,
          })
        : createdTask;

    const outputUrls = Array.isArray(completedTask?.output)
      ? completedTask.output
      : completedTask?.output
        ? [completedTask.output]
        : [];

    logger.info(
      {
        modelId: binding.modelId,
        providerModelId,
        providerJobId: completedTask?.id,
        outputCount: outputUrls.length,
        providerCredits: completedTask?.cost?.credits,
      },
      "[Runway] Task completed"
    );

    return {
      ...completedTask,
      output: outputUrls,
      outputs: outputUrls,
    };
  } catch (err) {
    if (err instanceof ProviderRequestError || err instanceof ProviderTransientError) {
      throw err;
    }
    throw normalizeRunwaySdkError(err, providerModelId);
  }
}

export { buildRunwayRequestBody, resolveRunwayRatio };
