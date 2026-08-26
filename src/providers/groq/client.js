import {
  ProviderRequestError,
  ProviderTransientError,
  ProviderContentPolicyError,
  ProviderMalformedResponseError,
} from "../../models/errors/index.js";

export class GroqClient {
  constructor({ baseUrl = "https://api.groq.com/openai/v1", apiKey, credential, timeoutMs = 60000 } = {}) {
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
      endpoint = executionConfig.endpoint || (typeof options.endpoint === "string" ? options.endpoint : "/chat/completions");
    }

    if (process.env.NODE_ENV === "test" && !this.apiKey?.startsWith("real_") && !this.apiKey?.startsWith("gsk_")) {
      return {
        choices: [{ message: { content: "Mock Groq completion response" } }],
        usage: { prompt_tokens: 10, completion_tokens: 15 },
      };
    }

    const url = `${this.baseUrl}${endpoint}`;
    let res;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: providerModelId || "llama-3.3-70b-versatile",
          ...payload,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (err) {
      if (err.name === "AbortError") {
        throw new ProviderTransientError(`Groq request timed out after ${this.timeoutMs}ms`);
      }
      throw new ProviderRequestError(`Network error calling Groq: ${err.message}`);
    }

    if (res.status === 429 || res.status === 503) {
      throw new ProviderTransientError(`Groq temporary rate limit (${res.status})`);
    }
    if (res.status === 422) {
      throw new ProviderContentPolicyError("Groq rejected request content");
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new ProviderRequestError(`Groq error status ${res.status}: ${errText.slice(0, 200)}`);
    }

    try {
      return await res.json();
    } catch {
      throw new ProviderMalformedResponseError("Groq returned invalid JSON");
    }
  }
}
