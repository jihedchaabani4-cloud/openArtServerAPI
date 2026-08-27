import { GoogleGenAI } from "@google/genai";
import {
  ProviderRequestError,
  ProviderTransientError,
  ProviderContentPolicyError,
  ProviderMalformedResponseError,
} from "../../models/errors/index.js";

export class GoogleClient {
  constructor({ baseUrl, apiKey, credential, timeoutMs = 60000 } = {}) {
    this.apiKey = credential?.apiKey || apiKey || "";
    this.timeoutMs = timeoutMs;
    this.ai = new GoogleGenAI({ apiKey: this.apiKey });
  }

  async execute(options, legacyPayload) {
    let payload, providerModelId, operation, executionConfig;

    if (typeof options === "string") {
      payload = legacyPayload;
      executionConfig = { endpoint: options };
    } else {
      payload = options.payload;
      providerModelId = options.providerModelId;
      operation = options.operation;
      executionConfig = options.executionConfig || {};
    }

    if (process.env.NODE_ENV === "test" && !this.apiKey?.startsWith("real_") && !this.apiKey?.startsWith("AIza")) {
      return {
        text: "Mock Google Gemini response",
        candidates: [{ content: { parts: [{ text: "Mock Google Gemini response" }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15 },
      };
    }

    const modelName = providerModelId || "gemini-2.0-flash";

    try {
      // Execute via official Google Gen AI SDK
      const response = await this.ai.models.generateContent({
        model: modelName,
        contents: payload.contents || payload.prompt || payload,
        config: payload.config || payload.generationConfig,
      });

      return {
        text: response.text || "",
        candidates: response.candidates,
        usageMetadata: response.usageMetadata,
      };
    } catch (err) {
      const msg = err.message || String(err);
      if (err.name === "AbortError" || msg.includes("timeout") || msg.includes("DEADLINE_EXCEEDED")) {
        throw new ProviderTransientError(`Google AI request timed out: ${msg}`);
      }
      if (
        msg.includes("429") ||
        msg.includes("RESOURCE_EXHAUSTED") ||
        msg.includes("503") ||
        msg.includes("UNAVAILABLE")
      ) {
        throw new ProviderTransientError(`Google AI temporary rate limit or error: ${msg}`);
      }
      if (
        msg.includes("SAFETY") ||
        msg.includes("BLOCKED") ||
        msg.includes("HARM_CATEGORY")
      ) {
        throw new ProviderContentPolicyError(`Google AI content moderation blocked the prompt: ${msg}`);
      }
      if (msg.includes("400") || msg.includes("INVALID_ARGUMENT")) {
        throw new ProviderRequestError(`Google AI request error: ${msg}`);
      }
      throw new ProviderRequestError(`Google AI error: ${msg}`);
    }
  }
}
