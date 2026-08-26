import {
  ProviderRequestError,
  ProviderTransientError,
  ProviderContentPolicyError,
  ProviderMalformedResponseError,
} from "../../models/errors/index.js";

export class GroqClient {
  constructor({ baseUrl = "https://api.groq.com/openai/v1", apiKey } = {}) {
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

    if (process.env.NODE_ENV === "test" && !this.apiKey?.startsWith("real_") && !this.apiKey?.startsWith("gsk_")) {
      return {
        choices: [{ message: { content: "Mock Groq completion response" } }],
        usage: { prompt_tokens: 10, completion_tokens: 15 },
      };
    }

    const url = `${this.baseUrl}${endpoint}`;
    let res;
    try {
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
      });
    } catch (err) {
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
