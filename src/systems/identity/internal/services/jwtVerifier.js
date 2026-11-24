/**
 * Local Supabase JWT / JWKS Verifier (zero external dependencies, node:crypto only).
 *
 * Supports:
 *   - Asymmetric JWTs (ES256 / RS256) verified via cached Supabase JWKS
 *     (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`) with TTL, in-flight
 *     request deduplication, and unknown-`kid` refresh with DoS cooldown.
 *   - Symmetric JWTs (HS256) verified via `SUPABASE_JWT_SECRET` using
 *     `crypto.createHmac("sha256", secret)` + `crypto.timingSafeEqual`.
 *
 * Strictly enforces:
 *   - Allowed algorithms matching the verification method (prevents `alg: none`
 *     and HS/RS/ES algorithm confusion).
 *   - `exp` (required, not expired) and `nbf` (if present, already active).
 *   - `iss` matching `<SUPABASE_URL>/auth/v1` (normalized trailing slash).
 *   - `aud` containing `"authenticated"` (string or array).
 *   - `sub` present and non-empty string.
 */
import crypto from "node:crypto";
import { createLogger, envConfig } from "#shared";

const jwtLogger = createLogger("auth_jwt");

export const PLACEHOLDER_TEST_SUPABASE_URL = "https://placeholder-test-project.supabase.co";
const MAX_TOKEN_LENGTH = 16384;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const ASYMMETRIC_ALGS = new Set(["ES256", "RS256"]);

// ── In-memory JWKS cache state ────────────────────────────────────────────────
let jwksCache = {
  url: "",
  keysByKid: new Map(),
  allKeys: [],
  expiresAt: 0,
  lastFetchAt: 0,
  inFlight: null,
};

let _unconfiguredWarned = false;
let _testJwksFetcher = null;
let _testClock = null;

