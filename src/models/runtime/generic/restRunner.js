import fetch from "node-fetch";
import { ProviderRequestError, ProviderTransientError } from "../../errors/index.js";

/**
 * Generic REST Runner
 *
 * Universal HTTP runner for providers without a dedicated npm SDK.
 * Reads auth config from provider.json (authType, authHeader, baseUrl, etc.).
 * Supports both synchronous and async polling responses.
 *
 * Export shape:
 *   export async function run({ provider, binding, payload, credential, timeoutMs, options }) → rawResponse
 */
export async function run({ provider, binding, payload, credential, timeoutMs, options = {} }) {
  const providerId = provider?.id || "unknown";
  const baseUrl = (provider?.baseUrl || "").replace(/\/$/, "");
  const authType = provider?.authType || "bearer";
  const authHeader = provider?.authHeader || "Authorization";
  const authQueryParam = provider?.authQueryParam || null;
  const defaultTimeoutMs = provider?.defaultTimeoutMs || 30000;
  const resolvedTimeoutMs = timeoutMs || defaultTimeoutMs;

  let endpoint = options.endpoint || binding.endpoint || `/v1/models/${binding.providerModelId}/run`;
  if (!endpoint.startsWith("/")) endpoint = `/${endpoint}`;

  let url = `${baseUrl}${endpoint}`;

  // Build headers
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(options.headers || {}),
  };

  if (credential) {
    if (authType === "bearer") {
      headers[authHeader] = `Bearer ${credential}`;
    } else if (authType === "header" || authType === "apiKey") {
      if (authQueryParam) {
        const delimiter = url.includes("?") ? "&" : "?";
        url = `${url}${delimiter}${authQueryParam}=${encodeURIComponent(credential)}`;
      } else {
        headers[authHeader] = credential;
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolvedTimeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: options.method || "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      const timeoutErr = new ProviderTransientError(
        `Generic REST request to ${providerId} timed out after ${resolvedTimeoutMs}ms`
      );
      timeoutErr.statusCode = 504;
      timeoutErr.code = "PROVIDER_TIMEOUT";
      throw timeoutErr;
    }
    const netErr = new ProviderTransientError(
      `Network error connecting to ${providerId}: ${err.message}`
    );
    netErr.statusCode = 502;
    netErr.code = "PROVIDER_UNAVAILABLE";
    throw netErr;
  } finally {
    clearTimeout(timer);
  }

  const responseText = await response.text();
  let data;
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    data = { rawText: responseText };
  }

  if (!response.ok) {
    const errorMsg =
      data.error?.message || data.message || `Provider ${providerId} returned HTTP ${response.status}`;

    if (response.status === 429) {
      const rateLimitErr = new ProviderTransientError(errorMsg);
      rateLimitErr.statusCode = 429;
      rateLimitErr.code = "RATE_LIMITED";
      rateLimitErr.raw = data;
      throw rateLimitErr;
    }
    if (response.status >= 500) {
      const serverErr = new ProviderTransientError(errorMsg);
      serverErr.statusCode = response.status;
      serverErr.code = "PROVIDER_UNAVAILABLE";
      serverErr.raw = data;
      throw serverErr;
    }
    const clientErr = new ProviderRequestError(errorMsg);
    clientErr.statusCode = response.status;
    clientErr.code = "INVALID_INPUT_REJECTED_BY_PROVIDER";
    clientErr.raw = data;
    throw clientErr;
  }

  // Check if provider returned an async task requiring polling
  const taskId = data.id || data.task_id || data.prediction_id;
  const isPending =
    data.status === "processing" || data.status === "in_progress" || data.status === "pending";

  if (taskId && isPending && options.pollInterval && options.statusEndpoint) {
    return _pollTask(taskId, { baseUrl, authType, authHeader, credential }, options);
  }

  return data;
}

async function _pollTask(taskId, providerContext, options = {}) {
  const { baseUrl, authType, authHeader, credential } = providerContext;
  const pollIntervalMs = (options.pollInterval || 2) * 1000;
  const maxWaitMs = (options.timeout || 300) * 1000;
  const startTime = Date.now();

  const headers = { "Content-Type": "application/json" };
  if (credential) {
    if (authType === "bearer") {
      headers[authHeader] = `Bearer ${credential}`;
    } else {
      headers[authHeader] = credential;
    }
  }

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    let statusUrl = options.statusEndpoint.replace(":id", taskId);
    if (!statusUrl.startsWith("http")) {
      statusUrl = `${baseUrl}${statusUrl.startsWith("/") ? "" : "/"}${statusUrl}`;
    }

    const res = await fetch(statusUrl, { headers });
    if (!res.ok) continue;

    const data = await res.json();
    if (data.status === "completed" || data.status === "succeeded") return data;
    if (data.status === "failed" || data.status === "error") {
      const err = new ProviderRequestError(data.error || "Async prediction failed");
      err.raw = data;
      throw err;
    }
  }

  const timeoutErr = new ProviderTransientError(
    `Async task polling timed out after ${maxWaitMs / 1000}s`
  );
  timeoutErr.statusCode = 504;
  timeoutErr.code = "PROVIDER_TIMEOUT";
  throw timeoutErr;
}

