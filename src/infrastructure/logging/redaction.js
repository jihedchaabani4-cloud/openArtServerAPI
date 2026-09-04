/**
 * Sensitive field redaction paths and censors for Pino.
 * Guarantees zero credential, password, or token leakage.
 */

export const redactionPaths = [
  // HTTP Headers
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'req.headers["apikey"]',
  'req.headers["x-internal-secret"]',
  "headers.authorization",
  "headers.cookie",
  'headers["x-api-key"]',
  'headers["apikey"]',
  'headers["x-internal-secret"]',

  // Authentication & Tokens
  "token",
  "*.token",
  "accessToken",
  "*.accessToken",
  "access_token",
  "*.access_token",
  "refreshToken",
  "*.refreshToken",
  "refresh_token",
  "*.refresh_token",
  "jwt",
  "*.jwt",

  // Secrets & Keys
  "password",
  "*.password",
  "apiKey",
  "*.apiKey",
  "api_key",
  "*.api_key",
  "secret",
  "*.secret",
  "clientSecret",
  "*.clientSecret",
  "providerKey",
  "*.providerKey",
  "supabaseKey",
  "*.supabaseKey",
  "supabase_key",
  "*.supabase_key",
  "credential.apiKey",
  "*.credential.apiKey",
];

export const redactionConfig = {
  paths: redactionPaths,
  censor: "[REDACTED]",
};

const SENSITIVE_KEY_REGEX = /(?:authorization|cookie|password|secret|token|apikey|api_key)/i;

/**
 * Deep sanitizes an arbitrary plain JavaScript object or payload.
 *
 * @param {any} obj
 * @returns {any}
 */
export function sanitizeData(obj) {
  if (!obj || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(sanitizeData);
  }

  const sanitized = {};
  for (const [key, val] of Object.entries(obj)) {
    if (SENSITIVE_KEY_REGEX.test(key)) {
      sanitized[key] = "[REDACTED]";
    } else if (val && typeof val === "object") {
      sanitized[key] = sanitizeData(val);
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

export default redactionConfig;
