import fetch from "node-fetch";
import { ProviderRequestError, ProviderTransientError } from "../../errors/index.js";
import { createLogger } from "../../../infrastructure/logging/index.js";

const logger = createLogger("models");

// ─────────────────────────────────────────────────────────────────────────────
// Resolution helpers
// LTX requires WIDTHxHEIGHT strings. We store tier labels (720p, 1080p…) in
// the manifest and resolve them here based on the payload's aspect_ratio.
// ─────────────────────────────────────────────────────────────────────────────

const RESOLUTION_MAP = {
  "720p":  { "16:9": "1280x720",   "9:16": "720x1280"  },
  "1080p": { "16:9": "1920x1080",  "9:16": "1080x1920" },
  "1440p": { "16:9": "2560x1440",  "9:16": "1440x2560" },
  "4k":    { "16:9": "3840x2160",  "9:16": "2160x3840" },
};

function resolveResolution(tier, aspectRatio = "16:9") {
  const tierLower = (tier || "720p").toLowerCase();
  const ratioKey  = aspectRatio === "9:16" ? "9:16" : "16:9";
  // If already a WxH string, pass through
  if (/^\d+x\d+$/.test(tierLower)) return tierLower;
  return RESOLUTION_MAP[tierLower]?.[ratioKey] ?? "1280x720";
}

// ─────────────────────────────────────────────────────────────────────────────
// Operation routing
// Each binding carries an `operations` array with `when` conditions and an
// `endpoint`. We pick the highest-priority matching operation.
// ─────────────────────────────────────────────────────────────────────────────

function pickOperation(binding, payload) {
  const ops = binding.operations;

  // Extend / Retake bindings have a single operation with no `when` condition
  if (!ops || ops.length === 0) return null;
  if (ops.length === 1) return ops[0];

  for (const op of ops.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))) {
    if (!op.when) return op;
    const matches = Object.entries(op.when).every(([field, condition]) => {
      const providerField = binding.parameterMap?.[field]?.providerField;
      const val = payload[field] ?? (providerField ? payload[providerField] : undefined);
      const present = val !== undefined && val !== null && val !== "";
      return condition === "present" ? present : !present;
    });
    if (matches) return op;
  }

  // Fallback to last (lowest priority) operation
  return ops[ops.length - 1];
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter mapping
// Translates canonical backend keys → LTX API fields using binding.parameterMap.
// Handles both raw canonical payloads and pre-mapped provider payloads.
// Converts resolution tier to WxH and coerces numbers.
// ─────────────────────────────────────────────────────────────────────────────

function mapParameters(binding, payload) {
  const paramMap = binding.parameterMap || {};
  const mapped = {};

  // 1. Copy existing payload keys (handles pre-mapped providerPayload)
  for (const [key, val] of Object.entries(payload)) {
    if (val === undefined || val === null || val === "") continue;
    mapped[key] = val;
  }

  // 2. Also map canonical keys if present
  for (const [canonicalKey, mapping] of Object.entries(paramMap)) {
    const val = payload[canonicalKey];
    if (val === undefined || val === null || val === "") continue;
    mapped[mapping.providerField] = val;
    if (mapping.providerField !== canonicalKey && mapped[canonicalKey] !== undefined) {
      delete mapped[canonicalKey];
    }
  }

  // 3. Resolve resolution tier (720p, 1080p...) -> WxH string
  if (mapped.resolution) {
    mapped.resolution = resolveResolution(mapped.resolution, payload.aspect_ratio || mapped.aspect_ratio);
  }

  // 4. Ensure duration is numeric
  if (mapped.duration !== undefined && mapped.duration !== null) {
    mapped.duration = Number(mapped.duration);
  }

  // 5. Ensure fps is numeric
  if (mapped.fps !== undefined && mapped.fps !== null) {
    mapped.fps = Number(mapped.fps);
  }

  return mapped;
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling
// LTX is always async: POST → 202 { id } → poll GET /{endpoint}/{id}
// ─────────────────────────────────────────────────────────────────────────────

async function pollJob({ baseUrl, statusEndpoint, jobId, credential, pollingConfig }) {
  const pollIntervalMs = (pollingConfig?.pollInterval ?? 5) * 1000;
  const timeoutMs      = (pollingConfig?.timeout      ?? 600) * 1000;
  const completedSet   = new Set(pollingConfig?.completedStatuses ?? ["completed"]);
  const failedSet      = new Set(pollingConfig?.failedStatuses    ?? ["failed"]);

  const url     = `${baseUrl}${statusEndpoint.replace(":id", jobId)}`;
  const headers = { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" };

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    let res;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      logger.warn({ jobId, err: err.message }, "[LTX] Poll network error — retrying");
      continue;
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const msg     = errData?.error?.message ?? `LTX poll returned HTTP ${res.status}`;
      if (res.status >= 500) {
        logger.warn({ jobId, status: res.status }, "[LTX] Poll server error — retrying");
        continue;
      }
      const err = new ProviderRequestError(msg);
      err.statusCode = res.status;
      err.raw        = errData;
      throw err;
    }

    const data = await res.json();
    const status = data.status;

    if (completedSet.has(status)) {
      logger.info({ jobId }, "[LTX] Job completed");
      return data;
    }

    if (failedSet.has(status)) {
      const msg = data.error?.message ?? "LTX job failed";
      const err = new ProviderRequestError(msg);
      err.raw   = data;
      err.terminal = true;
      err.retryable = false;
      if (data.error?.type === "insufficient_funds_error" || /insufficient funds/i.test(msg)) {
        err.statusCode = 402;
        err.code       = "PROVIDER_QUOTA_EXCEEDED";
      } else {
        err.statusCode = 422;
        err.code       = "PROVIDER_JOB_FAILED";
      }
      throw err;
    }

    logger.debug({ jobId, status }, "[LTX] Polling…");
  }

  const timeoutErr = new ProviderTransientError(
    `[LTX] Job ${jobId} did not complete within ${timeoutMs / 1000}s`
  );
  timeoutErr.statusCode = 504;
  timeoutErr.code       = "PROVIDER_TIMEOUT";
  throw timeoutErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main runner  (export shape: { run })
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ provider, binding, payload, credential, timeoutMs, options }} args
 * @returns {Promise<object>} Normalised response with at least { result: { video_url } }
 */
