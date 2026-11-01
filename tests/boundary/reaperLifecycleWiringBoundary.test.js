import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

describe("Task C: Reaper Lifecycle & Worker Wiring Boundary Tests", () => {
  it("TEST 1: v2WorkflowWorker.js wires into worker.js to ensure reaper runs on startup", () => {
    const content = fs.readFileSync(new URL("../../src/v2/queue/v2WorkflowWorker.js", import.meta.url), "utf8");
    assert.match(
      content,
      /import\s+.*from\s+["']\.\.\/\.\.\/workers\/worker\.js["']/,
      "v2WorkflowWorker.js must import worker.js (which includes the reservation reaper)"
    );
  });

  it("TEST 2: v2WorkflowWorker.js preserves compatibility exports for start_server.bat", async () => {
    const v2Module = await import("../../src/v2/queue/v2WorkflowWorker.js");
    assert.ok(v2Module.v2WorkflowWorker, "Must export v2WorkflowWorker");
    assert.ok(v2Module.default, "Must provide default export");
  });

  it("TEST 3: worker.js supports DISABLE_IN_PROCESS_REAPER to avoid duplicate intervals in multi-replica deployments", () => {
    const content = fs.readFileSync(new URL("../../src/workers/worker.js", import.meta.url), "utf8");
    assert.ok(
      content.includes("DISABLE_IN_PROCESS_REAPER"),
      "worker.js must support DISABLE_IN_PROCESS_REAPER flag for distributed deployments"
    );
  });
});
