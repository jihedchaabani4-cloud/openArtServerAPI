import { GoogleGenAI } from "@google/genai";
import { ProviderRequestError, ProviderTransientError } from "../../errors/index.js";

/**
 * Official Google GenAI SDK Runner
 * Fully Declarative: Dispatches directly to the SDK method declared in binding.sdkMethod
 * Docs: https://aistudio.google.com/docs/libraries?codelanguage=javascript
 */
export async function runGoogleSdk({
  binding,
  payload = {},
  credential,
  options = {},
}) {
  const providerModelId = binding.providerModelId;
  const apiKey = credential || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;

  const ai =
    options.sdkClient ||
    new GoogleGenAI({
      apiKey,
    });

  // 1. Declarative Method Selection (strictly driven by binding.sdkMethod)
  const baseMethod = binding.sdkMethod || "generateContent";
  const streamMethod = binding.sdkStreamMethod || `${baseMethod}Stream`;

  const isStreaming = Boolean(
    options.onStreamChunk &&
      (typeof ai.models[streamMethod] === "function" || typeof ai.models[baseMethod] === "function")
  );

  const activeMethod = isStreaming
    ? typeof ai.models[streamMethod] === "function"
      ? streamMethod
      : baseMethod
    : baseMethod;

  const sdkFn = ai.models[activeMethod];

  if (typeof sdkFn !== "function") {
    throw new Error(`Google GenAI SDK method "${activeMethod}" is not supported`);
  }

  // Ensure standard prompt field is present if textPrompt was provided
  const normalizedPayload = {
    ...payload,
    ...(payload.textPrompt && !payload.prompt ? { prompt: payload.textPrompt } : {}),
  };

  try {
    // 2. Execute Streaming if requested
    if (isStreaming) {
      const stream = await sdkFn.call(ai.models, {
        model: providerModelId,
        ...normalizedPayload,
      });

      let fullText = "";
      for await (const chunk of stream) {
        const text = chunk.text || "";
        fullText += text;
        options.onStreamChunk({ text, raw: chunk });
      }

      return {
        text: fullText,
        outputs: [fullText],
      };
    }

    // Direct SDK Method Call
    const response = await sdkFn.call(ai.models, {
      model: providerModelId,
      ...normalizedPayload,
    });

    // 3. Declarative / Standard Output Normalization
    if (response?.generatedImages) {
      const images = response.generatedImages.map((img) => {
        if (img.image?.imageBytes) {
          return `data:image/png;base64,${img.image.imageBytes}`;
        }
        return img.imageUri || img.uri || "";
      });
      return {
        predictions: images.map((uri) => ({ bytesBase64Encoded: uri, uri })),
        images,
        outputs: images,
        raw: response,
      };
    }

    if (response?.text) {
      return {
        text: response.text,
        candidates: response.candidates,
        outputs: [response.text],
        raw: response,
      };
    }

    return response;
  } catch (err) {
    const errMsg = err.message || "Google GenAI SDK execution error";
    if (err.status === 429 || err.code === 429) {
      const rateLimitErr = new ProviderTransientError(`Google rate limit: ${errMsg}`);
      rateLimitErr.statusCode = 429;
      rateLimitErr.code = "RATE_LIMITED";
      rateLimitErr.raw = err;
      throw rateLimitErr;
    }
    if (err.status >= 500) {
      const serverErr = new ProviderTransientError(`Google service error: ${errMsg}`);
      serverErr.statusCode = err.status;
      serverErr.code = "PROVIDER_UNAVAILABLE";
      serverErr.raw = err;
      throw serverErr;
    }

    const clientErr = new ProviderRequestError(`Google SDK error: ${errMsg}`);
    clientErr.statusCode = err.status || 400;
    clientErr.code = "INVALID_INPUT_REJECTED_BY_PROVIDER";
    clientErr.raw = err;
    throw clientErr;
  }
}
