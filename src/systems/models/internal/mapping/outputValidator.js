import { OutputContractViolationError } from "../errors/index.js";

/**
 * Output Contract Validator
 *
 * Validates normalized output from parameterMapper against domain expectations.
 * Throws OutputContractViolationError on strict contract violations.
 *
 * ── Architecture Principle ────────────────────────────────────────────────────
 * Silent success with empty URLs is NOT allowed.
 * If a model domain requires a URL (image, video), and none is returned,
 * this is a provider failure — not a successful empty generation.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Contract rules by domain:
 *   image  → at least one image.url required (non-empty string)
 *   video  → at least one image.url OR normalizedOutput.url required
 *   llm    → content or text required (can be empty string — model may respond empty)
 *   upscale → at least one image.url required
 */
export function validateOutput(normalizedOutput, binding, domain) {
  if (!normalizedOutput || typeof normalizedOutput !== "object") {
    throw new OutputContractViolationError(
      `Provider returned null or non-object output ` +
      `(binding: ${_bindingLabel(binding)}, domain: "${domain}")`
    );
  }

  switch (domain) {
    case "image":
    case "upscale":
      _requireImageUrl(normalizedOutput, binding, domain);
      break;

    case "video":
      _requireVideoUrl(normalizedOutput, binding, domain);
      break;

    case "llm":
      // LLM may return empty content — that is valid (model responded with nothing).
      // But the content field MUST exist.
      if (normalizedOutput.content === undefined && normalizedOutput.text === undefined) {
        throw new OutputContractViolationError(
          `LLM provider returned no text/content field ` +
          `(binding: ${_bindingLabel(binding)})`
        );
      }
      break;

    default:
      // Unknown domain — no strict contract, allow through
      break;
  }
}

function _hasValidMediaUrl(items, topLevelUrl) {
  const hasInList =
    Array.isArray(items) &&
    items.length > 0 &&
    items.some((item) => typeof item?.url === "string" && item.url.trim() !== "");

  const hasTopLevel =
    typeof topLevelUrl === "string" && topLevelUrl.trim() !== "";

  return hasInList || hasTopLevel;
}

function _requireImageUrl(normalizedOutput, binding, domain) {
  if (!_hasValidMediaUrl(normalizedOutput.images, normalizedOutput.url)) {
    throw new OutputContractViolationError(
      `Provider returned no valid image URL for domain "${domain}" ` +
      `(binding: ${_bindingLabel(binding)}). ` +
      `images[]: ${JSON.stringify(normalizedOutput.images?.slice(0, 2))}`
    );
  }
}

function _requireVideoUrl(normalizedOutput, binding, domain) {
  const hasUrl =
    _hasValidMediaUrl(normalizedOutput.videos, normalizedOutput.url) ||
    _hasValidMediaUrl(normalizedOutput.images, null);

  if (!hasUrl) {
    throw new OutputContractViolationError(
      `Provider returned no valid video URL for domain "${domain}" ` +
      `(binding: ${_bindingLabel(binding)})`
    );
  }
}

function _bindingLabel(binding) {
  if (!binding) return "unknown";
  return `${binding.modelId || "?"}:${binding.operation || "?"}:${binding.providerId || "?"}`;
}
