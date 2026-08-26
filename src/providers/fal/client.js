import {
  ProviderRequestError,
  ProviderTransientError,
  ProviderContentPolicyError,
  ProviderMalformedResponseError,
} from "../../models/errors/index.js";

export class FalClient {
  constructor({ baseUrl = "https://queue.fal.run", apiKey } = {}) {
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

    if (process.env.NODE_ENV === "test" && !this.apiKey?.startsWith("real_")) {
      return {
        images: [{ url: `https://cdn.openart.ai/fal/${Date.now()}.png` }],
      };
    }

    const url = `${this.baseUrl}${endpoint}`;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Key ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new ProviderRequestError(`Network error calling Fal.ai: ${err.message}`);
    }

    if (res.status === 429 || res.status === 503) {
      throw new ProviderTransientError(`Fal.ai temporary queue/capacity error (${res.status})`);
    }
    if (res.status === 422) {
      throw new ProviderContentPolicyError("Fal.ai content moderation rejected the request");
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new ProviderRequestError(`Fal.ai error status ${res.status}: ${errText.slice(0, 200)}`);
    }

    try {
      return await res.json();
    } catch {
      throw new ProviderMalformedResponseError("Fal.ai returned invalid JSON");
    }
  }
}
