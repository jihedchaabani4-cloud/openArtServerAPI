import { MissingOutputMapError } from "../errors/index.js";
import { createLogger } from "../../infrastructure/logging/index.js";

const logger = createLogger("models");

/**
 * Generic Declarative Parameter Mapper
 *
 * Translates canonical request payloads into provider-specific request schemas
 * without requiring custom adapter code, and normalizes output structures.
 *
 * ── Architecture Principle ───────────────────────────────────────────────────
 * The canonical→provider transformation happens HERE via:
 *   binding.parameterMap (field rename + value translation)
 *   binding.valueMap (enum value translation)
 *   binding.staticPayload (injected provider-specific constants)
 *
 * NO ParameterNormalizerService or GlobalParameterTransformer is ever needed.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Assigns a value to a nested object path using dot notation or array indexing.
 * Example paths: "options.dimensions.width", "images[0].url"
 */
export function setDeepProperty(target, pathString, value) {
  if (!target || typeof target !== "object") return;
  // Normalize array indexing: foo[0].bar → foo.0.bar
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
 *
 * @param {object} cleanCanonicalInput - Validated canonical input
 * @param {object} binding - Binding manifest with parameterMap + staticPayload
 * @returns {object} Provider-specific payload
 */
export function mapToProviderPayload(cleanCanonicalInput = {}, binding = {}) {
  const providerPayload = {};
  const parameterMap = binding.parameterMap || {};

  for (const [canonicalKey, mapping] of Object.entries(parameterMap)) {
    const value = cleanCanonicalInput[canonicalKey];
    if (value === undefined || value === null) continue;

    let mappedValue = value;

    // Apply valueMap translation (enum remapping)
    if (mapping.valueMap && Object.prototype.hasOwnProperty.call(mapping.valueMap, value)) {
      mappedValue = mapping.valueMap[value];
    }

    // Apply scalar → array wrapping (e.g. input_image → images: [url])
    if (mapping.transform === "wrap_array" && !Array.isArray(mappedValue)) {
      mappedValue = [mappedValue];
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
 *
 * Uses explicit outputMap from binding if available.
 * Falls back to heuristic detection with a warning log.
 *
 * @param {any} rawResponse - Raw provider response
 * @param {object} binding - Binding manifest with outputMap
 * @returns {{ images: object[], text: string|null, content: string|null, raw: any }}
 */
export function mapFromProviderResponse(rawResponse = {}, binding = {}) {
  if (!rawResponse) return { images: [], text: null, content: null, raw: null };

  const output = {
    images: [],
    text: null,
    content: null,
    raw: rawResponse,
  };

  // 1. Explicit outputMap (preferred — defined in binding JSON)
  if (
    binding.outputMap &&
    typeof binding.outputMap === "object" &&
    Object.keys(binding.outputMap).length > 0
  ) {
    for (const [targetPath, sourcePath] of Object.entries(binding.outputMap)) {
      const val = getDeepProperty(rawResponse, sourcePath);
      if (val !== undefined) {
        setDeepProperty(output, targetPath, val);
      }
    }

    // Normalize string array or provider-specific image objects into canonical { url }
    if (Array.isArray(output.images) && output.images.length > 0) {
      output.images = output.images.map((img) => {
        if (typeof img === "string") return { url: img };
        if (img && typeof img === "object") {
          const url = img.url || img.imageUri || img.uri || img.src;
          if (url) {
            const canonicalImg = { url };
            if (img.width) canonicalImg.width = img.width;
            if (img.height) canonicalImg.height = img.height;
            return canonicalImg;
          }
        }
        return img;
      });
    }

    // Sync text ↔ content
    if (output.text && !output.content) {
      output.content = output.text;
    } else if (output.content && !output.text) {
      output.text = output.content;
    }

    return output;
  }

  // 2. Strict Invariant: Missing outputMap is a configuration error (Zero Heuristic Guessing)
  throw new MissingOutputMapError(
    binding?.modelId || "unknown",
    binding?.operation || "unknown",
    binding?.providerId || "unknown"
  );
}
