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

  // 1. Declarative Method Selection from binding.sdkMethod (e.g. "generateImages", "generateContent")
  const method = binding.sdkMethod || "generateImages";
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

  // 3. Direct SDK Call
  const sdkFn = ai.models[method];
  if (typeof sdkFn !== "function") {
    throw new Error(`Google GenAI SDK method "${method}" is not supported`);
  }

  const response = await sdkFn.call(ai.models, sdkPayload);

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
