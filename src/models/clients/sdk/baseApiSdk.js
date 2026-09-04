import fetch from "node-fetch";
import { ProviderRequestError, ProviderTransientError } from "../../errors/index.js";

/**
 * BaseApiSdk
 * Dynamic SDK Client for providers without an official npm package.
 * Encapsulates the provider's API link, authentication, polling, and error handling.
 */
export class BaseApiSdk {
  constructor(providerConfig = {}, credential = null) {
    this.provider = providerConfig;
    this.providerId = providerConfig.id || "unknown";
    this.baseUrl = (providerConfig.baseUrl || "").replace(/\/$/, "");
    this.authType = providerConfig.authType || "bearer";
    this.authHeader = providerConfig.authHeader || "Authorization";
    this.authQueryParam = providerConfig.authQueryParam || null;
    this.defaultTimeoutMs = providerConfig.defaultTimeoutMs || 30000;
    this.credential = credential;
  }

  /**
   * Builds request headers with authentication.
   */
  _buildHeaders(customHeaders = {}) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...customHeaders,
    };

    if (this.credential) {
      if (this.authType === "bearer") {
        headers[this.authHeader] = `Bearer ${this.credential}`;
      } else if (this.authType === "header" || this.authType === "apiKey") {
        headers[this.authHeader] = this.credential;
      }
    }

    return headers;
  }

  /**
   * Main SDK run method.
   * Dispatches task to provider API endpoint and resolves synchronously or via polling.
   */
  async run(providerModelId, payload = {}, options = {}) {
    let endpoint = options.endpoint || `/v1/models/${providerModelId}/run`;
    if (!endpoint.startsWith("/")) endpoint = `/${endpoint}`;

    let url = `${this.baseUrl}${endpoint}`;

    if (this.credential && this.authType === "apiKey" && this.authQueryParam) {
      const delimiter = url.includes("?") ? "&" : "?";
      url = `${url}${delimiter}${this.authQueryParam}=${encodeURIComponent(this.credential)}`;
    }

    const headers = this._buildHeaders(options.headers);
    const timeoutMs = options.timeoutMs || this.defaultTimeoutMs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

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
        const timeoutErr = new ProviderTransientError(`SDK request to provider ${this.providerId} timed out after ${timeoutMs}ms`);
        timeoutErr.statusCode = 504;
        timeoutErr.code = "PROVIDER_TIMEOUT";
        throw timeoutErr;
      }
      const netErr = new ProviderTransientError(`SDK Network error connecting to ${this.providerId}: ${err.message}`);
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
      const errorMsg = data.error?.message || data.message || `Provider ${this.providerId} returned HTTP ${response.status}`;
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
    const isPending = data.status === "processing" || data.status === "in_progress" || data.status === "pending";

    if (taskId && isPending && options.pollInterval && options.statusEndpoint) {
      return this._pollTask(taskId, options);
    }

    return data;
  }

  /**
   * Polls an asynchronous prediction until completion or timeout.
   */
  async _pollTask(taskId, options = {}) {
    const pollIntervalMs = (options.pollInterval || 2) * 1000;
    const maxWaitMs = (options.timeout || 300) * 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      let statusUrl = options.statusEndpoint.replace(":id", taskId);
      if (!statusUrl.startsWith("http")) {
        statusUrl = `${this.baseUrl}${statusUrl.startsWith("/") ? "" : "/"}${statusUrl}`;
      }

      const res = await fetch(statusUrl, {
        headers: this._buildHeaders(),
      });

      if (!res.ok) continue;

      const data = await res.json();
      if (data.status === "completed" || data.status === "succeeded") {
        return data;
      }
      if (data.status === "failed" || data.status === "error") {
        const err = new ProviderRequestError(data.error || "Async prediction failed");
        err.raw = data;
        throw err;
      }
    }

    const timeoutErr = new ProviderTransientError(`Async task polling timed out after ${maxWaitMs / 1000}s`);
    timeoutErr.statusCode = 504;
    timeoutErr.code = "PROVIDER_TIMEOUT";
    throw timeoutErr;
  }
}

/**
 * Factory to create a BaseApiSdk instance for any provider config.
 */
export function createApiSdkClient(providerConfig, credential) {
  return new BaseApiSdk(providerConfig, credential);
}
