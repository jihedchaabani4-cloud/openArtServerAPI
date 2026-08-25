import assert from "node:assert/strict";
import { run } from "../../index.js";

console.log("Running Run & Idempotency Tests...");

process.env.NODE_ENV = "test";
process.env.WAVESPEED_API_KEY = "test_key";

const mockCp = { async getCredential() { return null; } };

// 1. First execution
const res1 = await run("nanobana", "text_to_image", {
  prompt: "A beautiful garden",
  quality: "standard"
}, {
  idempotencyKey: "test-replay-key-999",
  credentialProvider: mockCp
});

assert.equal(res1.type, "image");
assert.ok(res1.url, "Has output URL");
assert.equal(res1.metadata.deploymentUsed, "nanobana.wavespeed");
assert.equal(res1.metadata.idempotent, false);

// 2. Idempotent replay
const res2 = await run("nanobana", "text_to_image", {
  prompt: "A beautiful garden",
  quality: "standard"
}, {
  idempotencyKey: "test-replay-key-999",
  credentialProvider: mockCp
});

assert.equal(res2.url, res1.url, "Returned same cached URL");
assert.equal(res2.metadata.idempotent, true, "Marked as idempotent replay");

console.log("✓ Run & Idempotency tests passed!");
