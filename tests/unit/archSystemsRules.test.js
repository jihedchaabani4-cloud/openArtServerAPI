import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  checkRuleR10,
  checkRuleR11,
  checkRuleR12,
  checkRuleR13,
  checkRuleR15,
  checkRuleR16,
  findImportCycles,
  collect,
} = require("../../scripts/arch-check.cjs");

describe("Ticket 0.4 Architecture Rules R10-R16 and Cycle Detector", () => {
  function makeFile(relPath, content) {
    return {
      rel: relPath,
      text: content,
      lines: content.split(/\r?\n/),
    };
  }

  describe("Rule R10: System gateways", () => {
    it("allows public/api and public/tools access", () => {
      const file = makeFile(
        "src/controllers/orderController.js",
        `import { billingTools } from "#billing/tools";\nimport { identityRouter } from "#identity/api";\n`
      );
      const hits = checkRuleR10(file);
      assert.equal(hits.length, 0);
    });

    it("flags deep internal imports from another system", () => {
      const file = makeFile(
        "src/controllers/orderController.js",
        `import { walletRepo } from "#billing/internal/db/walletRepo.js";\n`
      );
      const hits = checkRuleR10(file);
      assert.equal(hits.length, 1);
    });
  });

  describe("Rule R11: Internal cannot import own public gateways", () => {
    it("flags internal file importing its own system public gateway", () => {
      const file = makeFile(
        "src/systems/billing/internal/services/walletService.js",
        `import { billingTools } from "#billing/tools";\n`
      );
      const hits = checkRuleR11(file);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].text.includes("#billing/tools"));
    });

    it("allows internal file importing sibling internal file", () => {
      const file = makeFile(
        "src/systems/billing/internal/services/walletService.js",
        `import { walletRepo } from "../db/walletRepo.js";\n`
      );
      const hits = checkRuleR11(file);
      assert.equal(hits.length, 0);
    });
  });

  describe("Rule R12: DB & SDK client isolation", () => {
    it("flags supabase import outside internal/db/ or internal/storage/", () => {
      const file = makeFile(
        "src/systems/billing/internal/services/walletService.js",
        `import { createClient } from "@supabase/supabase-js";\n`
      );
      const hits = checkRuleR12(file);
      assert.equal(hits.length, 1);
    });

    it("flags supabase import in legacy folders outside src/systems/", () => {
      const file = makeFile(
        "src/domain/project/ProjectService.js",
        `import { supabase } from "#lib/supabase.js";\n`
      );
      const hits = checkRuleR12(file);
      assert.equal(hits.length, 1);
    });

    it("allows supabase import inside internal/db/", () => {
      const file = makeFile(
        "src/systems/billing/internal/db/walletRepo.js",
        `import { createClient } from "@supabase/supabase-js";\n`
      );
      const hits = checkRuleR12(file);
      assert.equal(hits.length, 0);
    });
  });

  describe("Rule R13: Web framework isolation", () => {
    it("flags express in internal services", () => {
      const file = makeFile(
        "src/systems/billing/internal/services/walletService.js",
        `import express from "express";\n`
      );
      const hits = checkRuleR13(file);
      assert.equal(hits.length, 1);
    });

    it("allows express in public/api.js", () => {
      const file = makeFile(
        "src/systems/billing/public/api.js",
        `import express from "express";\n`
      );
      const hits = checkRuleR13(file);
      assert.equal(hits.length, 0);
    });
  });

  describe("Rule R16: Zero outbound legacy imports from src/systems/ or src/shared/", () => {
    it("flags relative outbound imports to legacy src/domain/ or controllers/", () => {
      const file = makeFile(
        "src/systems/workspace/public/tools.js",
        `import { ProjectService } from "../../../domain/project/ProjectService.js";\n`
      );
      const hits = checkRuleR16(file);
      assert.equal(hits.length, 1);
    });

    it("flags legacy #alias imports from src/systems/", () => {
      const file = makeFile(
        "src/systems/identity/internal/services/AuthService.js",
        `const container = await import("#container.js");\n`
      );
      const hits = checkRuleR16(file);
      assert.equal(hits.length, 1);
    });

    it("allows #shared and #system/tools imports inside src/systems/", () => {
      const file = makeFile(
        "src/systems/workspace/internal/services/ProjectService.js",
        `import { createLogger } from "#shared";\nimport { getWalletService } from "#billing/tools";\n`
      );
      const hits = checkRuleR16(file);
      assert.equal(hits.length, 0);
    });
  });

  describe("Rule R14: Cycle detector algorithm", () => {
    it("detects a synthetic 2-file circular dependency", () => {
      const syntheticFiles = [
        makeFile("src/modA.js", `import { b } from "./modB.js";\n`),
        makeFile("src/modB.js", `import { a } from "./modA.js";\n`),
      ];
      const cycles = findImportCycles(syntheticFiles, {});
      assert.equal(cycles.length, 1);
      assert.equal(cycles[0].length, 2);
    });

    it("does not flag acyclic dependencies", () => {
      const syntheticFiles = [
        makeFile("src/modA.js", `import { b } from "./modB.js";\n`),
        makeFile("src/modB.js", `export const b = 42;\n`),
      ];
      const cycles = findImportCycles(syntheticFiles, {});
      assert.equal(cycles.length, 0);
    });

    it("verifies the 3 Partie 00 circular pairs are resolved", () => {
      const { files } = collect();

      // Pair 1: nodeExecutor -> workflowRunner (must not exist)
      const nodeExec = files.find((f) => f.rel === "src/systems/generation/internal/v2/runner/nodeExecutor.js");
      assert.ok(nodeExec);
      assert.ok(!nodeExec.text.includes("workflowRunner.js"));

      // Pair 2: promptBuilderProService -> ElementService (must not exist)
      const promptBuilder = files.find((f) => f.rel === "src/systems/elements/internal/services/promptBuilderProService.js");
      assert.ok(promptBuilder);
      assert.ok(!promptBuilder.text.includes("elementService.js"));
      assert.ok(!promptBuilder.text.includes("ElementService.js"));

      // Pair 3: catalogPresentation -> models/index.js (must not exist)
      const catalogPres = files.find((f) => f.rel === "src/systems/models/internal/services/catalogPresentation.js");
      assert.ok(catalogPres);
      assert.ok(!catalogPres.text.includes("./index.js"));
    });
  });
});
