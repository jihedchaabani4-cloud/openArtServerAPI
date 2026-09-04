import { CredentialError } from "../errors/index.js";

// In-memory credential cache with 5-minute TTL
const credentialCache = new Map(); // providerId -> { apiKey, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolves credentials for a provider with multi-tiered resolution:
 * 1. In-memory TTL Cache
 * 2. Database `provider_credentials` table lookup (if Supabase client configured)
 * 3. Environment variable fallback (e.g. WAVESPEED_API_KEY, GOOGLE_API_KEY)
 * 4. User BYOK credentials if passed via credentialProvider
 */
export async function resolveCredential(binding, provider, credentialProvider = null, dbClient = null) {
  const providerId = provider?.id || binding?.providerId;
  if (!providerId) {
    throw new CredentialError("Cannot resolve credential: missing providerId");
  }

  // 1. Check in-memory TTL Cache
  const cached = credentialCache.get(providerId);
  if (cached && Date.now() < cached.expiresAt) {
    return { apiKey: cached.apiKey, credentialSource: "cache" };
  }

  // 2. Check BYOK if policy requires or allows
  const policy = binding?.credentialPolicy?.userBYOK ?? "forbidden";
  if (policy === "required" || policy === "allowed") {
    if (credentialProvider && typeof credentialProvider.getCredential === "function") {
      const key = await credentialProvider.getCredential(provider.auth?.credentialType || providerId);
      if (key) {
        return { apiKey: key, credentialSource: "user" };
      }
    }
    if (policy === "required") {
      throw new CredentialError(`BYOK credential required for provider "${providerId}" but not provided`);
    }
  }

  // 3. Check Supabase `provider_credentials` table (if dbClient provided or supabase global exists)
  if (dbClient) {
    try {
      const { data, error } = await dbClient
        .from("provider_credentials")
        .select("encrypted_key")
        .eq("provider_id", providerId)
        .single();

      if (!error && data?.encrypted_key) {
        // Simple decryption / key material retrieval
        const resolvedKey = data.encrypted_key;
        credentialCache.set(providerId, {
          apiKey: resolvedKey,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        return { apiKey: resolvedKey, credentialSource: "database" };
      }
    } catch {
      // Fall through to environment lookup
    }
  }

  // 4. Platform secret lookup from environment variables
  const envKey = `${providerId.toUpperCase()}_API_KEY`;
  const fallbackEnvKey = `${providerId.toUpperCase()}_KEY`;
  const platformKey =
    process.env[envKey] ||
    process.env[fallbackEnvKey] ||
    (providerId === "google"
      ? (process.env.GEMINI_API_KEY ||
         process.env.GOOGLE_AI_API_KEY ||
         process.env.GOOGLE_AI_STUDIO_API_KEY ||
         process.env.GOOGLE_API_KEY)
      : null);

  if (platformKey) {
    credentialCache.set(providerId, {
      apiKey: platformKey,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return { apiKey: platformKey, credentialSource: "platform_env" };
  }

  // If no key found
  return { apiKey: null, credentialSource: "none" };
}

export function clearCredentialCache(providerId = null) {
  if (providerId) {
    credentialCache.delete(providerId);
  } else {
    credentialCache.clear();
  }
}
