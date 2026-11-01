import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

describe("Task D: Swallowed Error Logging Boundary Tests", () => {
  it("TEST 1: useCaseWorker.js logs structured error instead of empty catch on direct media status update", () => {
    const content = fs.readFileSync(new URL("../../src/workers/useCaseWorker.js", import.meta.url), "utf8");
    // Must not have empty .catch(() => {}) on updateMedia
    assert.doesNotMatch(
      content,
      /updateMedia\([^)]*\)\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/,
      "useCaseWorker.js must not silently swallow updateMedia errors with empty catch"
    );
    assert.match(
      content,
      /updateMedia\([^)]*\)\.catch\(\s*\(dbErr\)\s*=>\s*\{[^}]*workerLogger\.error/,
      "useCaseWorker.js must log error via workerLogger.error when updateMedia fails"
    );
  });

  it("TEST 2: useCaseService.js logs structured error instead of empty catch on dispatch failure rollback", () => {
    const content = fs.readFileSync(new URL("../../src/services/useCaseService.js", import.meta.url), "utf8");
    assert.doesNotMatch(
      content,
      /rollbackUseCase\([^)]*\)\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/,
      "useCaseService.js must not silently swallow rollbackUseCase errors with empty catch"
    );
    assert.match(
      content,
      /rollbackUseCase\([^)]*\)\.catch\(\s*\(rollbackErr\)\s*=>\s*\{[^}]*useCaseLogger\.error/,
      "useCaseService.js must log error via useCaseLogger.error when immediate rollback fails"
    );
  });

  it("TEST 3: workflowRunner.js logs structured error instead of empty catch on updateNodeRun failure", () => {
    const content = fs.readFileSync(new URL("../../src/v2/runner/workflowRunner.js", import.meta.url), "utf8");
    assert.doesNotMatch(
      content,
      /updateNodeRun\([^)]*\)\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/,
      "workflowRunner.js must not silently swallow updateNodeRun errors with empty catch"
    );
    assert.match(
      content,
      /updateNodeRun[\s\S]*?\.catch\(\s*\(updateErr\)\s*=>\s*\{[\s\S]*?workflowLogger\.error/,
      "workflowRunner.js must log error via workflowLogger.error when updateNodeRun fails"
    );
  });
});
