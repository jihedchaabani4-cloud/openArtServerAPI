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
  const providerModelId =
    options.sdkClient
      ? binding.providerModelId
      : (process.env.GEMINI_MODEL || (binding.providerModelId === "gemini-2.0-flash" ? "gemini-3.6-flash" : binding.providerModelId));
  const apiKey = credential || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;

  const ai =
    options.sdkClient ||
    new GoogleGenAI({
      apiKey,
    });

  // 1. Declarative Method Selection (strictly defined by binding.sdkMethod in JSON)
  const method = binding.sdkMethod;
  if (!method) {
    throw new Error(`Google binding for "${providerModelId}" must declare "sdkMethod" (e.g. "generateImages", "generateContent")`);
  }
  const sdkPayload = {
    model: providerModelId,
    ...payload,
    ...(payload.textPrompt && !payload.prompt ? { prompt: payload.textPrompt } : {}),
  };

  // Ensure prompt/contents compatibility for Google GenAI methods
  if (sdkPayload.contents === undefined && sdkPayload.prompt) {
    sdkPayload.contents = sdkPayload.prompt;
  } else if (Array.isArray(sdkPayload.contents)) {
    sdkPayload.contents = sdkPayload.contents.map((item) => {
      if (typeof item === "string") return item;
      if (item && item.content && !item.parts) {
        const textPart = typeof item.content === "string" ? { text: item.content } : item.content;
        return {
          role: item.role === "assistant" ? "model" : item.role === "system" ? "user" : item.role,
          parts: Array.isArray(textPart) ? textPart : [textPart],
        };
      }
      return item;
    });
  }

  // 2. Stream execution if requested and supported
  if (options.onStreamChunk && typeof ai.models[`${method}Stream`] === "function") {
    const stream = await ai.models[`${method}Stream`](sdkPayload);
    let fullText = "";
    for await (const chunk of stream) {
      const text = chunk.text || "";
      fullText += text;
      options.onStreamChunk({ text, raw: chunk });
    }
    return { text: fullText, content: fullText, outputs: [fullText] };
  }

  // 3. Direct SDK Call with self-healing model deprecation fallback
  const sdkFn = ai.models[method];
  if (typeof sdkFn !== "function") {
    throw new Error(`Google GenAI SDK method "${method}" is not supported`);
  }

  let response;
  try {
    response = await sdkFn.call(ai.models, sdkPayload);
  } catch (err) {
    const isDeprecated =
      err?.message &&
      (err.message.includes("no longer available") ||
       err.message.includes("gemini-3.6-flash") ||
       (err.status === 404 && typeof err.message === "string" && err.message.includes("models/")));

    if (isDeprecated && sdkPayload.model !== "gemini-3.6-flash") {
      sdkPayload.model = "gemini-3.6-flash";
      response = await sdkFn.call(ai.models, sdkPayload);
    } else {
      throw err;
    }
  }

  // 4. Return formatted response (standardized for downstream pipeline)
  if (response?.generatedImages) {
    const images = response.generatedImages.map((img) => {
      return img.image?.imageBytes
        ? `data:image/png;base64,${img.image.imageBytes}`
        : img.imageUri || img.uri || "";
    });
    return { predictions: images.map((uri) => ({ uri })), images, outputs: images, raw: response };
  }

  if (response?.text) {
    return {
      text: response.text,
      content: response.text,
      candidates: response.candidates,
      outputs: [response.text],
      raw: response,
    };
  }

  return response;
}
