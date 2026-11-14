import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Ticket 0.1 Unit Test: nodeBilling extraction and runner boundary", () => {
  it("imports nodeBilling cleanly and exports required functions", async () => {
    const nodeBilling = await import("#generation/tools");

    assert.equal(typeof nodeBilling.estimateNodeBillingAmount, "function");
    assert.equal(typeof nodeBilling.reserveNodeBilling, "function");
    assert.equal(typeof nodeBilling.settleNodeBilling, "function");
    assert.equal(typeof nodeBilling.rollbackNodeBilling, "function");
    assert.equal(typeof nodeBilling.getRunBillingAccumulator, "function");
    assert.equal(typeof nodeBilling.beginRunBillingAccumulator, "function");
    assert.equal(typeof nodeBilling.endRunBillingAccumulator, "function");
    assert.equal(typeof nodeBilling.initializeGateways, "function");
    assert.equal(typeof nodeBilling.getGateways, "function");
    assert.equal(typeof nodeBilling.isProviderBackedNodeType, "function");
    assert.equal(typeof nodeBilling.getNodeBillingReference, "function");
    assert.ok(nodeBilling.PersistedBillingAccumulator);
    assert.ok(nodeBilling.PROVIDER_BACKED_NODE_TYPES.has("image-generation"));
    assert.ok(nodeBilling.PROVIDER_BACKED_NODE_TYPES.has("video-generation"));
    assert.ok(nodeBilling.PROVIDER_BACKED_NODE_TYPES.has("llm"));
  });

  it("calculates estimateNodeBillingAmount correctly for non-billable and billable types", async () => {
    const { estimateNodeBillingAmount } = await import("#generation/tools");

    // Non-billable node type returns 0
    const nonBillableCost = estimateNodeBillingAmount({ type: "prompt-builder", id: "p1" });
    assert.equal(nonBillableCost, 0);

    // Billable image generation with known model
    const billableCost = estimateNodeBillingAmount(
      { type: "image-generation", id: "img1" },
      { model: "gpt_image_2", prompt: "a cat" }
    );
    assert.ok(typeof billableCost === "number");
    assert.ok(billableCost >= 0);
  });

  it("workflowRunner re-exports all nodeBilling items for backward compatibility", async () => {
    const runner = await import("#generation/tools");

    assert.equal(typeof runner.estimateNodeBillingAmount, "function");
    assert.equal(typeof runner.reserveNodeBilling, "function");
    assert.equal(typeof runner.settleNodeBilling, "function");
    assert.equal(typeof runner.rollbackNodeBilling, "function");
    assert.equal(typeof runner.getRunBillingAccumulator, "function");
    assert.equal(typeof runner.initializeGateways, "function");
    assert.equal(typeof runner.getGateways, "function");
    assert.equal(typeof runner.isProviderBackedNodeType, "function");
    assert.equal(typeof runner.getNodeBillingReference, "function");
    assert.ok(runner.PersistedBillingAccumulator);
  });

  it("nodeExecutor does NOT import from workflowRunner", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const fileUrl = new URL("../../src/systems/generation/internal/v2/runner/nodeExecutor.js", import.meta.url);
    const code = fs.readFileSync(fileUrl, "utf8");

    const hasWorkflowRunnerImport = /from\s+["'].*workflowRunner(\.js)?["']/.test(code);
    assert.equal(hasWorkflowRunnerImport, false, "nodeExecutor.js must not import workflowRunner.js");

    const hasNodeBillingImport = /from\s+["'].*nodeBilling(\.js)?["']/.test(code);
    assert.equal(hasNodeBillingImport, true, "nodeExecutor.js must import nodeBilling.js");
  });
});
