import { GoogleGenAI } from "@google/genai";
import { ProviderRequestError, ProviderTransientError } from "../../errors/index.js";

/**
 * Google GenAI SDK Runner
 *
 * Dispatches to the SDK method declared in binding.sdkMethod (e.g. "generateContent", "generateImages").
 * Fully declarative: no provider-specific logic in execution layer.
 *
 * Export shape:
 *   export async function run({ binding, payload, credential, options }) → rawResponse
 */
export async function run({ binding, payload = {}, credential, options = {} }) {
  const providerModelId = binding.providerModelId;
  const apiKey = credential || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;

  const ai =
    options.sdkClient ||
    new GoogleGenAI({ apiKey });

  // Declarative method from binding JSON — no hardcoded method names here
  const method = binding.sdkMethod;
  if (!method) {
    throw new Error(
      `Google binding for "${providerModelId}" must declare "sdkMethod" ` +
      `(e.g. "generateImages", "generateContent")`
    );
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

  // Stream execution if requested and supported
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

  // Direct SDK Call
  const sdkFn = ai.models[method];
  if (typeof sdkFn !== "function") {
    throw new Error(`Google GenAI SDK method "${method}" is not supported`);
  }

  const response = await sdkFn.call(ai.models, sdkPayload);

  // Return standardized raw response (parameterMapper applies outputMap downstream)
  if (response?.generatedImages) {
    const images = response.generatedImages.map((img) =>
      img.image?.imageBytes
        ? `data:image/png;base64,${img.image.imageBytes}`
        : img.imageUri || img.uri || ""
    );
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
