import { GoogleGenAI } from "@google/genai";
import { ProviderRequestError, ProviderTransientError } from "../../errors/index.js";

/**
 * Official Google GenAI SDK Runner
 * Interfaces with Google AI Studio & Gemini API via the official @google/genai package.
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

  try {
    // 1. Image Generation (Imagen 3 / Imagen 4)
    if (binding.operation === "text_to_image") {
      const response = await ai.models.generateImages({
        model: providerModelId,
        prompt: payload.textPrompt || payload.prompt,
        config: {
          numberOfImages: payload.sampleCount || payload.numberOfImages || 1,
          aspectRatio: payload.aspectRatio || "1:1",
          ...(payload.imageSize ? { imageSize: payload.imageSize } : {}),
          ...(payload.outputMimeType ? { outputMimeType: payload.outputMimeType } : {}),
        },
      });

      const generatedImages = response.generatedImages || [];
      const images = generatedImages.map((img) => {
        if (img.image?.imageBytes) {
          return `data:image/png;base64,${img.image.imageBytes}`;
        }
        return img.imageUri || img.uri || "";
      });

      return {
        predictions: images.map((uri) => ({ bytesBase64Encoded: uri, uri })),
        images,
        raw: response,
      };
    }

    // 2. Image Editing
    if (binding.operation === "edit" || binding.operation === "image_to_image") {
      if (typeof ai.models.editImage === "function" && payload.image) {
        const response = await ai.models.editImage({
          model: providerModelId,
          prompt: payload.textPrompt || payload.prompt,
          referenceImages: Array.isArray(payload.image) ? payload.image : [payload.image],
        });
        const generatedImages = response.generatedImages || [];
        const images = generatedImages.map((img) => img.imageUri || img.uri || "");
        return { predictions: images.map((uri) => ({ uri })), images, raw: response };
      }
    }

    // 3. Streaming Chat / LLM Generation (Gemini 2.0 / 2.5)
    if ((options.onStreamChunk || payload.streaming) && typeof ai.models.generateContentStream === "function") {
      const stream = await ai.models.generateContentStream({
        model: providerModelId,
        contents: payload.contents || payload.prompt || payload.messages,
        config: {
          ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
          ...(payload.max_tokens ? { maxOutputTokens: payload.max_tokens } : {}),
          ...(payload.top_p !== undefined ? { topP: payload.top_p } : {}),
          ...(payload.system_prompt ? { systemInstruction: payload.system_prompt } : {}),
        },
      });

      let fullText = "";
      for await (const chunk of stream) {
        const text = chunk.text || "";
        fullText += text;
        if (options.onStreamChunk) {
          options.onStreamChunk({ text, raw: chunk });
        }
      }

      return {
        text: fullText,
        outputs: [fullText],
      };
    }

    // 4. Synchronous Content Generation (Gemini LLM)
    const response = await ai.models.generateContent({
      model: providerModelId,
      contents: payload.contents || payload.prompt || payload.messages,
      config: {
        ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
        ...(payload.max_tokens ? { maxOutputTokens: payload.max_tokens } : {}),
        ...(payload.top_p !== undefined ? { topP: payload.top_p } : {}),
        ...(payload.system_prompt ? { systemInstruction: payload.system_prompt } : {}),
      },
    });

    return {
      text: response.text,
      candidates: response.candidates,
      outputs: [response.text],
      raw: response,
    };
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
