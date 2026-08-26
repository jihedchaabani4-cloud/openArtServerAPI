import assert from "node:assert/strict";
import {
  getProviderClient,
  getProviderAdapter,
  listRegisteredRuntimes,
} from "../../registry/providerRuntimeRegistry.js";
import {
  ConfigIntegrityError,
  ProviderTransientError,
  ProviderContentPolicyError,
  ProviderRequestError,
  ProviderMalformedResponseError,
} from "../../errors/index.js";

console.log("Running Provider Client Contract Unit Tests...");

// 1. Verify Provider Runtime Registry & Zero Silent Fallbacks
const registered = listRegisteredRuntimes();
const expectedProviders = ["wavespeed", "google", "groq", "fal", "replicate"];
for (const p of expectedProviders) {
  assert.ok(registered.includes(p), `Provider "${p}" should be registered in runtime registry`);
}

// Ensure unknown provider throws ConfigIntegrityError immediately
assert.throws(
  () => getProviderClient("unknown-provider-xyz", {}),
  (err) => err instanceof ConfigIntegrityError && err.message.includes("No registered provider client runtime"),
  "Requesting unknown provider client must throw ConfigIntegrityError"
);

assert.throws(
  () => getProviderAdapter("unknown-provider-xyz"),
  (err) => err instanceof ConfigIntegrityError && err.message.includes("No registered provider adapter"),
  "Requesting unknown provider adapter must throw ConfigIntegrityError"
);

// 2. Test Execution Contract on all 5 registered providers
process.env.NODE_ENV = "test";

for (const providerId of expectedProviders) {
  const client = getProviderClient(providerId, {
    baseUrl: "https://test.provider.com",
    credential: { apiKey: "mock_test_key_123" },
    timeoutMs: 5000,
  });
  const adapter = getProviderAdapter(providerId);

  // Contract: client must expose execute()
  assert.equal(typeof client.execute, "function", `Provider "${providerId}" client must implement execute()`);

  // Contract: adapter must expose toProviderPayload and fromProviderResponse
  assert.equal(typeof adapter.toProviderPayload, "function", `Provider "${providerId}" adapter must implement toProviderPayload()`);
  assert.equal(typeof adapter.fromProviderResponse, "function", `Provider "${providerId}" adapter must implement fromProviderResponse()`);

  // Contract: client.execute must accept uniform execution parameters
  const rawResponse = await client.execute({
    providerModelId: "test-model-v1",
    payload: { prompt: "a cinematic landscape" },
    operation: "text_to_image",
    executionConfig: { endpoint: "/test-endpoint" },
  });

  assert.ok(rawResponse && typeof rawResponse === "object", `Provider "${providerId}" execute() must return an object`);

  // Contract: adapter.fromProviderResponse must normalize into valid contract shape
  const normalized = adapter.fromProviderResponse(rawResponse, { type: "image" });
  assert.ok(normalized && typeof normalized === "object", `Provider "${providerId}" adapter must normalize response`);
  assert.ok(normalized.type === "image" || normalized.type === "text", `Provider "${providerId}" normalized output must have valid type`);
}

// 3. Verify Error Taxonomy Subclasses and Attributes
const transientErr = new ProviderTransientError("Rate limit hit");
assert.equal(transientErr.retryable, true, "ProviderTransientError must be retryable");

const policyErr = new ProviderContentPolicyError("NSFW blocked");
assert.equal(policyErr.retryable, false, "ProviderContentPolicyError must NOT be retryable");

const requestErr = new ProviderRequestError("Bad request format");
assert.equal(requestErr.retryable, true, "ProviderRequestError must be retryable");

const malformedErr = new ProviderMalformedResponseError("Invalid JSON from server");
assert.equal(malformedErr.retryable, false, "ProviderMalformedResponseError must NOT be retryable");

console.log("✓ Provider Client Contract tests passed across all 5 providers!");
