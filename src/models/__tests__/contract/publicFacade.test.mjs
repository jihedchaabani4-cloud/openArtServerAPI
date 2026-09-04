import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getCatalog,
  getSchema,
  validateInput,
  calculateCost,
  estimatePrice,
  resolveOperation,
} from "../../index.js";

describe("Public Facade Contract (T031)", () => {
  it("should return catalog entries matching expected contract schema", () => {
    const catalog = getCatalog();
    assert.ok(Array.isArray(catalog));
    assert.ok(catalog.length >= 1); // nanobana_pro

    const nanobana = catalog.find((m) => m.modelFamily === "nanobana_pro");
    assert.ok(nanobana);
    assert.equal(nanobana.displayName, "NanoBanana Pro");
    assert.equal(nanobana.domain, "image");
    assert.ok(nanobana.operations.includes("text_to_image"));
    assert.ok(nanobana.activeProviders.includes("wavespeed"));
    assert.ok(nanobana.activeProviders.includes("google"));
  });

  it("should filter catalog by domain", () => {
    const imageCatalog = getCatalog({ domain: "image" });
    assert.ok(imageCatalog.every((m) => m.domain === "image"));
    assert.ok(imageCatalog.some((m) => m.modelFamily === "nanobana_pro"));
  });

  it("should return schema for model operation", () => {
    const schema = getSchema("nanobana_pro", "text_to_image");
    assert.equal(schema.modelFamily, "nanobana_pro");
    assert.equal(schema.operation, "text_to_image");
    assert.ok(schema.inputs.prompt);
    assert.ok(schema.retailPricing);
  });

  it("should validate input and apply defaults", () => {
    const clean = validateInput("nanobana_pro", "text_to_image", {
      prompt: "a majestic golden eagle",
    });
    assert.equal(clean.prompt, "a majestic golden eagle");
    assert.equal(clean.resolution, "1k"); // Default applied
    assert.equal(clean.aspect_ratio, "1:1"); // Default applied
  });

  it("should calculate cost deterministically", () => {
    const cost1k = calculateCost("nanobana_pro", "text_to_image", {
      resolution: "1k",
      quality: "standard",
    });
    assert.equal(cost1k, 10);

    const cost4k = calculateCost("nanobana_pro", "text_to_image", {
      resolution: "4k",
      quality: "hd",
    });
    assert.equal(cost4k, 33);
  });

  it("should estimate price from raw input", () => {
    const estimate = estimatePrice("nanobana_pro", "text_to_image", {
      prompt: "test",
      resolution: "2k",
      quality: "hd",
    });
    assert.equal(estimate.amount, 21);
    assert.equal(estimate.currency, "credits");
  });

  it("should resolve operation correctly", () => {
    assert.equal(resolveOperation({}, "image"), "text_to_image");
    assert.equal(resolveOperation({ image_url: "https://example.com/img.png" }, "image"), "edit");
    assert.equal(resolveOperation({}, "text"), "chat_completion");
  });
});
