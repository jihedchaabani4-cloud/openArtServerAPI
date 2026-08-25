import { ValidationError, SSRFBlockedError } from "../../errors/index.js";

const BLOCKED_HOSTS = new Set([
  "169.254.169.254",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
]);

export function validateImageUrl(key, url, rule = {}) {
  if (typeof url !== "string") {
    throw new ValidationError(`Field "${key}" must be a valid URL string`, { field: key });
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`Field "${key}" is not a valid URL`, { field: key });
  }

  if (parsed.protocol !== "https:") {
    throw new ValidationError(`Field "${key}" must use https: protocol`, { field: key });
  }

  if (BLOCKED_HOSTS.has(parsed.hostname) || parsed.hostname.startsWith("10.") || parsed.hostname.startsWith("192.168.")) {
    throw new SSRFBlockedError();
  }

  if (Array.isArray(rule.allowedDomains) && rule.allowedDomains.length > 0) {
    const isAllowed = rule.allowedDomains.some((domain) => {
      return parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`);
    });
    if (!isAllowed) {
      throw new SSRFBlockedError();
    }
  }

  return url;
}

export function validateImageUrlArray(key, arr, rule = {}) {
  if (!Array.isArray(arr)) {
    throw new ValidationError(`Field "${key}" must be an array of image URLs`, { field: key });
  }
  if (rule.minItems !== undefined && arr.length < rule.minItems) {
    throw new ValidationError(`Field "${key}" must contain at least ${rule.minItems} items`, { field: key });
  }
  if (rule.maxItems !== undefined && arr.length > rule.maxItems) {
    throw new ValidationError(`Field "${key}" cannot exceed ${rule.maxItems} items`, { field: key });
  }
  for (let i = 0; i < arr.length; i++) {
    validateImageUrl(`${key}[${i}]`, arr[i], rule);
  }
  return arr;
}

export function validateMessageArray(key, arr, rule = {}) {
  if (!Array.isArray(arr)) {
    throw new ValidationError(`Field "${key}" must be an array of messages`, { field: key });
  }
  const allowedRoles = ["system", "user", "assistant"];
  for (let i = 0; i < arr.length; i++) {
    const msg = arr[i];
    if (!msg || typeof msg !== "object") {
      throw new ValidationError(`Message at index ${i} must be an object`, { field: key });
    }
    if (!allowedRoles.includes(msg.role)) {
      throw new ValidationError(`Message at index ${i} has invalid role "${msg.role}"`, { field: key });
    }
    if (typeof msg.content !== "string") {
      throw new ValidationError(`Message at index ${i} content must be a string`, { field: key });
    }
  }
  return arr;
}