export async function run({ provider, binding, payload, credential, timeoutMs, options = {} }) {
  const baseUrl    = (provider?.baseUrl ?? "https://api.ltx.io").replace(/\/$/, "");
  const apiKey     = credential;

  if (!apiKey) {
    const err = new ProviderRequestError("[LTX] No API key resolved — set LTX_API_KEY in environment");
    err.statusCode = 401;
    err.code       = "MISSING_CREDENTIAL";
    throw err;
  }

  // 1. Pick the right operation route (T2V / I2V / extend / retake)
  const operation = pickOperation(binding, payload);
  if (!operation) {
    throw new ProviderRequestError("[LTX] No matching operation found for the given payload");
  }

  // 2. Map canonical params → LTX API fields
  const ltxBody = mapParameters(binding, payload);

  // Always include model field (LTX requires it on every request)
  ltxBody.model = binding.providerModelId;

  const endpoint      = operation.endpoint;
  const statusEndpoint = operation.statusEndpoint;

  logger.info(
    { modelId: binding.modelId, operation: operation.id, endpoint },
    "[LTX] Submitting job"
  );

  // 3. Submit the job
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  let submitRes;
  try {
    submitRes = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(ltxBody),
      signal: AbortSignal.timeout(timeoutMs ?? 30000),
    });
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      const timeoutErr = new ProviderTransientError(
        `[LTX] Submit request timed out after ${timeoutMs}ms`
      );
      timeoutErr.statusCode = 504;
      timeoutErr.code = "PROVIDER_TIMEOUT";
      throw timeoutErr;
    }
    const netErr = new ProviderTransientError(`[LTX] Network error: ${err.message}`);
    netErr.statusCode = 502;
    netErr.code = "PROVIDER_UNAVAILABLE";
    throw netErr;
  }

  const submitText = await submitRes.text();
  let submitData;
  try {
    submitData = JSON.parse(submitText);
  } catch {
    submitData = { rawText: submitText };
  }

  if (!submitRes.ok) {
    const msg = submitData?.error?.message ?? `LTX submit HTTP ${submitRes.status}`;
    if (submitRes.status === 429) {
      const rateLimitErr = new ProviderTransientError(msg);
      rateLimitErr.statusCode = 429;
      rateLimitErr.code = "RATE_LIMITED";
      throw rateLimitErr;
    }
    if (submitRes.status >= 500) {
      const serverErr = new ProviderTransientError(msg);
      serverErr.statusCode = submitRes.status;
      serverErr.code = "PROVIDER_UNAVAILABLE";
      throw serverErr;
    }
    const clientErr = new ProviderRequestError(msg);
    clientErr.statusCode = submitRes.status;
    clientErr.code = "INVALID_INPUT_REJECTED_BY_PROVIDER";
    clientErr.raw  = submitData;
    throw clientErr;
  }

  const jobId = submitData.id;
  if (!jobId) {
    throw new ProviderRequestError(`[LTX] Submit response missing job id: ${JSON.stringify(submitData)}`);
  }

  logger.info({ jobId, operation: operation.id }, "[LTX] Job submitted — polling");

  // 4. Poll until complete
  const result = await pollJob({
    baseUrl,
    statusEndpoint,
    jobId,
    credential: apiKey,
    pollingConfig: binding.pollingConfig,
  });

  return result;
}
