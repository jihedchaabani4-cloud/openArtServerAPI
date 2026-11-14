import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

describe("Task C: Reaper Lifecycle & Worker Wiring Boundary Tests", () => {
  it("TEST 1: worker.js wires into useCaseWorker.js to ensure reaper runs on startup", () => {
    const content = fs.readFileSync(
      new URL("../../src/systems/generation/internal/workers/worker.js", import.meta.url),
      "utf8"
    );
    assert.match(
      content,
      /import\s+.*from\s+["']\.\/useCaseWorker\.js["']/,
      "worker.js must import useCaseWorker.js (which includes the reservation reaper)"
    );
  });

  it("TEST 2: #generation/tools preserves compatibility exports for v2WorkflowWorker", async () => {
    const v2Module = await import("#generation/tools");
    assert.ok(v2Module.v2WorkflowWorker, "Must export v2WorkflowWorker");
    assert.ok(v2Module.worker, "Must export worker");
  });

  it("TEST 3: worker.js supports DISABLE_IN_PROCESS_REAPER to avoid duplicate intervals in multi-replica deployments", () => {
    const content = fs.readFileSync(
      new URL("../../src/systems/generation/internal/workers/worker.js", import.meta.url),
      "utf8"
    );
    assert.ok(
      content.includes("DISABLE_IN_PROCESS_REAPER") || content.includes("disableInProcessReaper"),
      "worker.js must support DISABLE_IN_PROCESS_REAPER flag for distributed deployments"
    );
  });
});
