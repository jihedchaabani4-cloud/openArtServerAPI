import assert from "node:assert/strict";
import { validateStructural } from "../../registry/validator.js";
import { ConfigIntegrityError } from "../../errors/index.js";

console.log("Running Schema Validation Unit Tests...");

// 1. Valid family
assert.doesNotThrow(() => {
  validateStructural({
    id: "test-model",
    domain: "image",
    displayName: "Test Model"
  }, "family");
});

// 2. Invalid family (missing domain)
assert.throws(() => {
  validateStructural({
    id: "test-model",
    displayName: "Test Model"
  }, "family");
}, ConfigIntegrityError);

// 3. Valid provider
assert.doesNotThrow(() => {
  validateStructural({
    id: "test-provider",
    baseUrl: "https://api.test.com",
    auth: { type: "apiKey", credentialType: "test_key" },
    execution: { style: "sync" }
  }, "provider");
});

// 4. Invalid provider (bad URL format)
assert.throws(() => {
  validateStructural({
    id: "test-provider",
    baseUrl: "not-a-valid-uri",
    auth: { type: "apiKey", credentialType: "test_key" },
    execution: { style: "sync" }
  }, "provider");
}, ConfigIntegrityError);

console.log("✓ Schema validation tests passed!");
