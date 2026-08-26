import {
  ProviderRequestError,
  ProviderTransientError,
  ProviderContentPolicyError,
  ProviderMalformedResponseError,
} from "../../models/errors/index.js";

export class GoogleClient {
  constructor({ baseUrl = "https://generativelanguage.googleapis.com/v1beta", apiKey } = {}) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async execute(arg1, arg2) {
    let endpoint, payload, providerModelId;
    if (typeof arg1 === "string") {
      endpoint = arg1;
      payload = arg2;
    } else {
      endpoint = arg1.endpoint;
      payload = arg1.payload;
      providerModelId = arg1.providerModelId;
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
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new ProviderRequestError(`Network error calling Google AI: ${err.message}`);
    }

    if (res.status === 429 || res.status === 503) {
      throw new ProviderTransientError(`Google AI temporary rate limit or error (${res.status})`);
    }
    if (res.status === 400 || res.status === 422) {
      const errText = await res.text().catch(() => "");
      if (errText.includes("SAFETY") || errText.includes("BLOCKED")) {
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