function nowMs() {
  return typeof _testClock === "function" ? _testClock() : Date.now();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function looksLikeJwt(token) {
  return typeof token === "string" && token.split(".").length === 3;
}

/**
 * Resolves the active local JWT verification configuration from envConfig.
 */
export function getLocalJwtConfig() {
  const jwtSecret = envConfig.supabaseJwtSecret || "";
  const rawSupabaseUrl = (envConfig.rawSupabaseUrl || "").trim().replace(/\/+$/, "");
  const rawJwksUrl = envConfig.rawSupabaseJwksUrl || "";
  const jwksUrl = envConfig.supabaseJwksUrl || "";
  const issuer = envConfig.supabaseJwtIssuer || "";

  const isPlaceholderTestUrl =
    envConfig.isTest &&
    rawSupabaseUrl === PLACEHOLDER_TEST_SUPABASE_URL &&
    !rawJwksUrl &&
    !_testJwksFetcher;

  const hasSecret = jwtSecret.length > 0;
  const hasJwks = Boolean(_testJwksFetcher) || (Boolean(jwksUrl) && !isPlaceholderTestUrl);
  const isConfigured = hasSecret || hasJwks;

  return {
    jwtSecret,
    jwksUrl,
    issuer,
    rawSupabaseUrl,
    hasSecret,
    hasJwks,
    isConfigured,
    isPlaceholderTestUrl,
  };
}

/**
 * Determines whether an access token should be verified locally (true) or
 * whether the caller may fall back to `authClient.getUser(token)` (false).
 *
 * - In non-test environments: returns `true` whenever `SUPABASE_JWT_SECRET`,
 *   `SUPABASE_JWKS_URL`, or `SUPABASE_URL` is configured.
 * - In test environments: returns `true` whenever local verification is
 *   explicitly configured OR whenever the token has 3-segment JWT shape while
 *   the default placeholder Supabase URL is present (so forged/invalid JWTs are
 *   always rejected locally even in test mode, while legacy boundary tests
 *   passing opaque fixture tokens like `"alice-token"` keep working).
 */
export function shouldVerifyTokenLocally(token) {
  const config = getLocalJwtConfig();
  if (config.isConfigured) {
    return true;
  }
  if (config.isPlaceholderTestUrl && looksLikeJwt(token)) {
    return true;
  }
  return false;
}

/**
 * Logs a clear one-time warning when falling back to remote `auth.getUser`
 * because local JWT verification is not configured.
 */
export function warnUnconfiguredFallbackOnce() {
  const config = getLocalJwtConfig();
  if (config.isPlaceholderTestUrl) {
    return;
  }
  if (_unconfiguredWarned) {
    return;
  }
  _unconfiguredWarned = true;
  jwtLogger.warn(
    { event: "auth.local_jwt_unconfigured" },
    "Local JWT verification is not configured (missing SUPABASE_URL/SUPABASE_JWKS_URL and SUPABASE_JWT_SECRET); falling back to Supabase auth.getUser()"
  );
}

function decodeBase64UrlJson(segment) {
  if (!segment || !BASE64URL_RE.test(segment)) {
    return null;
  }
  try {
    const raw = Buffer.from(segment, "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isJwkCompatibleWithAlg(jwk, alg) {
  if (!isPlainObject(jwk)) return false;
  if (jwk.use && jwk.use !== "sig") return false;
  if (jwk.alg && jwk.alg !== alg) return false;
  if (alg === "ES256") {
    return jwk.kty === "EC" && jwk.crv === "P-256";
  }
  if (alg === "RS256") {
    return jwk.kty === "RSA";
  }
  return false;
}

function compileJwksEntries(keys) {
  const keysByKid = new Map();
  const allKeys = [];

  for (const jwk of keys) {
    if (!isPlainObject(jwk)) continue;
    if (jwk.use && jwk.use !== "sig") continue;
    if (jwk.kty !== "EC" && jwk.kty !== "RSA") continue;

    try {
      const keyObject = crypto.createPublicKey({ key: jwk, format: "jwk" });
      if (keyObject.type !== "public") continue;
      const entry = { jwk, keyObject };
      allKeys.push(entry);
      if (typeof jwk.kid === "string" && jwk.kid.trim()) {
        keysByKid.set(jwk.kid, entry);
      }
    } catch {
      // Skip malformed individual JWKs so a single bad key never breaks verification
    }
  }

  return { keysByKid, allKeys };
}

async function fetchJwksDocument(jwksUrl) {
  if (typeof _testJwksFetcher === "function") {
    return _testJwksFetcher(jwksUrl);
  }

  const timeoutMs = envConfig.jwksFetchTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(jwksUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`JWKS HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function refreshJwks(jwksUrl) {
  if (jwksCache.inFlight && jwksCache.url === jwksUrl) {
    return jwksCache.inFlight;
  }

  const fetchStart = nowMs();
  const promise = (async () => {
    try {
      const doc = await fetchJwksDocument(jwksUrl);
      if (!isPlainObject(doc) || !Array.isArray(doc.keys)) {
        throw new Error("Invalid JWKS document: missing keys array");
      }

      const { keysByKid, allKeys } = compileJwksEntries(doc.keys);
      const completedAt = nowMs();
      jwksCache = {
        url: jwksUrl,
        keysByKid,
        allKeys,
        expiresAt: completedAt + envConfig.jwksCacheTtlMs,
        lastFetchAt: completedAt,
        inFlight: null,
      };
      return jwksCache;
    } catch (err) {
      // Preserve existing unexpired keys on transient refresh failure,
      // while recording lastFetchAt to enforce cooldown.
      jwksCache.lastFetchAt = fetchStart;
      jwksCache.inFlight = null;
      jwtLogger.warn(
        { event: "auth.jwks_fetch_failed", err: err?.message || String(err) },
        "Failed to refresh Supabase JWKS"
      );
      return jwksCache;
    }
  })();

  jwksCache.url = jwksUrl;
  jwksCache.inFlight = promise;
  return promise;
}

async function resolveAsymmetricKeys(jwksUrl, alg, kid) {
  const currentTime = nowMs();
  const urlChanged = jwksCache.url !== jwksUrl;
  const cacheExpired = urlChanged || jwksCache.expiresAt <= currentTime || jwksCache.allKeys.length === 0;

  if (urlChanged) {
    jwksCache = {
      url: jwksUrl,
      keysByKid: new Map(),
      allKeys: [],
      expiresAt: 0,
      lastFetchAt: 0,
      inFlight: null,
    };
  }

  if (cacheExpired) {
    await refreshJwks(jwksUrl);
  }

  const findCandidates = () => {
    if (kid !== undefined) {
      const matched = jwksCache.keysByKid.get(kid);
      if (matched && isJwkCompatibleWithAlg(matched.jwk, alg)) {
        return [matched];
      }
      return [];
    }
    return jwksCache.allKeys.filter((entry) => isJwkCompatibleWithAlg(entry.jwk, alg));
  };

  let candidates = findCandidates();
  if (candidates.length > 0) {
    return candidates;
  }

  // Unknown kid (or no matching key) against a populated cache:
  // refresh once if cooldown has elapsed to handle key rotation without enabling JWKS DoS.
  if (!cacheExpired) {
    const elapsedSinceFetch = nowMs() - jwksCache.lastFetchAt;
    if (elapsedSinceFetch >= envConfig.jwksRefreshCooldownMs) {
      await refreshJwks(jwksUrl);
      candidates = findCandidates();
    }
  }

  return candidates;
}

function verifyHs256Signature(signingInput, signatureBuffer, secret) {
  const expected = crypto.createHmac("sha256", secret).update(signingInput, "utf8").digest();
  if (signatureBuffer.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(signatureBuffer, expected);
}

function verifyAsymmetricSignature(alg, signingInput, signatureBuffer, keyObject) {
  const data = Buffer.from(signingInput, "utf8");
  if (alg === "ES256") {
    // JWS ES256 uses raw IEEE P1363 (R || S, 64 bytes for P-256), not ASN.1 DER
    return crypto.verify("sha256", data, { key: keyObject, dsaEncoding: "ieee-p1363" }, signatureBuffer);
  }
  if (alg === "RS256") {
    return crypto.verify("sha256", data, keyObject, signatureBuffer);
  }
  return false;
}

function validateClaims(payload, expectedIssuer) {
  const nowSec = Math.floor(nowMs() / 1000);

  // exp is strictly required
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return { valid: false, reason: "missing_exp" };
  }
  if (payload.exp <= nowSec) {
    return { valid: false, reason: "token_expired" };
  }

  // nbf (if present) must be active
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf)) {
      return { valid: false, reason: "invalid_nbf" };
    }
    if (payload.nbf > nowSec) {
      return { valid: false, reason: "token_not_yet_valid" };
    }
  }

  // iss must match <SUPABASE_URL>/auth/v1 (trailing slash normalized)
  if (typeof payload.iss !== "string" || !payload.iss.trim()) {
    return { valid: false, reason: "missing_iss" };
  }
  const normalizedIss = payload.iss.trim().replace(/\/+$/, "");
  if (expectedIssuer && normalizedIss !== expectedIssuer) {
    return { valid: false, reason: "invalid_iss" };
  }

  // aud must contain "authenticated" (string or array)
  const aud = payload.aud;
  const hasAuthenticatedAud =
    aud === "authenticated" || (Array.isArray(aud) && aud.includes("authenticated"));
  if (!hasAuthenticatedAud) {
    return { valid: false, reason: "invalid_aud" };
  }

  // sub must be a non-empty string
  if (typeof payload.sub !== "string" || !payload.sub.trim()) {
    return { valid: false, reason: "missing_sub" };
  }

  return { valid: true };
}

/**
 * Verifies a Supabase access token locally in memory (zero calls to Supabase Auth API).
 *
 * @param {string} token
 * @returns {Promise<{ valid: true, user: { id: string, email: string|null, role: string|null, app_metadata: object, user_metadata: object }, claims: object } | { valid: false, reason: string }>}
 */
export async function verifySupabaseJwt(token) {
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH) {
    return { valid: false, reason: "malformed_token" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, reason: "malformed_token" };
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature || !BASE64URL_RE.test(encodedSignature)) {
    return { valid: false, reason: "malformed_token" };
  }

  const header = decodeBase64UrlJson(encodedHeader);
  const payload = decodeBase64UrlJson(encodedPayload);
  if (!header || !payload) {
    return { valid: false, reason: "malformed_json" };
  }

  const alg = header.alg;
  if (typeof alg !== "string" || !alg) {
    return { valid: false, reason: "missing_alg" };
  }

  const config = getLocalJwtConfig();
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signatureBuffer = Buffer.from(encodedSignature, "base64url");
  if (signatureBuffer.length === 0) {
    return { valid: false, reason: "empty_signature" };
  }

  // Verify cryptographic signature strictly matching header.alg -> configured verifier
  if (alg === "HS256") {
    if (!config.hasSecret) {
      return { valid: false, reason: "hs256_not_configured" };
    }
    if (!verifyHs256Signature(signingInput, signatureBuffer, config.jwtSecret)) {
      return { valid: false, reason: "invalid_signature" };
    }
  } else if (ASYMMETRIC_ALGS.has(alg)) {
    if (!config.hasJwks) {
      return { valid: false, reason: "jwks_not_configured" };
    }
    if (header.kid !== undefined && (typeof header.kid !== "string" || !header.kid.trim())) {
      return { valid: false, reason: "invalid_kid" };
    }

    const candidates = await resolveAsymmetricKeys(config.jwksUrl, alg, header.kid);
    if (candidates.length === 0) {
      return { valid: false, reason: "unknown_key" };
    }

    let sigValid = false;
    for (const candidate of candidates) {
      try {
        if (verifyAsymmetricSignature(alg, signingInput, signatureBuffer, candidate.keyObject)) {
          sigValid = true;
          break;
        }
      } catch {
        // Try next candidate key if any
      }
    }
    if (!sigValid) {
      return { valid: false, reason: "invalid_signature" };
    }
  } else {
    // Rejects `alg: "none"` and any unsupported algorithm
    return { valid: false, reason: "unsupported_alg" };
  }

  // Validate standard & Supabase JWT claims
  const claimCheck = validateClaims(payload, config.issuer);
  if (!claimCheck.valid) {
    return claimCheck;
  }

  const user = {
    id: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    role: typeof payload.role === "string" ? payload.role : null,
    app_metadata: isPlainObject(payload.app_metadata) ? payload.app_metadata : {},
    user_metadata: isPlainObject(payload.user_metadata) ? payload.user_metadata : {},
  };

  return { valid: true, user, claims: payload };
}

// ── Test-only helpers (guarded by NODE_ENV === 'test') ────────────────────────
export function resetJwtVerifierForTest() {
  if (!envConfig.isTest) {
    throw new Error("[jwtVerifier] resetJwtVerifierForTest is only permitted when NODE_ENV === 'test'");
  }
  jwksCache = {
    url: "",
    keysByKid: new Map(),
    allKeys: [],
    expiresAt: 0,
    lastFetchAt: 0,
    inFlight: null,
  };
  _unconfiguredWarned = false;
  _testJwksFetcher = null;
  _testClock = null;
}

export function setJwksFetcherForTest(fetcher) {
  if (!envConfig.isTest) {
    throw new Error("[jwtVerifier] setJwksFetcherForTest is only permitted when NODE_ENV === 'test'");
  }
  _testJwksFetcher = fetcher || null;
}

export function setJwtClockForTest(clockFn) {
  if (!envConfig.isTest) {
    throw new Error("[jwtVerifier] setJwtClockForTest is only permitted when NODE_ENV === 'test'");
  }
  _testClock = clockFn || null;
}
