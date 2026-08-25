import assert from "node:assert/strict";
import { resolveServableDeployment } from "../../deployment/deploymentResolver.js";
import { NoServableDeploymentError, UnknownOperationError } from "../../errors/index.js";
import { loadRegistry } from "../../registry/loader.js";

loadRegistry();

console.log("Running Deployment Resolver & Single Servable Tests...");

// 1. Resolves active deployment
const dep = resolveServableDeployment("nanobana", "text_to_image");
assert.equal(dep.id, "nanobana.wavespeed");

// 2. Unknown operation throws UnknownOperationError
assert.throws(() => {
  resolveServableDeployment("nanobana", "non_existent_operation");
}, UnknownOperationError);

console.log("✓ Deployment resolver tests passed!");
