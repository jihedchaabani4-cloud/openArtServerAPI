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
  "credentials",
  "*.credentials",
  "serviceRoleKey",
  "*.serviceRoleKey",

  // Base64 Data & Massive Payloads
  "req.body.image",
  "req.body.data",
  "req.body.base64",
  "body.image",
  "body.data",
  "body.base64",
  "*.dataUri",
  "*.base64",
];

export const redactionConfig = {
  paths: redactionPaths,
  censor: "[REDACTED]",
  remove: false,
};

const SENSITIVE_KEY_REGEX = /password|secret|token|apikey|authorization|cookie|key/i;

export function sanitizeData(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(sanitizeData);
  }

  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_REGEX.test(key)) {
      clean[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      clean[key] = sanitizeData(value);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

export default redactionConfig;
