import {
  ProviderRequestError,
  ProviderTransientError,
  ProviderContentPolicyError,
  ProviderMalformedResponseError,
} from "../../models/errors/index.js";

export class GoogleClient {
  constructor({ baseUrl = "https://generativelanguage.googleapis.com/v1beta", apiKey, credential, timeoutMs = 60000 } = {}) {
    this.baseUrl = baseUrl;
    this.apiKey = credential?.apiKey || apiKey || "";
    this.timeoutMs = timeoutMs;
  }

  async execute(options, legacyPayload) {
    let endpoint, payload, providerModelId, operation, executionConfig;

    if (typeof options === "string") {
      endpoint = options;
      payload = legacyPayload;
      executionConfig = { endpoint };
    } else {
      payload = options.payload;
      providerModelId = options.providerModelId;
      operation = options.operation;
      executionConfig = options.executionConfig || {};
      endpoint = executionConfig.endpoint || (typeof options.endpoint === "string" ? options.endpoint : `/models/${providerModelId || "gemini-2.0-flash"}:generateContent`);
    }

    if (process.env.NODE_ENV === "test" && !this.apiKey?.startsWith("real_") && !this.apiKey?.startsWith("AIza")) {
      return {
        candidates: [{ content: { parts: [{ text: "Mock Google Gemini response" }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15 },
      };
    }

    const url = `${this.baseUrl}${endpoint}?key=${this.apiKey}`;
    let res;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (err) {
      if (err.name === "AbortError") {
        throw new ProviderTransientError(`Google AI request timed out after ${this.timeoutMs}ms`);
      }
      throw new ProviderRequestError(`Network error calling Google AI: ${err.message}`);
    }

    if (res.status === 429 || res.status === 503) {
      throw new ProviderTransientError(`Google AI temporary rate limit or error (${res.status})`);
    }
    if (res.status === 400 || res.status === 422) {
      const errText = await res.text().catch(() => "");
      if (errText.includes("SAFETY") || errText.includes("BLOCKED") || errText.includes("HARM_CATEGORY")) {
        throw new ProviderContentPolicyError("Google AI content moderation blocked the prompt");
      }
      throw new ProviderRequestError(`Google AI request error (${res.status}): ${errText.slice(0, 200)}`);
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new ProviderRequestError(`Google AI error status ${res.status}: ${errText.slice(0, 200)}`);
    }

    try {
      return await res.json();
    } catch {
      throw new ProviderMalformedResponseError("Google AI returned invalid JSON");
    }
  }
}
