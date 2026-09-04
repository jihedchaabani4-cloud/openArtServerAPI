import fetch from "node-fetch";
import { ProviderRequestError, ProviderTransientError } from "../errors/index.js";

/**
 * Universal Generic REST Client
 * Builds requests dynamically from Provider and Binding definitions.
 */
export async function executeRest({ provider, binding, payload, credential, timeoutMs, customHeaders = {} }) {
  const baseUrl = provider.baseUrl.replace(/\/$/, "");
  let endpoint = binding.endpoint.startsWith("/") ? binding.endpoint : `/${binding.endpoint}`;

  let url = `${baseUrl}${endpoint}`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...customHeaders,
  };

  // Inject Authentication
  if (credential) {
    if (provider.authType === "bearer") {
      const headerKey = provider.authHeader || "Authorization";
      headers[headerKey] = `Bearer ${credential}`;
    } else if (provider.authType === "apiKey" && provider.authQueryParam) {
      const delimiter = url.includes("?") ? "&" : "?";
      url = `${url}${delimiter}${provider.authQueryParam}=${encodeURIComponent(credential)}`;
    } else if (provider.authType === "header" || (provider.authType === "apiKey" && provider.authHeader)) {
      const headerKey = provider.authHeader || "X-API-Key";
      headers[headerKey] = credential;
    }
  }

  const effectiveTimeout = timeoutMs || binding.timeoutMs || provider.defaultTimeoutMs || 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      const timeoutErr = new ProviderTransientError(`Request to provider ${provider.id} timed out after ${effectiveTimeout}ms`);
      timeoutErr.statusCode = 504;
      timeoutErr.code = "PROVIDER_TIMEOUT";
      throw timeoutErr;
    }
    const netErr = new ProviderTransientError(`Network error connecting to ${provider.id}: ${err.message}`);
    netErr.statusCode = 502;
    netErr.code = "PROVIDER_UNAVAILABLE";
    throw netErr;
  } finally {
    clearTimeout(timeoutId);
  }

  const responseText = await response.text();
  let parsedBody;
  try {
    parsedBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    parsedBody = { rawText: responseText };
  }

  if (!response.ok) {
    const errorMsg = parsedBody.error?.message || parsedBody.message || `Provider ${provider.id} returned HTTP ${response.status}`;
    if (response.status === 429) {
      const rateLimitErr = new ProviderTransientError(errorMsg);
      rateLimitErr.statusCode = 429;
      rateLimitErr.code = "RATE_LIMITED";
      rateLimitErr.raw = parsedBody;
      throw rateLimitErr;
    }
    if (response.status >= 500) {
      const serverErr = new ProviderTransientError(errorMsg);
      serverErr.statusCode = response.status;
      serverErr.code = "PROVIDER_UNAVAILABLE";
      serverErr.raw = parsedBody;
      throw serverErr;
    }
    const clientErr = new ProviderRequestError(errorMsg);
    clientErr.statusCode = response.status;
    clientErr.code = "INVALID_INPUT_REJECTED_BY_PROVIDER";
    clientErr.raw = parsedBody;
    throw clientErr;
  }

  return parsedBody;
}
