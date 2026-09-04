import { createLogger } from "../../infrastructure/logging/index.js";

const logger = createLogger("models");

/**
 * Generic Declarative Parameter Mapper
 *
 * Translates canonical request payloads into provider-specific request schemas
 * without requiring custom adapter code, and normalizes output structures.
 */

/**
 * Assigns a value to a nested object path using dot notation or array indexing (e.g. "options.dimensions.width", "images[0].url").
 */
export function setDeepProperty(target, pathString, value) {
  if (!target || typeof target !== "object") return;
  // Normalize array indexing: foo[0].bar -> foo.0.bar
  const normalized = pathString.replace(/\[(\w+)\]/g, ".$1");
  const parts = normalized.split(".");
  let curr = target;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];
    const isNextNumeric = /^\d+$/.test(nextPart);

    if (!curr[part] || typeof curr[part] !== "object") {
      curr[part] = isNextNumeric ? [] : {};
    }
    curr = curr[part];
  }

  curr[parts[parts.length - 1]] = value;
}

/**
 * Retrieves a value from a nested object path using dot notation or array indexing.
 */
export function getDeepProperty(obj, pathString) {
  if (!obj || !pathString) return undefined;
  // Normalize array indexing: foo[0].bar -> foo.0.bar
  const normalized = pathString.replace(/\[(\w+)\]/g, ".$1");
  const parts = normalized.split(".");
  let curr = obj;

  for (const part of parts) {
    if (curr === null || curr === undefined) return undefined;
    curr = curr[part];
  }

  return curr;
}

/**
 * Translates clean canonical inputs to provider payload based on binding parameterMap.
 */
export function mapToProviderPayload(cleanCanonicalInput = {}, binding = {}) {
  const providerPayload = {};
  const parameterMap = binding.parameterMap || {};

  for (const [canonicalKey, mapping] of Object.entries(parameterMap)) {
    const value = cleanCanonicalInput[canonicalKey];
    if (value === undefined || value === null) continue;

    let mappedValue = value;
    if (mapping.valueMap && Object.prototype.hasOwnProperty.call(mapping.valueMap, value)) {
      mappedValue = mapping.valueMap[value];
    }

    setDeepProperty(providerPayload, mapping.providerField || canonicalKey, mappedValue);
  }

  // Inject any static provider fields defined on binding
  if (binding.staticPayload) {
    for (const [key, val] of Object.entries(binding.staticPayload)) {
      setDeepProperty(providerPayload, key, val);
    }
  }

  return providerPayload;
}

/**
 * Normalizes raw provider response into uniform platform output.
 */
export function mapFromProviderResponse(rawResponse = {}, binding = {}) {
  if (!rawResponse) return { images: [], raw: null };

  const output = {
    images: [],
    text: null,
    raw: rawResponse
  };

  // 1. Explicit outputMap
  if (binding.outputMap && typeof binding.outputMap === "object" && Object.keys(binding.outputMap).length > 0) {
    for (const [targetPath, sourcePath] of Object.entries(binding.outputMap)) {
      const val = getDeepProperty(rawResponse, sourcePath);
      if (val !== undefined) {
        setDeepProperty(output, targetPath, val);
      }
    }
    // Normalize string array in images to object array if needed
    if (Array.isArray(output.images) && output.images.length > 0) {
      output.images = output.images.map((img) =>
        typeof img === "string" ? { url: img } : img
      );
    }
    if (output.text && !output.content) {
      output.content = output.text;
    } else if (output.content && !output.text) {
      output.text = output.content;
    }
    return output;
  }

  // 2. Last resort fallback: Log warning for missing outputMap
  const bindingId = binding?.modelId && binding?.providerId
    ? `${binding.modelId}:${binding.operation || "unknown"}:${binding.providerId}`
    : (binding?.providerId || "unknown");

  logger.warn(
    { bindingId },
    `[parameterMapper] Falling back to heuristic response guessing for binding "${bindingId}". An explicit "outputMap" should be defined in the binding manifest.`
  );

  // Common heuristic detections
  // WaveSpeed/OpenAI standard: data: [ { url }, { b64_json } ]
  if (Array.isArray(rawResponse.data)) {
    output.images = rawResponse.data
      .filter((item) => item.url || item.image_url)
      .map((item) => ({ url: item.url || item.image_url }));
  } else if (Array.isArray(rawResponse.images)) {
    output.images = rawResponse.images.map((img) => (typeof img === "string" ? { url: img } : img));
  } else if (Array.isArray(rawResponse.output)) {
    output.images = rawResponse.output.map((url) => (typeof url === "string" ? { url } : url));
  } else if (Array.isArray(rawResponse.outputs)) {
    output.images = rawResponse.outputs.map((item) => (typeof item === "string" ? { url: item } : item));
  } else if (rawResponse.predictions && Array.isArray(rawResponse.predictions)) {
    output.images = rawResponse.predictions
      .filter((p) => p.bytesBase64Encoded || p.imageUri || p.url)
      .map((p) => ({ url: p.imageUri || p.url || `data:image/png;base64,${p.bytesBase64Encoded}` }));
  }

  // LLM text completion standard
  if (rawResponse.choices && Array.isArray(rawResponse.choices) && rawResponse.choices[0]) {
    const choice = rawResponse.choices[0];
    output.text = choice.message?.content || choice.text || "";
  } else if (rawResponse.text) {
    output.text = rawResponse.text;
  } else if (rawResponse.content) {
    output.text = rawResponse.content;
  }
  output.content = output.text;

  return output;
}
