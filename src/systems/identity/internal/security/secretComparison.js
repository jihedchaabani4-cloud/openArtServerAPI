import crypto from "crypto";

/**
 * Constant-time comparison between a provided secret and expected secret.
 * Hashes both with SHA-256 first to prevent length-dependent timing leakage,
 * then performs timingSafeEqual on fixed 32-byte buffers.
 * Never logs or reveals secrets.
 *
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
export function safeCompareSecret(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !provided || !expected) {
    return false;
  }
  const hashProvided = crypto.createHash("sha256").update(provided).digest();
  const hashExpected = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(hashProvided, hashExpected);
}
