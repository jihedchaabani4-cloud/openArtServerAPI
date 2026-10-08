import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferWorkflowMediaRole, WORKFLOW_MEDIA_ROLES } from "../../src/db/workflowMediaRole.js";

describe("workflow media role inference", () => {
  it("maps legacy generation and upload step ids to canonical roles", () => {
    assert.equal(inferWorkflowMediaRole({ stepId: "image_generation" }), "output");
    assert.equal(inferWorkflowMediaRole({ stepId: "video_generation" }), "output");
    assert.equal(inferWorkflowMediaRole({ stepId: "upload" }), "original");
    assert.equal(inferWorkflowMediaRole({ stepId: "CAE", workflowType: "UPLOAD" }), "original");
  });

  it("maps character and element step ids to canonical roles (element has detail only, no sheet)", () => {
    assert.equal(inferWorkflowMediaRole({ stepId: "character_sheet" }), "sheet");
    assert.equal(inferWorkflowMediaRole({ stepId: "character_detail" }), "detail");
    assert.equal(inferWorkflowMediaRole({ stepId: "element_sheet" }), "detail");
    assert.equal(inferWorkflowMediaRole({ stepId: "element_reference" }), "detail");
    assert.equal(inferWorkflowMediaRole({ stepId: "CAE", workflowType: "CHARACTER_SHEET" }), "sheet");
    assert.equal(inferWorkflowMediaRole({ stepId: "CAE", workflowType: "ELEMENT_SHEET" }), "detail");
    assert.equal(inferWorkflowMediaRole({ stepId: "anything", workflowType: "ELEMENT" }), "detail");
  });

  it("accepts explicit valid roles and falls back to output", () => {
    assert.equal(inferWorkflowMediaRole({ role: "detail", stepId: "image_generation" }), "detail");
    assert.equal(inferWorkflowMediaRole({ role: "not-a-role", stepId: "unknown" }), "output");
    assert.deepEqual(WORKFLOW_MEDIA_ROLES, ["output", "original", "sheet", "detail", "reference", "avatar", "turnaround"]);
  });
});
