import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

describe("Ticket 0.3 Unit Test: catalogPresentation and models/index.js cycle break", () => {
  it("catalogPresentation.js does NOT import models/index.js", () => {
    const fileUrl = new URL("../../src/models/catalogPresentation.js", import.meta.url);
    const code = fs.readFileSync(fileUrl, "utf8");

    const hasIndexImport = /from\s+["'].*index(\.js)?["']/.test(code);
    assert.equal(hasIndexImport, false, "catalogPresentation.js must not import from index.js");

    const hasQueriesImport = /from\s+["'].*catalogQueries(\.js)?["']/.test(code);
    assert.equal(hasQueriesImport, true, "catalogPresentation.js must import from catalogQueries.js");
  });

  it("catalogQueries.js exports getCatalog and calculateCost", async () => {
    const queries = await import("../../src/models/catalogQueries.js");
    assert.equal(typeof queries.getCatalog, "function");
    assert.equal(typeof queries.calculateCost, "function");

    const catalog = queries.getCatalog();
    assert.ok(Array.isArray(catalog));
    assert.ok(catalog.length > 0);

    const cost = queries.calculateCost("gpt_image_2", { prompt: "a cute robot" });
    assert.ok(typeof cost === "number");
    assert.ok(cost > 0);
  });

  it("models/index.js preserves public API contract for getCatalog, calculateCost, and getModelConfig", async () => {
    const models = await import("../../src/models/index.js");

    assert.equal(typeof models.getCatalog, "function");
    assert.equal(typeof models.calculateCost, "function");
    assert.equal(typeof models.getModelConfig, "function");

    const catalog = models.getCatalog();
    assert.ok(Array.isArray(catalog));

    const config = models.getModelConfig();
    assert.ok(config);
    assert.ok(Array.isArray(config.models));
  });
});
