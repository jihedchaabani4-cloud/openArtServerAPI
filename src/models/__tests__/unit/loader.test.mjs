import assert from "node:assert/strict";
import { loadRegistry, getRegistry } from "../../registry/loader.js";

console.log("Running Registry Loader Unit Tests...");

const { families, providers, deployments } = loadRegistry();

assert.ok(families.has("nanobana"), "nanobana loaded into families");
assert.ok(providers.has("wavespeed"), "wavespeed loaded into providers");
assert.ok(deployments.has("nanobana.wavespeed"), "nanobana.wavespeed loaded into deployments");

const family = families.get("nanobana");
assert.equal(family.displayName, "NanoBanana");
assert.equal(family.domain, "image");

const dep = deployments.get("nanobana.wavespeed");
assert.equal(dep.status, "active");
assert.ok(dep.operations.text_to_image, "has text_to_image operation");
assert.ok(dep.operations.edit, "has edit operation");

console.log("✓ Registry loader tests passed!");
