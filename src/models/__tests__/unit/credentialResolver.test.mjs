import assert from "node:assert/strict";
import { resolveCredential } from "../../credentials/credentialResolver.js";
import { CredentialError } from "../../errors/index.js";

console.log("Running Credential Resolver Unit Tests...");

const mockProvider = {
  id: "testprov",
  auth: { type: "apiKey", credentialType: "test_key" }
};

// 1. Platform credential lookup
process.env.TESTPROV_API_KEY = "platform_secret_123";
const cred1 = await resolveCredential({ credentialPolicy: { userBYOK: "forbidden" } }, mockProvider);
assert.equal(cred1.apiKey, "platform_secret_123");
assert.equal(cred1.credentialSource, "platform");

// 2. User BYOK required - supplied
const mockCp = {
  async getCredential(type) {
    if (type === "test_key") return "user_key_456";
    return null;
  }
};
const cred2 = await resolveCredential({ credentialPolicy: { userBYOK: "required" } }, mockProvider, mockCp);
assert.equal(cred2.apiKey, "user_key_456");
assert.equal(cred2.credentialSource, "user");

// 3. User BYOK required - missing throws CredentialError
const emptyCp = { async getCredential() { return null; } };
await assert.rejects(async () => {
  await resolveCredential({ credentialPolicy: { userBYOK: "required" } }, mockProvider, emptyCp);
}, CredentialError);

console.log("✓ Credential resolver tests passed!");
