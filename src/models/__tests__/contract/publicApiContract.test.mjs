import assert from "node:assert/strict";
import * as modelsApi from "../../index.js";

console.log("Running Public API Contract Tests...");

assert.equal(typeof modelsApi.getCatalog, "function", "getCatalog exported");
assert.equal(typeof modelsApi.getSchema, "function", "getSchema exported");
assert.equal(typeof modelsApi.validateInput, "function", "validateInput exported");
assert.equal(typeof modelsApi.calculateCost, "function", "calculateCost exported");
assert.equal(typeof modelsApi.run, "function", "run exported");

// Assert internal engines are NOT leaked
assert.equal(modelsApi.registry, undefined, "registry is private");
assert.equal(modelsApi.loader, undefined, "loader is private");
assert.equal(modelsApi.deploymentResolver, undefined, "deploymentResolver is private");
assert.equal(modelsApi.credentialResolver, undefined, "credentialResolver is private");
assert.equal(modelsApi.pricingFormulas, undefined, "pricingFormulas is private");

// 1. getCatalog test
const catalog = modelsApi.getCatalog();
assert.ok(Array.isArray(catalog), "Catalog is array");
assert.ok(catalog.length > 0, "Catalog has entries");
const nano = catalog.find((c) => c.modelFamily === "nanobana");
assert.ok(nano, "nanobana in catalog");
assert.equal(nano.displayName, "NanoBanana");
assert.equal(nano.domain, "image");
assert.ok(nano.operations.includes("text_to_image"));
assert.ok(nano.operations.includes("edit"));

// 2. getSchema test (secrets stripped)
const schema = modelsApi.getSchema("nanobana", "text_to_image");
assert.ok(schema.inputs, "Inputs schema present");
assert.ok(schema.outputs, "Outputs schema present");
assert.equal(schema.pricing, undefined, "Pricing table stripped");
assert.equal(schema.endpoint, undefined, "Endpoint stripped");
assert.equal(schema.fieldMapping, undefined, "Field mapping stripped");

console.log("✓ Public API contract tests passed!");
