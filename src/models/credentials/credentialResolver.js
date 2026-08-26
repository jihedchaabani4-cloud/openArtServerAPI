import { CredentialError } from "../errors/index.js";

export async function resolveCredential(deployment, provider, credentialProvider = null) {
  const policy = deployment.credentialPolicy?.userBYOK ?? "forbidden";

  if (policy === "required") {
    if (!credentialProvider || typeof credentialProvider.getCredential !== "function") {
      throw new CredentialError("CredentialProvider required for BYOK model");
    }
    const key = await credentialProvider.getCredential(provider.auth?.credentialType);
    if (!key) {
      throw new CredentialError(`BYOK credential "${provider.auth?.credentialType}" required but not supplied`);
    }
    return { apiKey: key, credentialSource: "user" };
  }

  if (policy === "allowed" && credentialProvider && typeof credentialProvider.getCredential === "function") {
    const key = await credentialProvider.getCredential(provider.auth?.credentialType);
    if (key) {
      return { apiKey: key, credentialSource: "user" };
    }
  }

  // Platform secret lookup from env
  const envKey = `${provider.id.toUpperCase()}_API_KEY`;
  const fallbackEnvKey = `${provider.id.toUpperCase()}_KEY`;
  const platformKey =
    process.env[envKey] ||
    process.env[fallbackEnvKey] ||
    (provider.id === "google" ? (process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY) : null);

  if (!platformKey) {
    throw new CredentialError(`No platform credential configured for provider "${provider.id}" (expected env ${envKey})`);
  }

  return { apiKey: platformKey, credentialSource: "platform" };
}
