import assert from "node:assert/strict";
import { validateInput } from "../../validation/validationService.js";
import { ValidationError } from "../../errors/index.js";
import { loadRegistry } from "../../registry/loader.js";

loadRegistry();

console.log("Running Input Types Unit Tests...");

// 1. Valid input with defaults applied
const clean = validateInput("nanobana", "text_to_image", {
  prompt: "A beautiful forest",
});
assert.equal(clean.prompt, "A beautiful forest");
assert.equal(clean.quality, "standard", "Default standard applied");
assert.equal(clean.aspect_ratio, "1:1", "Default 1:1 applied");

// 2. Missing required field
assert.throws(() => {
  validateInput("nanobana", "text_to_image", {
    quality: "hd"
  });
}, (err) => err instanceof ValidationError && err.field === "prompt");

// 3. Invalid enum value
assert.throws(() => {
  validateInput("nanobana", "text_to_image", {
    prompt: "Test",
    quality: "ultra_hd"
  });
}, ValidationError);

console.log("✓ Input types tests passed!");
