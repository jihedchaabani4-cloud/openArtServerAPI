import { CredentialError } from "../errors/index.js";

// In-memory credential cache with 5-minute TTL (acceleration layer over resolution)
const credentialCache = new Map(); // cacheKey -> { apiKey, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolves credentials for a provider with secure multi-tiered resolution:
 * - Acceleration Layer: In-memory TTL Cache (isolated per userId when BYOK is enabled)
 * - Resolution Tier 1: User BYOK credentials (if allowed/required by policy)
 * - Resolution Tier 2: Database `provider_credentials` table lookup (if Supabase client configured)
 * - Resolution Tier 3: Environment variable fallback (e.g. WAVESPEED_API_KEY, GOOGLE_API_KEY)
 *
 * The cache acts as an acceleration layer on top of resolution results, NEVER as a cross-user shortcut.
 */
export async function resolveCredential(binding, provider, credentialProvider = null, dbClient = null, options = {}) {
  const providerId = provider?.id || binding?.providerId;
  if (!providerId) {
    throw new CredentialError("Cannot resolve credential: missing providerId");
  }

  const policy = binding?.credentialPolicy?.userBYOK ?? "forbidden";
  const isByokPolicy = policy === "required" || policy === "allowed";
  const userId = options?.userId || binding?.userId || credentialProvider?.userId || null;

  // Derive cache key: strictly isolate by userId whenever BYOK is enabled
  const cacheKey = isByokPolicy
    ? (userId ? `${providerId}:user:${userId}` : null)
    : providerId;

  // 1. Acceleration Layer: Check in-memory TTL Cache
  if (cacheKey) {
    const cached = credentialCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return { apiKey: cached.apiKey, credentialSource: "cache" };
    }
  }

  // 2. Resolution Tier 1: User BYOK credentials
  if (isByokPolicy) {
    if (credentialProvider && typeof credentialProvider.getCredential === "function") {
      const key = await credentialProvider.getCredential(provider.auth?.credentialType || providerId);
      if (key) {
        if (cacheKey) {
          credentialCache.set(cacheKey, {
            apiKey: key,
            expiresAt: Date.now() + CACHE_TTL_MS,
          });
        }
        return { apiKey: key, credentialSource: "user" };
      }
    }
    if (policy === "required") {
      throw new CredentialError(`BYOK credential required for provider "${providerId}" but not provided`);
    }
  }

  // 3. Resolution Tier 2: Database `provider_credentials` table
  if (dbClient) {
    try {
      const { data, error } = await dbClient
        .from("provider_credentials")
        .select("encrypted_key")
        .eq("provider_id", providerId)
        .single();

      if (!error && data?.encrypted_key) {
        const resolvedKey = data.encrypted_key;
        if (cacheKey || providerId) {
          credentialCache.set(cacheKey || providerId, {
            apiKey: resolvedKey,
            expiresAt: Date.now() + CACHE_TTL_MS,
          });
        }
        return { apiKey: resolvedKey, credentialSource: "database" };
      }
    } catch {
      // Fall through to environment lookup
    }
  }

  // 4. Resolution Tier 3: Platform secret lookup from environment variables
  let platformKey = null;

  // Check explicit provider manifest envKeys first (declarative)
  if (Array.isArray(provider?.envKeys)) {
    for (const key of provider.envKeys) {
      if (process.env[key]) {
        platformKey = process.env[key];
        break;
      }
    }
  }

  // Generic fallback: <PROVIDER>_API_KEY or <PROVIDER>_KEY
  if (!platformKey) {
    const envKey = `${providerId.toUpperCase()}_API_KEY`;
    const fallbackEnvKey = `${providerId.toUpperCase()}_KEY`;
    platformKey = process.env[envKey] || process.env[fallbackEnvKey] || null;
  }

  if (platformKey) {
    if (cacheKey || providerId) {
      credentialCache.set(cacheKey || providerId, {
        apiKey: platformKey,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }
    return { apiKey: platformKey, credentialSource: "platform_env" };
  }

  // If no key found
  return { apiKey: null, credentialSource: "none" };
}
