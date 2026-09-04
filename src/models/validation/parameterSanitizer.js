import { ValidationError } from "../errors/index.js";

/**
 * Sanitizes and validates text prompt parameters.
 *
 * @param {string} key - Parameter name (e.g. "prompt")
 * @param {string} value - User prompt text
 * @param {object} constraints - { maxLength, minLength }
 * @returns {string} Sanitized string
 */
export function sanitizePrompt(key, value, constraints = {}) {
  if (typeof value !== "string") {
    throw new ValidationError(`Parameter '${key}' must be a string`, { field: key });
  }

  const trimmed = value.trim();
  if (constraints.required && trimmed.length === 0) {
    throw new ValidationError(`Parameter '${key}' cannot be empty`, { field: key });
  }

  const maxLength = constraints.maxLength || constraints.max_length || 10000;
  if (trimmed.length > maxLength) {
    throw new ValidationError(
      `Parameter '${key}' exceeds maximum allowed length of ${maxLength} characters (got ${trimmed.length})`,
      { field: key, safeMessage: `Prompt exceeds max length of ${maxLength} characters` }
    );
  }

  const minLength = constraints.minLength || constraints.min_length || 0;
  if (trimmed.length < minLength) {
    throw new ValidationError(
      `Parameter '${key}' is shorter than minimum allowed length of ${minLength} characters`,
      { field: key }
    );
  }

  return trimmed;
}
