import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCredential,
  clearCredentialCache
} from "../../credentials/credentialResolver.js";

describe("Credential Resolver (US5)", () => {
  beforeEach(() => {
    clearCredentialCache();
  });

  it("should resolve credential from environment variable fallback", async () => {
    process.env.TESTPROV_API_KEY = "sk-test-12345";

    const result = await resolveCredential(
      { providerId: "testprov" },
      { id: "testprov", authType: "bearer" }
    );

    assert.equal(result.apiKey, "sk-test-12345");
    assert.equal(result.credentialSource, "platform_env");
    delete process.env.TESTPROV_API_KEY;
  });

  it("should serve subsequent resolution requests from in-memory cache", async () => {
    process.env.TESTPROV_API_KEY = "sk-test-cache";

    const first = await resolveCredential(
      { providerId: "testprov" },
      { id: "testprov", authType: "bearer" }
    );
    assert.equal(first.credentialSource, "platform_env");

    // Remove from env to prove it is served from cache
    delete process.env.TESTPROV_API_KEY;

    const second = await resolveCredential(
      { providerId: "testprov" },
      { id: "testprov", authType: "bearer" }
    );
    assert.equal(second.apiKey, "sk-test-cache");
    assert.equal(second.credentialSource, "cache");
  });

  it("should resolve credential from mock database client", async () => {
    const mockDb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: { encrypted_key: "db-secret-key-99" },
              error: null
            })
          })
        })
      })
    };

    const result = await resolveCredential(
      { providerId: "supabase_prov" },
      { id: "supabase_prov", authType: "bearer" },
      null,
      mockDb
    );

    assert.equal(result.apiKey, "db-secret-key-99");
    assert.equal(result.credentialSource, "database");
  });

  it("should isolate BYOK credentials per user and prevent cache leakage between users", async () => {
    const binding = {
      providerId: "byok_prov",
      credentialPolicy: { userBYOK: "allowed" }
    };
    const provider = { id: "byok_prov", authType: "bearer" };

    const mockCredentialProviderUserA = {
      userId: "user-A",
      getCredential: async () => "key-for-user-A",
    };

    const mockCredentialProviderUserB = {
      userId: "user-B",
      getCredential: async () => "key-for-user-B",
    };

    // User A resolves and caches their key
    const resA = await resolveCredential(binding, provider, mockCredentialProviderUserA, null, { userId: "user-A" });
    assert.equal(resA.apiKey, "key-for-user-A");
    assert.equal(resA.credentialSource, "user");

    // User B resolves and must get THEIR OWN key, NOT User A's cached key
    const resB = await resolveCredential(binding, provider, mockCredentialProviderUserB, null, { userId: "user-B" });
    assert.equal(resB.apiKey, "key-for-user-B");
    assert.equal(resB.credentialSource, "user");

    // Subsequent resolution for User A should serve from cache with User A's key
    const cachedA = await resolveCredential(binding, provider, null, null, { userId: "user-A" });
    assert.equal(cachedA.apiKey, "key-for-user-A");
    assert.equal(cachedA.credentialSource, "cache");

    // Subsequent resolution for User B should serve from cache with User B's key
    const cachedB = await resolveCredential(binding, provider, null, null, { userId: "user-B" });
    assert.equal(cachedB.apiKey, "key-for-user-B");
    assert.equal(cachedB.credentialSource, "cache");
  });
});
