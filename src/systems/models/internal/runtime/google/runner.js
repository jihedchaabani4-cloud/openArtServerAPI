import { GoogleGenAI } from "@google/genai";
import { ProviderRequestError, ProviderTransientError } from "../../errors.js";
import { envConfig } from "#shared";

/**
 * Google GenAI SDK Runner
 *
 * Dispatches to the SDK method declared in binding.sdkMethod (e.g. "generateContent", "generateImages").
 * Fully declarative: no provider-specific logic in execution layer.
 *
 * Export shape:
 *   export async function run({ binding, payload, credential, options }) → rawResponse
 */
export async function run({ binding, payload = {}, credential, timeoutMs, options = {} }) {
  const providerModelId = binding.providerModelId;
  const apiKey = credential || envConfig.geminiApiKey;

  const rawTimeoutMs = timeoutMs ?? options.timeoutMs;
  const resolvedTimeoutMs =
    typeof rawTimeoutMs === "number" && Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0
      ? rawTimeoutMs
      : null;

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

  const controller = resolvedTimeoutMs ? new AbortController() : null;
  if (controller) {
    sdkPayload.config = {
      ...(sdkPayload.config || {}),
      abortSignal: controller.signal,
    };
  }

  const runWithOptionalTimeout = async (workFn) => {
    if (!resolvedTimeoutMs) {
      return await workFn();
    }
    let timer = null;
    let timedOut = false;
    const workPromise = Promise.resolve().then(workFn);
    workPromise.catch(() => {});

    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller?.abort();
        const timeoutErr = new ProviderTransientError(
          `Google GenAI request for "${providerModelId}" timed out after ${resolvedTimeoutMs}ms`
        );
        timeoutErr.code = "PROVIDER_TIMEOUT";
        timeoutErr.statusCode = 504;
        timeoutErr.retryable = true;
        reject(timeoutErr);
      }, resolvedTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });

    try {
      return await Promise.race([workPromise, timeoutPromise]);
    } catch (err) {
      if (timedOut && err.code !== "PROVIDER_TIMEOUT") {
        const timeoutErr = new ProviderTransientError(
          `Google GenAI request for "${providerModelId}" timed out after ${resolvedTimeoutMs}ms`
        );
        timeoutErr.code = "PROVIDER_TIMEOUT";
        timeoutErr.statusCode = 504;
        timeoutErr.retryable = true;
        throw timeoutErr;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // Stream execution if requested and supported
  if (options.onStreamChunk && typeof ai.models[`${method}Stream`] === "function") {
    return await runWithOptionalTimeout(async () => {
      const stream = await ai.models[`${method}Stream`](sdkPayload);
      let fullText = "";
      for await (const chunk of stream) {
        const text = chunk.text || "";
        fullText += text;
        options.onStreamChunk({ text, raw: chunk });
      }
      return { text: fullText, content: fullText, outputs: [fullText] };
    });
  }

  // Direct SDK Call
  const sdkFn = ai.models[method];
  if (typeof sdkFn !== "function") {
    throw new Error(`Google GenAI SDK method "${method}" is not supported`);
  }

  const response = await runWithOptionalTimeout(() => sdkFn.call(ai.models, sdkPayload));

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
