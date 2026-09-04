import { GoogleGenAI } from "@google/genai";
import { ProviderRequestError, ProviderTransientError } from "../../errors/index.js";

/**
 * Official Google GenAI SDK Runner
 * Interfaces with Google AI models via the @google/genai npm package.
 */
export async function runGoogleSdk({
  binding,
  payload,
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
    // Check if operation is image generation
    if (binding.operation === "text_to_image" || binding.operation === "edit") {
      const response = await ai.models.generateImages({
        model: providerModelId,
        prompt: payload.textPrompt || payload.prompt,
        config: {
          numberOfImages: payload.sampleCount || 1,
          aspectRatio: payload.aspectRatio || "1:1",
          ...(payload.imageSize ? { imageSize: payload.imageSize } : {}),
        },
      });

      // Normalize Google output format
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

    // Default: Content generation (Gemini LLM)
    const response = await ai.models.generateContent({
      model: providerModelId,
      contents: payload.contents || payload.prompt,
    });

    return {
      text: response.text,
      candidates: response.candidates,
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
