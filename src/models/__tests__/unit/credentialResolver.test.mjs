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
});
