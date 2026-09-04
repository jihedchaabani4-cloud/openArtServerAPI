import assert from "node:assert/strict";
import { validateInput } from "../../validation/validationService.js";
import { SSRFBlockedError, ValidationError, UnknownParameterError } from "../../errors/index.js";
import { loadRegistry } from "../../registry/loader.js";

loadRegistry();

console.log("Running Security & Attack Tests...");

// 1. Injection & Unknown fields rejected with UnknownParameterError
assert.throws(() => {
  validateInput("nanobana", "text_to_image", {
    prompt: "A neon dragon",
    totalCredits: 9999,
    provider: "hacked",
    endpoint: "https://evil.com",
    __proto__: { isAdmin: true }
  });
}, UnknownParameterError);

// 2. SSRF metadata IP blocked
assert.throws(() => {
  validateInput("nanobana", "edit", {
    prompt: "Edit this",
    image_url: "https://169.254.169.254/latest/meta-data"
  });
}, SSRFBlockedError);

// 3. SSRF non-HTTPS blocked
assert.throws(() => {
  validateInput("nanobana", "edit", {
    prompt: "Edit this",
    image_url: "http://storage.googleapis.com/my-bucket/pic.jpg"
  });
}, ValidationError);

// 4. SSRF unallowed domain blocked
assert.throws(() => {
  validateInput("nanobana", "edit", {
    prompt: "Edit this",
    image_url: "https://evil-unauthorized-domain.com/pic.jpg"
  });
}, SSRFBlockedError);

// 5. Valid allowed HTTPS domain passes
const validClean = validateInput("nanobana", "edit", {
  prompt: "Edit this",
  image_url: "https://cdn.openart.ai/images/pic.jpg"
});
assert.equal(validClean.image_url, "https://cdn.openart.ai/images/pic.jpg");

console.log("✓ Security & attack tests passed!");
